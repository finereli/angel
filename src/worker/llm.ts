import type { Env, ChatMessage, ToolDefinition, StreamChunk } from './types'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

const STALL_MS = 30_000     // abort if no data for this long
const OVERALL_MS = 180_000  // abort if the whole call runs past this
const NONSTREAM_MS = 120_000

export function getModel(env: Env): string {
  return env.DEEPSEEK_MODEL || 'deepseek/deepseek-v4-flash-0731'
}

const headers = (env: Env) => ({
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
  'HTTP-Referer': 'https://angel.finereli.com',
  'X-Title': 'Angel',
})

export async function chatCompletion(
  env: Env,
  messages: ChatMessage[],
  opts: { tools?: ToolDefinition[]; temperature?: number; max_tokens?: number } = {}
): Promise<{ content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>; usage?: { prompt_tokens: number; completion_tokens: number } }> {
  const body: Record<string, unknown> = {
    model: getModel(env),
    messages,
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.max_tokens ?? 4096,
  }
  if (opts.tools?.length) { body.tools = opts.tools; body.tool_choice = 'auto' }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), NONSTREAM_MS)
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST', headers: headers(env), body: JSON.stringify(body), signal: controller.signal,
    })
    if (!res.ok) throw new Error(`OpenRouter error ${res.status}: ${await res.text()}`)
    const json = await res.json() as { choices: Array<{ message: { content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> } }>; usage?: { prompt_tokens: number; completion_tokens: number } }
    const choice = json.choices[0]
    return { content: choice?.message.content ?? null, tool_calls: choice?.message.tool_calls, usage: json.usage }
  } finally {
    clearTimeout(timer)
  }
}

// Yields chunks. Throws on HTTP error, mid-stream error payload, stall/overall
// timeout, OR a premature end (reader EOF without a [DONE] sentinel or a
// finish_reason). A clean finish is the ONLY way this returns without throwing.
export async function* chatCompletionStream(
  env: Env,
  messages: ChatMessage[],
  opts: { tools?: ToolDefinition[]; temperature?: number; max_tokens?: number } = {}
): AsyncGenerator<StreamChunk> {
  const body: Record<string, unknown> = {
    model: getModel(env),
    messages,
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.max_tokens ?? 4096,
    stream: true,
    stream_options: { include_usage: true },
  }
  if (opts.tools?.length) { body.tools = opts.tools; body.tool_choice = 'auto' }

  const controller = new AbortController()
  let stallTimer: ReturnType<typeof setTimeout> | undefined
  const overallTimer = setTimeout(() => controller.abort(), OVERALL_MS)
  const armStall = () => { clearTimeout(stallTimer); stallTimer = setTimeout(() => controller.abort(), STALL_MS) }

  try {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST', headers: headers(env), body: JSON.stringify(body), signal: controller.signal,
    })
    if (!res.ok) throw new Error(`OpenRouter error ${res.status}: ${await res.text()}`)

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let cleanEnd = false
    armStall()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      armStall()
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop()!
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith('data: ')) continue
        const data = trimmed.slice(6)
        if (data === '[DONE]') { cleanEnd = true; return }
        let parsed: any
        try { parsed = JSON.parse(data) } catch { continue }
        if (parsed?.error) throw new Error(`OpenRouter stream error: ${parsed.error.message || JSON.stringify(parsed.error)}`)
        if (parsed?.choices?.[0]?.finish_reason) cleanEnd = true
        yield parsed as StreamChunk
      }
    }

    if (!cleanEnd) throw new Error('stream ended prematurely (no [DONE] or finish_reason)')
  } finally {
    clearTimeout(overallTimer)
    clearTimeout(stallTimer)
    // If the consumer broke early (e.g. Stop), abort the fetch so the upstream
    // connection doesn't leak.
    controller.abort()
  }
}
