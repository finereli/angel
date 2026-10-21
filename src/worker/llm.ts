import type { Env, ChatMessage, ToolDefinition, StreamChunk } from './types'
import { resolveModel, modelLabel } from './models'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

const STALL_MS = 30_000     // abort if no data for this long
const OVERALL_MS = 180_000  // abort if the whole call runs past this
const NONSTREAM_MS = 120_000

export function getModel(agentModel?: string | null): string {
  return resolveModel(agentModel)
}

// A failed model call, with what a person needs to know about it. `message` is
// written for the chat window; the raw provider text stays in `detail` for logs.
export class LlmError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly detail: string = message,
    readonly retryAfterMs?: number,
  ) { super(message) }
}

// OpenRouter wraps provider failures as { error: { message, code, metadata: { raw, provider_name } } }.
export function describeHttpError(status: number, body: string, model: string, retryAfter?: string | null): LlmError {
  let msg = ''
  let provider = ''
  try {
    const e = JSON.parse(body)?.error
    msg = String(e?.message ?? '')
    provider = String(e?.metadata?.provider_name ?? '')
  } catch { /* not JSON */ }
  const who = provider || 'The provider'
  const label = modelLabel(model)
  const seconds = Number(retryAfter)
  const retryAfterMs = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 30) * 1000 : undefined
  const detail = `OpenRouter ${status}: ${body.slice(0, 500)}`
  if (status === 429) return new LlmError(`${who} is rate-limiting ${label} right now. Try again in a moment, or pick another model in Settings.`, true, detail, retryAfterMs)
  if (status === 402) return new LlmError('The OpenRouter account is out of credit, so the model can\'t answer until it is topped up.', false, detail)
  if (status === 401 || status === 403) return new LlmError('OpenRouter rejected the API key, so the model can\'t answer.', false, detail)
  if (status === 404) return new LlmError(`${label} isn't available on OpenRouter right now. Pick another model in Settings.`, false, detail)
  if (status === 400 || status === 422) return new LlmError(`${label} refused the request${msg ? `: ${msg.slice(0, 160)}` : ''}. Try again, or pick another model in Settings.`, false, detail)
  if (status === 408 || status >= 500) return new LlmError(`${who} had a problem answering (HTTP ${status}). Try again in a moment, or pick another model in Settings.`, true, detail, retryAfterMs)
  return new LlmError(`The model call failed (HTTP ${status}). Try again.`, false, detail)
}

// What a person sees for anything that went wrong calling the model.
export function friendlyError(e: unknown, model?: string): string {
  if (e instanceof LlmError) return e.message
  const raw = e instanceof Error ? e.message : String(e)
  if (e instanceof Error && e.name === 'AbortError') return `${model ? modelLabel(model) : 'The model'} took too long and stopped responding. Try again, or pick another model in Settings.`
  if (/stream ended prematurely/i.test(raw)) return `${model ? modelLabel(model) : 'The model'} cut off mid-answer. Try again.`
  return `Something went wrong: ${raw.slice(0, 200)}`
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
  opts: { tools?: ToolDefinition[]; temperature?: number; max_tokens?: number; model?: string; reasoningEffort?: string | null } = {}
): Promise<{ content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>; usage?: { prompt_tokens: number; completion_tokens: number } }> {
  const model = opts.model || getModel()
  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: opts.temperature ?? 0.7,
  }
  if (opts.max_tokens) body.max_tokens = opts.max_tokens
  if (opts.tools?.length) { body.tools = opts.tools; body.tool_choice = 'auto' }
  if (opts.reasoningEffort) body.reasoning = { effort: opts.reasoningEffort }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), NONSTREAM_MS)
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST', headers: headers(env), body: JSON.stringify(body), signal: controller.signal,
    })
    if (!res.ok) throw describeHttpError(res.status, await res.text(), model, res.headers.get('Retry-After'))
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
  opts: { tools?: ToolDefinition[]; temperature?: number; max_tokens?: number; model?: string; reasoningEffort?: string | null } = {}
): AsyncGenerator<StreamChunk> {
  const model = opts.model || getModel()
  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: opts.temperature ?? 0.7,
    stream: true,
    stream_options: { include_usage: true },
  }
  if (opts.max_tokens) body.max_tokens = opts.max_tokens
  if (opts.tools?.length) { body.tools = opts.tools; body.tool_choice = 'auto' }
  if (opts.reasoningEffort) body.reasoning = { effort: opts.reasoningEffort }

  const controller = new AbortController()
  let stallTimer: ReturnType<typeof setTimeout> | undefined
  const overallTimer = setTimeout(() => controller.abort(), OVERALL_MS)
  const armStall = () => { clearTimeout(stallTimer); stallTimer = setTimeout(() => controller.abort(), STALL_MS) }

  try {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST', headers: headers(env), body: JSON.stringify(body), signal: controller.signal,
    })
    if (!res.ok) throw describeHttpError(res.status, await res.text(), model, res.headers.get('Retry-After'))

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
        if (parsed?.error) throw describeHttpError(Number(parsed.error.code) || 502, JSON.stringify({ error: parsed.error }), model)
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
