import type { Env, ChatMessage, ToolCall, AgentEvent } from './types'
import { chatCompletionStream } from './llm'
import { getToolDefinitions, executeTool } from './tools'
import { buildPreamble } from './preamble'
import { BOOTSTRAP_PROMPT } from './identity'

const MAX_TOOL_ROUNDS = 15

interface AgentContext {
  env: Env
  conversationId: string
}

export async function* runAgent(
  ctx: AgentContext,
  userMessage: string
): AsyncGenerator<AgentEvent> {
  const { env, conversationId } = ctx

  const systemPrompt = await buildSystemPrompt(env, conversationId)
  const history = await loadHistory(env, conversationId)
  const preamble = await buildPreamble(env, conversationId, userMessage)

  const userContent = preamble
    ? `${preamble}\n\n${userMessage}`
    : userMessage

  // DO already saved the raw user message to D1.
  // loadHistory includes it - slice it off and re-add with preamble.
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...history.slice(0, -1),
    { role: 'user', content: userContent },
  ]

  const tools = getToolDefinitions()
  let totalInput = 0
  let totalOutput = 0

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let assistantText = ''
    const toolCalls: ToolCall[] = []
    const toolCallArgs: Map<number, string> = new Map()

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
            toolCalls[tc.index] = {
              id: tc.id,
              type: 'function',
              function: { name: tc.function?.name || '', arguments: '' },
            }
          }
          if (tc.function?.name && toolCalls[tc.index]) {
            toolCalls[tc.index].function.name = tc.function.name
          }
          if (tc.function?.arguments) {
            const prev = toolCallArgs.get(tc.index) || ''
            toolCallArgs.set(tc.index, prev + tc.function.arguments)
          }
        }
      }

      if (chunk.usage) {
        totalInput += chunk.usage.prompt_tokens
        totalOutput += chunk.usage.completion_tokens
      }
    }

    for (const [index, args] of toolCallArgs) {
      if (toolCalls[index]) {
        toolCalls[index].function.arguments = args
      }
    }

    const validToolCalls = toolCalls.filter(Boolean)

    if (validToolCalls.length === 0) {
      await saveMessage(env, conversationId, 'assistant', assistantText, undefined, totalInput, totalOutput)
      yield { type: 'done', usage: { input: totalInput, output: totalOutput } }
      return
    }

    // Save assistant message with tool calls
    messages.push({
      role: 'assistant',
      content: assistantText || null,
      tool_calls: validToolCalls,
    })

    // Execute tools and add results
    for (const tc of validToolCalls) {
      let args: Record<string, unknown>
      try {
        args = JSON.parse(tc.function.arguments)
      } catch {
        args = {}
      }

      yield { type: 'tool_start', id: tc.id, name: tc.function.name, label: toolLabel(tc.function.name, args) }

      let result: string
      try {
        result = await executeTool(env, conversationId, tc.function.name, args)
      } catch (e) {
        result = `Error: ${e instanceof Error ? e.message : String(e)}`
      }

      yield { type: 'tool_result', id: tc.id, result }

      messages.push({
        role: 'tool',
        content: result,
        tool_call_id: tc.id,
      })
    }
  }

  // If we exhausted tool rounds
  yield { type: 'error', message: 'Reached maximum tool call rounds' }
  yield { type: 'done', usage: { input: totalInput, output: totalOutput } }
}

function toolLabel(name: string, args: Record<string, unknown>): string {
  const trunc = (s: unknown, max: number) => {
    const str = String(s || '')
    return str.length > max ? str.slice(0, max) + '…' : str
  }
  switch (name) {
    case 'record_observation': return `Noting: ${trunc(args.content, 60)}`
    case 'recall': return `Searching memory for "${trunc(args.query, 40)}"`
    case 'create_model': return `Creating model "${args.name}"`
    case 'update_model_description': return `Updating model "${args.name}"`
    case 'memory_load_model': return `Loading model "${args.name}"`
    case 'memory_stats': return 'Checking memory stats'
    case 'catchup': return 'Loading recent context'
    case 'glopus_models': return 'Browsing Glopus models'
    case 'glopus_load': return `Loading Glopus model "${args.name}"`
    case 'lists_catalog': return 'Checking lists'
    case 'list_create': return `Creating list "${args.name}"`
    case 'list_read': return `Reading list "${args.name}"`
    case 'list_add': return `Adding to "${args.name}"`
    case 'list_supersede': return 'Updating list item'
    case 'list_archive': return 'Archiving list item'
    default: return name
  }
}

async function buildSystemPrompt(env: Env, conversationId: string): Promise<string> {
  const parts: string[] = [BOOTSTRAP_PROMPT]

  // Load instructions list if it exists
  const instrList = await env.DB.prepare(
    `SELECT id FROM lists WHERE name = 'instructions'`
  ).first<{ id: string }>()
  if (instrList) {
    const items = await env.DB.prepare(
      `SELECT content FROM list_items WHERE list_id = ? AND superseded_by IS NULL AND archived = 0 ORDER BY COALESCE(ordinal, id)`
    ).bind(instrList.id).all<{ content: string }>()
    if (items.results.length > 0) {
      parts.push('# Instructions\n' + items.results.map(i => i.content).join('\n\n'))
    }
  }

  // Load self model portrait if it exists
  const self = await env.DB.prepare(
    `SELECT portrait FROM models WHERE name = 'self'`
  ).first<{ portrait: string | null }>()
  if (self?.portrait) {
    parts.push(`# Self\n${self.portrait}`)
  }

  // Load recent model portrait if it exists
  const recent = await env.DB.prepare(
    `SELECT portrait FROM models WHERE name = 'recent'`
  ).first<{ portrait: string | null }>()
  if (recent?.portrait) {
    parts.push(`# Recent context\n${recent.portrait}`)
  }

  return parts.join('\n\n')
}

async function loadHistory(env: Env, conversationId: string): Promise<ChatMessage[]> {
  const rows = await env.DB.prepare(
    `SELECT role, content, tool_calls, tool_call_id FROM messages
     WHERE conversation_id = ? ORDER BY id ASC LIMIT 200`
  ).bind(conversationId).all<{ role: string; content: string; tool_calls: string | null; tool_call_id: string | null }>()

  return rows.results.map(row => {
    const msg: ChatMessage = {
      role: row.role as ChatMessage['role'],
      content: row.content,
    }
    if (row.tool_calls) {
      try { msg.tool_calls = JSON.parse(row.tool_calls) } catch {}
    }
    if (row.tool_call_id) {
      msg.tool_call_id = row.tool_call_id
    }
    return msg
  })
}

async function saveMessage(
  env: Env,
  conversationId: string,
  role: string,
  content: string,
  toolCalls?: ToolCall[],
  usageInput?: number,
  usageOutput?: number
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO messages (conversation_id, role, content, tool_calls, usage_input, usage_output)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(
    conversationId,
    role,
    content,
    toolCalls ? JSON.stringify(toolCalls) : null,
    usageInput ?? null,
    usageOutput ?? null,
  ).run()

  await env.DB.prepare(
    `UPDATE conversations SET updated_at = datetime('now') WHERE id = ?`
  ).bind(conversationId).run()
}

// Headless agent run for cron jobs (no streaming)
export async function runHeadlessAgent(
  env: Env,
  conversationId: string,
  systemPromptOverride: string,
  userMessage: string
): Promise<string> {
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPromptOverride },
    { role: 'user', content: userMessage },
  ]

  const tools = getToolDefinitions()
  let fullResponse = ''

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let text = ''
    const toolCalls: ToolCall[] = []
    const toolCallArgs: Map<number, string> = new Map()

    for await (const chunk of chatCompletionStream(env, messages, { tools })) {
      const choice = chunk.choices[0]
      if (!choice) continue
      if (choice.delta.content) text += choice.delta.content
      if (choice.delta.tool_calls) {
        for (const tc of choice.delta.tool_calls) {
          if (tc.id) {
            toolCalls[tc.index] = {
              id: tc.id,
              type: 'function',
              function: { name: tc.function?.name || '', arguments: '' },
            }
          }
          if (tc.function?.name && toolCalls[tc.index]) {
            toolCalls[tc.index].function.name = tc.function.name
          }
          if (tc.function?.arguments) {
            const prev = toolCallArgs.get(tc.index) || ''
            toolCallArgs.set(tc.index, prev + tc.function.arguments)
          }
        }
      }
    }

    for (const [index, args] of toolCallArgs) {
      if (toolCalls[index]) toolCalls[index].function.arguments = args
    }

    const valid = toolCalls.filter(Boolean)
    fullResponse += text

    if (valid.length === 0) break

    messages.push({ role: 'assistant', content: text || null, tool_calls: valid })

    for (const tc of valid) {
      let args: Record<string, unknown>
      try { args = JSON.parse(tc.function.arguments) } catch { args = {} }
      let result: string
      try {
        result = await executeTool(env, conversationId, tc.function.name, args)
      } catch (e) {
        result = `Error: ${e instanceof Error ? e.message : String(e)}`
      }
      messages.push({ role: 'tool', content: result, tool_call_id: tc.id })
    }
  }

  await saveMessage(env, conversationId, 'assistant', fullResponse)
  return fullResponse
}
