import type { Env } from './types'
import { looksLikeHtml, htmlToMarkdown } from './web'

export interface DocMeta { id: string; title: string; line_count: number }
export type IngestResult = { stored: false; text: string } | { stored: true; meta: DocMeta }

export const DOC_THRESHOLD_CHARS = 6000

const MAX_READ_LINES = 200 // bound each bite so a read can't become a dump

export function normalizeContent(text: string, fallbackTitle?: string): string {
  return looksLikeHtml(text) ? htmlToMarkdown(text, fallbackTitle) : text
}

export async function ingestContent(
  env: Env, conversationId: string, title: string, raw: string,
): Promise<IngestResult> {
  const text = normalizeContent(raw, title)
  if (text.length < DOC_THRESHOLD_CHARS) return { stored: false, text }
  const meta = await storeDocument(env, conversationId, title, text)
  return { stored: true, meta }
}

export async function storeDocument(env: Env, conversationId: string, title: string, content: string): Promise<DocMeta> {
  const id = crypto.randomUUID()
  const line_count = content.split('\n').length
  await env.DB.prepare(
    `INSERT INTO documents (id, conversation_id, title, content, line_count) VALUES (?, ?, ?, ?, ?)`
  ).bind(id, conversationId, title.slice(0, 200), content, line_count).run()
  return { id, title, line_count }
}

export async function listDocuments(env: Env, conversationId: string): Promise<Array<DocMeta & { outline: string }>> {
  const rows = await env.DB.prepare(
    `SELECT id, title, content, line_count FROM documents WHERE conversation_id = ? ORDER BY created_at ASC`
  ).bind(conversationId).all<{ id: string; title: string; content: string; line_count: number }>()
  return rows.results.map(r => ({ id: r.id, title: r.title, line_count: r.line_count, outline: outlineOf(r.content) }))
}

// Markdown headers with their line numbers - the doc's shape, so Angel navigates
// structure instead of blind line numbers.
function outlineOf(content: string): string {
  const lines = content.split('\n')
  const heads: string[] = []
  for (let i = 0; i < lines.length && heads.length < 50; i++) {
    const m = lines[i]!.match(/^(#{1,6})\s+(.+)/)
    if (m) heads.push(`${String(i + 1).padStart(6)}  ${'  '.repeat(m[1]!.length - 1)}${m[2]!.trim()}`)
  }
  return heads.join('\n')
}

// A bounded slice, each line prefixed with its number and a hint on where to go next.
export async function readDocument(env: Env, id: string, start: number, end: number): Promise<string> {
  const row = await env.DB.prepare(
    `SELECT title, content, line_count FROM documents WHERE id = ?`
  ).bind(id).first<{ title: string; content: string; line_count: number }>()
  if (!row) return `No document with id ${id}.`

  const lines = row.content.split('\n')
  const total = lines.length
  const s = Math.max(1, Math.floor(start || 1))
  if (s > total) return `Document "${row.title}" has ${total} lines; ${s} is past the end.`
  let e = Math.max(s, Math.floor(end || s))
  if (e - s + 1 > MAX_READ_LINES) e = s + MAX_READ_LINES - 1
  e = Math.min(e, total)

  const body = lines.slice(s - 1, e).map((ln, i) => `${String(s + i).padStart(6)}  ${ln}`).join('\n')
  const foot = e < total
    ? `\n\n[lines ${s}-${e} of ${total} - continue from line ${e + 1}]`
    : `\n\n[lines ${s}-${e} of ${total} - end of "${row.title}"]`
  return body + foot
}

// The catalog returned by the list_documents tool - not standing context. Angel
// pulls this when he wants to know what's readable in this conversation.
export async function formatDocsForTool(env: Env, conversationId: string): Promise<string> {
  const docs = await listDocuments(env, conversationId)
  if (!docs.length) return 'No documents in this conversation yet.'
  return docs.map(d => {
    const head = `id: ${d.id}\n"${d.title}" - ${d.line_count} lines`
    return d.outline ? `${head}\noutline (line: heading):\n${d.outline}` : head
  }).join('\n\n')
}
