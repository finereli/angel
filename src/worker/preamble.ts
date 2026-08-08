import type { Env } from './types'
import { routeMessage, formatRoutedMemory } from './router'
import { recall } from './memory'
import { buildListsPreamble, buildPerMessageReminder } from './lists'

export async function buildPreamble(
  env: Env,
  conversationId: string,
  userMessage: string
): Promise<string> {
  const parts: string[] = []

  // Check if this is the first message in the conversation
  const msgCount = await env.DB.prepare(
    `SELECT COUNT(*) as c FROM messages WHERE conversation_id = ?`
  ).bind(conversationId).first<{ c: number }>()

  const isFirst = (msgCount?.c || 0) <= 1

  // Memory routing: pick relevant models and inject their portraits
  const { models, catalog } = await routeMessage(env, userMessage)
  const routedMemory = formatRoutedMemory(models)
  if (routedMemory) parts.push(routedMemory)
  if (catalog) parts.push(catalog)

  // Observation RAG: top relevant observations
  if (isFirst) {
    const observations = await recall(env, userMessage, 8)
    if (observations.length > 0) {
      parts.push('# Relevant observations\n' + observations.map(o =>
        `- [${o.created_at}] ${o.content}`
      ).join('\n'))
    }
  }

  // Lists: always-loaded and per-message
  const listsPreamble = await buildListsPreamble(env)
  if (listsPreamble) parts.push(listsPreamble)

  const reminder = await buildPerMessageReminder(env)
  if (reminder) parts.push(reminder)

  // Time context
  const now = new Date()
  parts.push(`Current time: ${now.toISOString()}`)

  return parts.join('\n\n')
}
