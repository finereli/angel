import type { Env, ChatMessage, ToolDefinition, StreamChunk } from './types'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

export function getModel(env: Env): string {
  return env.DEEPSEEK_MODEL || 'deepseek/deepseek-v4-flash-0731'
}

export async function chatCompletion(
  env: Env,
  messages: ChatMessage[],
  opts: {
    tools?: ToolDefinition[]
    temperature?: number
    max_tokens?: number
  } = {}
): Promise<{ content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>; usage?: { prompt_tokens: number; completion_tokens: number } }> {
  const body: Record<string, unknown> = {
    model: getModel(env),
    messages,
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.max_tokens ?? 4096,
  }
  if (opts.tools?.length) {
    body.tools = opts.tools
    body.tool_choice = 'auto'
  }

  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
      'HTTP-Referer': 'https://angel.finereli.com',
      'X-Title': 'Angel',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`OpenRouter error ${res.status}: ${text}`)
  }

  const json = await res.json() as { choices: Array<{ message: { content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> } }>; usage?: { prompt_tokens: number; completion_tokens: number } }
  const choice = json.choices[0]
  return {
    content: choice.message.content,
    tool_calls: choice.message.tool_calls,
    usage: json.usage,
  }
}

export async function* chatCompletionStream(
  env: Env,
  messages: ChatMessage[],
  opts: {
    tools?: ToolDefinition[]
    temperature?: number
    max_tokens?: number
  } = {}
): AsyncGenerator<StreamChunk> {
  const body: Record<string, unknown> = {
    model: getModel(env),
    messages,
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.max_tokens ?? 4096,
    stream: true,
    stream_options: { include_usage: true },
  }
  if (opts.tools?.length) {
    body.tools = opts.tools
    body.tool_choice = 'auto'
  }

  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
      'HTTP-Referer': 'https://angel.finereli.com',
      'X-Title': 'Angel',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`OpenRouter error ${res.status}: ${text}`)
  }

  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop()!

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || !trimmed.startsWith('data: ')) continue
      const data = trimmed.slice(6)
      if (data === '[DONE]') return
      try {
        yield JSON.parse(data) as StreamChunk
      } catch {
        // skip malformed chunks
      }
    }
  }
}
