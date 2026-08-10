import type { Env } from './types'
import { chatCompletion } from './llm'

// Name a conversation from its first exchange alone - no other context. If it's
// the first conversation of the day and reads like a plain greeting, the model
// may return the DATE sentinel and we label it with today's date instead.
export async function nameConversation(
  env: Env,
  userMessage: string,
  assistantResponse: string,
  opts: { allowDate: boolean; dateLabel: string },
): Promise<string> {
  const dateRule = opts.allowDate
    ? '\n\nIf this opening is just a greeting or daily check-in with no specific topic, reply with exactly: DATE'
    : ''
  const result = await chatCompletion(env, [
    {
      role: 'system',
      content: `Generate a short conversation title (3 to 6 words, no quotes, no period). Capture the specific topic, not a generic label.${dateRule}`,
    },
    {
      role: 'user',
      content: `User said: ${userMessage.slice(0, 500)}\n\nAssistant replied: ${assistantResponse.slice(0, 500)}`,
    },
  ], { temperature: 0.3, max_tokens: 20 })

  const raw = (result.content || '').trim()
  if (opts.allowDate && /^DATE\b/i.test(raw)) return opts.dateLabel
  return raw.replace(/^["']|["']$/g, '').replace(/[.]+$/, '').trim()
}
