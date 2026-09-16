import type { Env, ListRow, ListItemRow } from './types'

export async function createList(
  env: Env,
  agentId: string,
  name: string,
  description: string,
  loadMode: string = 'on-demand'
): Promise<string> {
  const id = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO lists (id, agent_id, name, description, load_mode) VALUES (?, ?, ?, ?, ?)`
  ).bind(id, agentId, name, description, loadMode).run()
  return id
}

export async function getLists(env: Env, agentId: string): Promise<ListRow[]> {
  const result = await env.DB.prepare(
    `SELECT * FROM lists WHERE agent_id = ? ORDER BY name`
  ).bind(agentId).all<ListRow>()
  return result.results
}

export async function getList(env: Env, agentId: string, name: string): Promise<ListRow | null> {
  return env.DB.prepare(
    `SELECT * FROM lists WHERE agent_id = ? AND name = ?`
  ).bind(agentId, name).first<ListRow>()
}

export async function getListItems(
  env: Env,
  listId: string,
  includeArchived: boolean = false
): Promise<ListItemRow[]> {
  const sql = includeArchived
    ? `SELECT * FROM list_items WHERE list_id = ? AND superseded_by IS NULL ORDER BY COALESCE(ordinal, id)`
    : `SELECT * FROM list_items WHERE list_id = ? AND superseded_by IS NULL AND archived = 0 ORDER BY COALESCE(ordinal, id)`
  const result = await env.DB.prepare(sql).bind(listId).all<ListItemRow>()
  return result.results
}

export async function addListItem(
  env: Env,
  listId: string,
  content: string,
  ordinal?: number
): Promise<number> {
  const result = await env.DB.prepare(
    `INSERT INTO list_items (list_id, content, ordinal) VALUES (?, ?, ?)`
  ).bind(listId, content, ordinal ?? null).run()
  return result.meta.last_row_id
}

export async function supersedeListItem(
  env: Env,
  oldItemId: number,
  newContent: string
): Promise<number> {
  const old = await env.DB.prepare(
    `SELECT list_id, ordinal FROM list_items WHERE id = ?`
  ).bind(oldItemId).first<{ list_id: string; ordinal: number | null }>()

  if (!old) throw new Error(`List item ${oldItemId} not found`)

  const result = await env.DB.prepare(
    `INSERT INTO list_items (list_id, content, ordinal) VALUES (?, ?, ?)`
  ).bind(old.list_id, newContent, old.ordinal).run()

  const newId = result.meta.last_row_id

  await env.DB.prepare(
    `UPDATE list_items SET superseded_by = ? WHERE id = ?`
  ).bind(newId, oldItemId).run()

  return newId
}

export async function archiveListItem(env: Env, itemId: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE list_items SET archived = 1 WHERE id = ?`
  ).bind(itemId).run()
}

export async function buildListsPreamble(env: Env, agentId: string): Promise<string> {
  const lists = await env.DB.prepare(
    `SELECT * FROM lists WHERE agent_id = ? AND load_mode = 'always'`
  ).bind(agentId).all<ListRow>()

  if (lists.results.length === 0) return ''

  const parts: string[] = ['# Always-loaded lists']
  for (const list of lists.results) {
    const items = await getListItems(env, list.id)
    if (items.length === 0) continue
    parts.push(`## ${list.name}${list.description ? ` - ${list.description}` : ''}`)
    for (const item of items) {
      const prefix = item.ordinal != null ? `${item.ordinal}. ` : '- '
      parts.push(`${prefix}${item.content}`)
    }
  }

  return parts.length > 1 ? parts.join('\n') : ''
}

export async function buildPerMessageReminder(env: Env, agentId: string): Promise<string> {
  const lists = await env.DB.prepare(
    `SELECT * FROM lists WHERE agent_id = ? AND load_mode = 'per-message'`
  ).bind(agentId).all<ListRow>()

  if (lists.results.length === 0) return ''

  const parts: string[] = []
  for (const list of lists.results) {
    const items = await getListItems(env, list.id)
    if (items.length === 0) continue
    parts.push(`<reminder name="${list.name}">`)
    for (const item of items) {
      parts.push(`- ${item.content}`)
    }
    parts.push('</reminder>')
  }

  return parts.join('\n')
}
