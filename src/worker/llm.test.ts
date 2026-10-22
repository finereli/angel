import { describe, it, expect } from 'vitest'
import { describeHttpError, friendlyError, LlmError } from './llm'
import { resolveModel, DEFAULT_MODEL, MODEL_CATALOG } from './models'

// The 429 a user actually hit: OpenRouter wrapping a provider's shared-pool limit.
const RATE_LIMIT = JSON.stringify({
  error: {
    message: 'Provider returned error', code: 429,
    metadata: { raw: 'qwen/qwen3.8-flash is temporarily rate-limited upstream. Please retry shortly', provider_name: 'Alibaba', is_byok: false },
  },
  user_id: 'user_x',
})

describe('model errors in plain language', () => {
  it('turns the provider rate limit into something a person can act on', () => {
    const e = describeHttpError(429, RATE_LIMIT, 'qwen/qwen3.8-flash', '3')
    expect(e.message).toBe('Alibaba is rate-limiting Qwen3.8 Flash right now. Try again in a moment, or pick another model in Settings.')
    expect(e.message).not.toMatch(/user_|openrouter\.ai|metadata|\{/)
    expect(e.retryable).toBe(true)
    expect(e.retryAfterMs).toBe(3000)
    expect(e.detail).toContain('429') // the raw text is kept for the log
  })

  it('does not retry what retrying cannot fix', () => {
    expect(describeHttpError(402, '{}', DEFAULT_MODEL).retryable).toBe(false)
    expect(describeHttpError(401, '{}', DEFAULT_MODEL).retryable).toBe(false)
    expect(describeHttpError(402, '{}', DEFAULT_MODEL).message).toMatch(/credit/)
    expect(describeHttpError(503, 'upstream down', DEFAULT_MODEL).retryable).toBe(true)
  })

  it('handles bodies that are not JSON and errors that are not LlmErrors', () => {
    expect(describeHttpError(502, '<html>bad gateway</html>', DEFAULT_MODEL).message).toMatch(/The provider had a problem/)
    expect(friendlyError(new LlmError('already friendly', false))).toBe('already friendly')
    const abort = new Error('aborted'); abort.name = 'AbortError'
    expect(friendlyError(abort, 'anthropic/claude-haiku-5.5')).toMatch(/Claude Haiku 5.5 took too long/)
    expect(friendlyError(new Error('stream ended prematurely (no [DONE])'))).toMatch(/cut off/)
  })
})

describe('model choice', () => {
  it('falls back to the default for nothing or for a model that has left the list', () => {
    expect(resolveModel(null)).toBe(DEFAULT_MODEL)
    expect(resolveModel('deepseek/deepseek-v4-flash-0731')).toBe(DEFAULT_MODEL)
    expect(resolveModel('qwen/qwen3.8-flash')).toBe('qwen/qwen3.8-flash')
  })

  it('offers exactly the hand-picked six', () => {
    expect(MODEL_CATALOG.map(m => m.id)).toEqual([
      'deepseek/deepseek-v4.1-flash-1017', 'qwen/qwen3.8-flash', 'anthropic/claude-haiku-5.5',
      'google/gemini-3.8-flash', 'z-ai/glm-5.3-flash', 'openai/gpt-6-luna',
    ])
  })
})
