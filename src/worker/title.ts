import type { Env } from './types'
import { chatCompletion } from './llm'

export async function generateTitle(env: Env, userMessage: string, assistantResponse: string): Promise<string> {
  const result = await chatCompletion(env, [
    {
      role: 'system',
      content: 'Generate a short conversation title (3-6 words, no quotes, no period). Capture the specific topic, not a generic label.',
    },
    {
      role: 'user',
      content: `User said: ${userMessage.slice(0, 300)}\n\nAssistant replied: ${assistantResponse.slice(0, 300)}`,
    },
  ], { temperature: 0.3, max_tokens: 30 })

  return (result.content || 'New conversation').trim().replace(/^["']|["']$/g, '')
}
