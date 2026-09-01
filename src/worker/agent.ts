import type { Env, ChatMessage, ToolCall, AgentEvent, ServerMsg, StreamSummaryRow } from './types'
import { chatCompletionStream, getModel } from './llm'
import { getToolDefinitions, executeTool, toolDoneLabel, TOOL_LABELS, type ToolContext } from './tools/registry'
import { buildOperatingNotes } from './identity'
import { buildListsPreamble, buildPerMessageReminder } from './lists'
import { getSystemDoc, DEFAULT_SYSTEM_DOC } from './system-doc'
import { renderStreamContext, type Pair } from './stream-pyramid'
import { DsmlStreamFilter, parseDsml } from './dsml'

const MAX_TOOL_ROUNDS = 200

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

function isDeepSeek(env: Env, agentModel?: string | null): boolean {
  return getModel(env, agentModel).toLowerCase().includes('deepseek')
}


interface AgentContext {
  env: Env
  conversationId: string
  agentId: string
  agentName: string
  agentModel?: string | null
  broadcast?: (msg: ServerMsg) => void
}

// Accumulates tool-call deltas across stream chunks. push() returns a call the
// first time its id and name are both known (the moment it can be announced);
// append() takes calls recovered outside the delta stream (DSML); finalize()
// attaches the buffered arguments and keeps every named call - unparseable
// arguments are reported to the model at execution time, not silently dropped.
class ToolCallAccumulator {
  private calls: Array<ToolCall | undefined> = []
  private argsBuf = new Map<number, string>()
  private announced = new Set<string>()

  push(tc: { index: number; id?: string; function?: { name?: string; arguments?: string } }): ToolCall | null {
    if (tc.id) this.calls[tc.index] = { id: tc.id, type: 'function', function: { name: tc.function?.name || '', arguments: '' } }
    const existing = this.calls[tc.index]
    if (tc.function?.name && existing) existing.function.name = tc.function.name
    if (tc.function?.arguments) this.argsBuf.set(tc.index, (this.argsBuf.get(tc.index) || '') + tc.function.arguments)
    const call = this.calls[tc.index]
    if (call && call.id && call.function.name && !this.announced.has(call.id)) {
      this.announced.add(call.id)
      return call
    }
    return null
  }

  append(call: ToolCall): void {
    this.calls.push(call)
  }

  wasAnnounced(id: string): boolean { return this.announced.has(id) }

  reset(): void {
    this.calls = []
    this.argsBuf.clear()
    this.announced.clear()
  }

  finalize(): ToolCall[] {
    for (const [index, args] of this.argsBuf) {
      const call = this.calls[index]
      if (call) call.function.arguments = args
    }
    return this.calls.filter((c): c is ToolCall => !!c && !!c.function.name)
  }
}

function parseToolArgs(tc: ToolCall): Record<string, unknown> {
  try { return JSON.parse(tc.function.arguments || '{}') } catch { return {} }
}

async function buildSystemPrompt(env: Env, agentId: string, agentName: string): Promise<string> {
  const parts = [buildOperatingNotes(agentName)]
  const doc = (await getSystemDoc(env, agentId)) || DEFAULT_SYSTEM_DOC
  if (doc) parts.push(`# Your system\n${doc}`)
  const lists = await buildListsPreamble(env, agentId)
  if (lists) parts.push(lists)
  return parts.join('\n\n')
}

const dateLine = (ts: string | null): string => (ts ? ts.slice(0, 10) : '')

// The stream pyramid spliced as prior turns - Angel's own memory, first person.
function recapTurns(tiles: StreamSummaryRow[]): ChatMessage[] {
  if (tiles.length === 0) return []
  const recap = tiles.map(t => t.text).join('\n\n')
  return [
    { role: 'user', content: `(picking up where we left off - my memory of earlier)\n\n${recap}` },
    { role: 'assistant', content: "Right - that's where we've been." },
  ]
}

// Verbatim tail as real prior turns, each marked with date + thread topic.
// Skip unanswered pairs (an in-flight message from another thread, or a turn that
// errored before saving a reply) so they can't appear as history to answer.
function verbatimTurns(pairs: Pair[]): ChatMessage[] {
  const msgs: ChatMessage[] = []
  for (const p of pairs) {
    if (!p.assistantContent) continue
    const marker = `[${dateLine(p.userTs)}]`
    msgs.push({ role: 'user', content: `${marker} ${p.userContent}` })
    msgs.push({ role: 'assistant', content: p.assistantContent })
  }
  return msgs
}

// ---- Response pass (hot path, streaming) ----
export async function* runAgent(ctx: AgentContext, userMessage: string): AsyncGenerator<AgentEvent> {
  const { env, conversationId, agentId, agentName, agentModel } = ctx
  const modelId = getModel(env, agentModel)

  let system = await buildSystemPrompt(env, agentId, agentName)
  const { tiles, verbatim, total } = await renderStreamContext(env, agentId, conversationId)
  // The current message is already saved; drop it from the verbatim tail and append it live.
  const history = verbatim.filter(p => p.idx !== total - 1)

  const marker = `[${dateLine(new Date().toISOString())}]`
  const reminder = await buildPerMessageReminder(env, agentId)

  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    ...recapTurns(tiles),
    ...verbatimTurns(history),
    { role: 'user', content: `${marker} ${userMessage}${reminder ? '\n\n' + reminder : ''}` },
  ]

  const tools = getToolDefinitions()
  let totalInput = 0
  let totalOutput = 0
  let fullText = '' // all committed rounds' text; this is the saved reply

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let assistantText = ''
    const acc = new ToolCallAccumulator()
    let sawAnyToolCall = false
    let truncated = false
    let finishReason: string | null = null
    const dsmlFilter = isDeepSeek(env, agentModel) ? new DsmlStreamFilter() : null
    // A dropped stream throws (see llm.ts). Retry the round from scratch,
    // telling the client to discard the truncated partial first. The provider's
    // bad moments last seconds, so back off between tries (and give it more tries)
    // rather than burning them all back-to-back into the same rough window. The
    // reset the client receives on each retry is its cue that Angel is still going.
    const STREAM_ATTEMPTS = 6
    for (let attempt = 0; attempt < STREAM_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        yield { type: 'reset' }
        assistantText = ''
        acc.reset()
        sawAnyToolCall = false
        finishReason = null
        await sleep(Math.min(600 * 2 ** (attempt - 1), 5000)) // 0.6s, 1.2s, 2.4s, 4.8s, 5s
      }
      try {
        for await (const chunk of chatCompletionStream(env, messages, { tools, model: modelId })) {
          const choice = chunk.choices[0]
          if (!choice) continue
          if (choice.finish_reason) finishReason = choice.finish_reason
          if (choice.delta.content) {
            assistantText += choice.delta.content
            if (dsmlFilter) {
              const safe = dsmlFilter.feed(choice.delta.content)
              if (safe) yield { type: 'text', content: safe }
            } else {
              yield { type: 'text', content: choice.delta.content }
            }
          }
          if (choice.delta.tool_calls) {
            sawAnyToolCall = true
            for (const tc of choice.delta.tool_calls) {
              // Announce as soon as we know the tool's id + name, so the client can
              // show "Recording observation…" while the arguments are still generating.
              const call = acc.push(tc)
              if (call) {
                yield { type: 'tool_start', id: call.id, name: call.function.name, label: TOOL_LABELS[call.function.name]?.[0] || call.function.name }
              }
            }
          }
          if (chunk.usage) { totalInput += chunk.usage.prompt_tokens; totalOutput += chunk.usage.completion_tokens }
        }
        truncated = false
        break // clean finish
      } catch (e) {
        console.error(`[runAgent] stream attempt ${attempt + 1}/${STREAM_ATTEMPTS} failed:`, e instanceof Error ? e.message : e)
        truncated = true
        if (attempt === STREAM_ATTEMPTS - 1) {
          if (assistantText.length > 0 || sawAnyToolCall) break // keep best effort
          throw e
        }
      }
    }

    // Finish the DSML stream filter: flush any held-back text that wasn't DSML,
    // and recover tool calls from DSML markup the model emitted as plain text.
    if (dsmlFilter) {
      const { flush, toolCalls: dsmlCalls } = dsmlFilter.finish()
      if (flush) yield { type: 'text', content: flush }
      if (dsmlFilter.detected) {
        const parsed = parseDsml(assistantText)
        if (parsed) {
          assistantText = parsed.cleanText
          console.error(`[runAgent] recovered ${parsed.toolCalls.length} tool call(s) from DeepSeek DSML text`)
        }
        // Merge DSML-recovered calls into the structured ones
        for (const tc of dsmlCalls) acc.append(tc)
      }
    }

    const calls = acc.finalize()

    if (calls.length === 0) {
      if (truncated && (fullText + assistantText).trim()) yield { type: 'text', content: ' …[cut off]' }
      else if (!(fullText + assistantText).trim()) yield { type: 'text', content: '*(the response was cut off before anything came through)*' }
      yield { type: 'done', usage: { input: totalInput, output: totalOutput }, finishReason }
      return
    }

    // Commit this round's text before running tools; a later reset can't roll past it.
    fullText += assistantText
    yield { type: 'commit' }
    messages.push({ role: 'assistant', content: assistantText || null, tool_calls: calls })
    for (const tc of calls) {
      // Usually already announced mid-stream; announce here only if it wasn't.
      if (!acc.wasAnnounced(tc.id)) {
        yield { type: 'tool_start', id: tc.id, name: tc.function.name, label: TOOL_LABELS[tc.function.name]?.[0] || tc.function.name }
      }
      let result: string
      let doneLabel = TOOL_LABELS[tc.function.name]?.[1] || tc.function.name
      if (!isParseableArgs(tc.function.arguments)) {
        console.error(`[runAgent] truncated tool call ${tc.function.name} (finish_reason=${finishReason})`)
        result = 'Error: this tool call was cut off before its arguments finished streaming'
          + (finishReason === 'length' ? ' (output token limit reached)' : '')
          + '. Make the call again.'
      } else {
        const toolCtx: ToolContext = { env, conversationId, agentId, broadcast: ctx.broadcast }
        const args = parseToolArgs(tc)
        doneLabel = toolDoneLabel(tc.function.name, args)
        try { result = await executeTool(toolCtx, tc.function.name, args) }
        catch (e) { result = `Error: ${e instanceof Error ? e.message : String(e)}` }
      }
      yield { type: 'tool_result', id: tc.id, result, label: doneLabel }
      messages.push({ role: 'tool', content: result, tool_call_id: tc.id })
    }
  }

  yield { type: 'error', message: 'Reached maximum tool call rounds' }
  yield { type: 'done', usage: { input: totalInput, output: totalOutput }, finishReason: 'max_rounds' }
}

function isParseableArgs(s: string): boolean {
  const t = (s || '').trim()
  if (t === '') return true
  try { JSON.parse(t); return true } catch { return false }
}

export async function runMemoryPass(ctx: AgentContext): Promise<void> {
  const { env, conversationId, agentId, agentName, agentModel } = ctx
  const modelId = getModel(env, agentModel)

  const system = await buildSystemPrompt(env, agentId, agentName)
  const { tiles, verbatim } = await renderStreamContext(env, agentId, conversationId)
  const reminder = await buildPerMessageReminder(env, agentId)
  const memoryPrompt = "(memory) Instead of replying, look back at the latest exchange. If anything there is worth remembering, record it with record_observation - in your own voice, tagged, following your memory-instructions. If nothing is, do nothing. Do not address Eli here."
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    ...recapTurns(tiles),
    ...verbatimTurns(verbatim),
    {
      role: 'user',
      content: `${memoryPrompt}${reminder ? '\n\n' + reminder : ''}`,
    },
  ]

  const tools = getToolDefinitions()
  for (let round = 0; round < 4; round++) {
    let text = ''
    const acc = new ToolCallAccumulator()

    try {
      for await (const chunk of chatCompletionStream(env, messages, { tools, model: modelId })) {
        const choice = chunk.choices[0]
        if (!choice) continue
        if (choice.delta.content) text += choice.delta.content
        if (choice.delta.tool_calls) {
          for (const tc of choice.delta.tool_calls) acc.push(tc)
        }
      }
    } catch (e) {
      console.error('[runMemoryPass] stream failed:', e instanceof Error ? e.message : e)
    }
    if (isDeepSeek(env, agentModel)) {
      const parsed = parseDsml(text)
      if (parsed) {
        text = parsed.cleanText
        for (const tc of parsed.toolCalls) acc.append(tc)
        console.error(`[runMemoryPass] recovered ${parsed.toolCalls.length} tool call(s) from DeepSeek DSML text`)
      }
    }
    // Best-effort pass: run only well-formed calls, drop the rest.
    const valid = acc.finalize().filter(tc => isParseableArgs(tc.function.arguments))
    if (valid.length === 0) return

    messages.push({ role: 'assistant', content: text || null, tool_calls: valid })
    for (const tc of valid) {
      const toolCtx: ToolContext = { env, conversationId, agentId }
      let result: string
      try { result = await executeTool(toolCtx, tc.function.name, parseToolArgs(tc)) }
      catch (e) { result = `Error: ${e instanceof Error ? e.message : String(e)}` }
      messages.push({ role: 'tool', content: result, tool_call_id: tc.id })
    }
  }
}

