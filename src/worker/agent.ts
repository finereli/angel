import type { Env, ChatMessage, ToolCall, AgentEvent, StreamSummaryRow } from './types'
import { chatCompletionStream } from './llm'
import { getToolDefinitions, executeTool } from './tools'
import { OPERATING_NOTES } from './identity'
import { buildListsPreamble } from './lists'
import { getSystemDoc, DEFAULT_SYSTEM_DOC } from './system-doc'
import { renderStreamContext, type Pair } from './stream-pyramid'

const MAX_TOOL_ROUNDS = 12

interface AgentContext {
  env: Env
  conversationId: string
}

// ---- Shared context assembly ----
async function buildSystemPrompt(env: Env): Promise<string> {
  const parts = [OPERATING_NOTES]
  const doc = (await getSystemDoc(env)) || DEFAULT_SYSTEM_DOC
  if (doc) parts.push(`# Your system\n${doc}`)
  const lists = await buildListsPreamble(env) // instructions + memory-instructions (load_mode = always)
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
function verbatimTurns(pairs: Pair[]): ChatMessage[] {
  const msgs: ChatMessage[] = []
  for (const p of pairs) {
    const marker = `[${dateLine(p.userTs)}${p.topic ? ` · ${p.topic}` : ''}]`
    msgs.push({ role: 'user', content: `${marker} ${p.userContent}` })
    if (p.assistantContent) msgs.push({ role: 'assistant', content: p.assistantContent })
  }
  return msgs
}

// ---- Response pass (hot path, streaming) ----
export async function* runAgent(ctx: AgentContext, userMessage: string): AsyncGenerator<AgentEvent> {
  const { env, conversationId } = ctx

  const system = await buildSystemPrompt(env)
  const { tiles, verbatim, total } = await renderStreamContext(env)
  // The current message is already saved; drop it from the verbatim tail and append it live.
  const history = verbatim.filter(p => p.idx !== total - 1)

  const conv = await env.DB.prepare(
    `SELECT topic, (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) AS c
     FROM conversations c WHERE id = ?`
  ).bind(conversationId).first<{ topic: string | null; c: number }>()
  const topic = conv?.topic || null
  const isNewThread = (conv?.c ?? 0) <= 1
  const marker = `[${dateLine(new Date().toISOString())}${topic ? ` · ${topic}` : ''}]`
  const freshNote = isNewThread
    ? " (Eli just opened a fresh thread - you have the whole history, but don't drag the last topic in unless it's relevant.)"
    : ''

  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    ...recapTurns(tiles),
    ...verbatimTurns(history),
    { role: 'user', content: `${marker} ${userMessage}${freshNote}` },
  ]

  const tools = getToolDefinitions()
  let totalInput = 0
  let totalOutput = 0

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let assistantText = ''
    const toolCalls: ToolCall[] = []
    const toolCallArgs = new Map<number, string>()

    for await (const chunk of chatCompletionStream(env, messages, { tools })) {
      const choice = chunk.choices[0]
      if (!choice) continue
      if (choice.delta.content) {
        assistantText += choice.delta.content
        yield { type: 'text', content: choice.delta.content }
      }
      if (choice.delta.tool_calls) {
        for (const tc of choice.delta.tool_calls) {
          if (tc.id) {
            toolCalls[tc.index] = { id: tc.id, type: 'function', function: { name: tc.function?.name || '', arguments: '' } }
          }
          if (tc.function?.name && toolCalls[tc.index]) toolCalls[tc.index].function.name = tc.function.name
          if (tc.function?.arguments) toolCallArgs.set(tc.index, (toolCallArgs.get(tc.index) || '') + tc.function.arguments)
        }
      }
      if (chunk.usage) { totalInput += chunk.usage.prompt_tokens; totalOutput += chunk.usage.completion_tokens }
    }

    for (const [index, args] of toolCallArgs) if (toolCalls[index]) toolCalls[index].function.arguments = args
    const valid = toolCalls.filter(Boolean)

    if (valid.length === 0) {
      await saveMessage(env, conversationId, 'assistant', assistantText, undefined, totalInput, totalOutput)
      yield { type: 'done', usage: { input: totalInput, output: totalOutput } }
      return
    }

    messages.push({ role: 'assistant', content: assistantText || null, tool_calls: valid })
    for (const tc of valid) {
      let args: Record<string, unknown>
      try { args = JSON.parse(tc.function.arguments) } catch { args = {} }
      yield { type: 'tool_start', id: tc.id, name: tc.function.name, label: toolLabel(tc.function.name, args) }
      let result: string
      try { result = await executeTool(env, conversationId, tc.function.name, args) }
      catch (e) { result = `Error: ${e instanceof Error ? e.message : String(e)}` }
      yield { type: 'tool_result', id: tc.id, result }
      messages.push({ role: 'tool', content: result, tool_call_id: tc.id })
    }
  }

  yield { type: 'error', message: 'Reached maximum tool call rounds' }
  yield { type: 'done', usage: { input: totalInput, output: totalOutput } }
}

// ---- Memory pass (off hot path): the same Angel, full context, deciding what to keep ----
export async function runMemoryPass(env: Env, conversationId: string): Promise<void> {
  const system = await buildSystemPrompt(env)
  const { tiles, verbatim } = await renderStreamContext(env) // includes the just-finished exchange
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    ...recapTurns(tiles),
    ...verbatimTurns(verbatim),
    {
      role: 'user',
      content: "(memory) Instead of replying, look back at the latest exchange. If anything there is worth remembering, record it with record_observation - in your own voice, tagged, following your memory-instructions. If nothing is, do nothing. Do not address Eli here.",
    },
  ]

  const tools = getToolDefinitions()
  for (let round = 0; round < 4; round++) {
    let text = ''
    const toolCalls: ToolCall[] = []
    const toolCallArgs = new Map<number, string>()

    for await (const chunk of chatCompletionStream(env, messages, { tools })) {
      const choice = chunk.choices[0]
      if (!choice) continue
      if (choice.delta.content) text += choice.delta.content
      if (choice.delta.tool_calls) {
        for (const tc of choice.delta.tool_calls) {
          if (tc.id) toolCalls[tc.index] = { id: tc.id, type: 'function', function: { name: tc.function?.name || '', arguments: '' } }
          if (tc.function?.name && toolCalls[tc.index]) toolCalls[tc.index].function.name = tc.function.name
          if (tc.function?.arguments) toolCallArgs.set(tc.index, (toolCallArgs.get(tc.index) || '') + tc.function.arguments)
        }
      }
    }
    for (const [index, args] of toolCallArgs) if (toolCalls[index]) toolCalls[index].function.arguments = args
    const valid = toolCalls.filter(Boolean)
    if (valid.length === 0) return

    messages.push({ role: 'assistant', content: text || null, tool_calls: valid })
    for (const tc of valid) {
      let args: Record<string, unknown>
      try { args = JSON.parse(tc.function.arguments) } catch { args = {} }
      let result: string
      try { result = await executeTool(env, conversationId, tc.function.name, args) }
      catch (e) { result = `Error: ${e instanceof Error ? e.message : String(e)}` }
      messages.push({ role: 'tool', content: result, tool_call_id: tc.id })
    }
  }
}

function toolLabel(name: string, args: Record<string, unknown>): string {
  const trunc = (s: unknown, max: number) => { const str = String(s || ''); return str.length > max ? str.slice(0, max) + '…' : str }
  switch (name) {
    case 'record_observation': return `Noting: ${trunc(args.content, 60)}`
    case 'recall': return `Recalling "${trunc(args.query, 40)}"`
    case 'create_tag': return `New tag "${args.name}"`
    case 'update_tag_description': return `Updating tag "${args.name}"`
    case 'list_tags': return 'Reviewing tags'
    case 'memory_stats': return 'Checking memory'
    case 'lists_catalog': return 'Checking lists'
    case 'list_create': return `Creating list "${args.name}"`
    case 'list_read': return `Reading "${args.name}"`
    case 'list_add': return `Adding to "${args.name}"`
    case 'list_supersede': return 'Updating a list item'
    case 'list_archive': return 'Archiving a list item'
    default: return name
  }
}

async function saveMessage(
  env: Env, conversationId: string, role: string, content: string,
  toolCalls?: ToolCall[], usageInput?: number, usageOutput?: number
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO messages (conversation_id, role, content, tool_calls, usage_input, usage_output)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(conversationId, role, content, toolCalls ? JSON.stringify(toolCalls) : null, usageInput ?? null, usageOutput ?? null).run()
  await env.DB.prepare(`UPDATE conversations SET updated_at = datetime('now') WHERE id = ?`).bind(conversationId).run()
}
