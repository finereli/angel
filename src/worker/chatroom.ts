// Chatroom storage, shared by the DO's handlers and the agent tools.
import type { Env, ChatroomMessageRow } from './types'

// D1's datetime('now') stores 'YYYY-MM-DD HH:MM:SS'. Callers (agents especially)
// pass ISO-8601 with 'T'/'Z'/millis, and 'T' > ' ' in a string comparison would
// silently exclude every newer row - so normalize to D1's shape first.
function toD1Timestamp(ts: string): string {
  return ts.trim().replace('T', ' ').replace(/(\.\d+)?Z?$/, '')
}

// Everything after `since` (ascending), or the latest `limit` messages.
export async function readRoomMessages(env: Env, since?: string, limit = 50): Promise<ChatroomMessageRow[]> {
  if (since) {
    const rows = await env.DB.prepare(
      `SELECT id, author, content, created_at FROM chatroom_messages WHERE created_at > ? ORDER BY created_at ASC LIMIT 200`
    ).bind(toD1Timestamp(since)).all<ChatroomMessageRow>()
    return rows.results || []
  }
  const rows = await env.DB.prepare(
    `SELECT id, author, content, created_at FROM chatroom_messages ORDER BY created_at DESC LIMIT ?`
  ).bind(limit).all<ChatroomMessageRow>()
  return (rows.results || []).reverse()
}

export async function postRoomMessage(env: Env, author: string, content: string): Promise<ChatroomMessageRow> {
  // RETURNING keeps the broadcast row identical to what D1 stored - same id,
  // same timestamp format - so live and reloaded views never disagree.
  const row = await env.DB.prepare(
    `INSERT INTO chatroom_messages (author, content) VALUES (?, ?)
     RETURNING id, author, content, created_at`
  ).bind(author, content).first<ChatroomMessageRow>()
  return row!
}
