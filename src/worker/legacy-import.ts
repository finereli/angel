// One-time move of the old single-user data (every table in D1 before the
// per-user Durable Objects) into the owner's DO. D1 keeps its copy; a later
// migration drops those tables once the import is trusted.
//
// Resumable: progress is a kv row, and the wipe-then-copy only starts when there
// is none, so a request that dies halfway continues on the next connect.
import type { SqlLike, Transact } from './user-db'

const CHUNK = 200
// Parents before children (foreign keys). Any table found in both databases but
// missing here is copied after these.
const ORDER = [
  'agents', 'conversations', 'messages', 'tags', 'observations', 'observation_tags',
  'observation_summaries', 'summary_sources', 'stream_summaries', 'embeddings',
  'lists', 'list_items', 'documents', 'agent_wakeups', 'agent_scripts', 'agent_logs', 'kv',
]

interface Progress { done: string[]; wiped: boolean }

const q = (name: string) => `"${name.replace(/"/g, '""')}"`

function tablesOf(sql: SqlLike): string[] {
  return sql.exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_%' ESCAPE '\\'`)
    .toArray().map(r => r.name as string)
}

// Returns true when the import is finished (or there was nothing to import).
export async function importLegacy(
  legacy: D1Database, sql: SqlLike, transact: Transact, getProgress: () => Progress | null, setProgress: (p: Progress) => void,
): Promise<boolean> {
  let progress = getProgress()
  if (!progress) {
    // Nothing to import: D1 never had the old tables, or they hold no messages.
    const probe = await legacy.prepare('SELECT COUNT(*) AS c FROM messages').first<{ c: number }>().catch(() => null)
    if (!probe || probe.c === 0) return true
    progress = { done: [], wiped: false }
  }

  const local = new Set(tablesOf(sql))
  const legacyTables = new Set(
    (await legacy.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all<{ name: string }>()).results.map(r => r.name),
  )
  const shared = [...local].filter(t => legacyTables.has(t))
  const order = [...ORDER.filter(t => shared.includes(t)), ...shared.filter(t => !ORDER.includes(t))]

  if (!progress.wiped) {
    // The fresh database carries seed rows (the agent, the main conversation, two
    // lists). The legacy copies replace them, so clear first - children before parents.
    transact(() => { for (const t of [...order].reverse()) sql.exec(`DELETE FROM ${q(t)}`).toArray() })
    progress = { ...progress, wiped: true }
    setProgress(progress)
  }

  for (const table of order) {
    if (progress.done.includes(table)) continue
    const localCols = new Set(sql.exec(`PRAGMA table_info(${q(table)})`).toArray().map(r => r.name as string))
    // The resume point is however many rows already landed, so a half-copied
    // table picks up where it stopped rather than starting over.
    let offset = (sql.exec(`SELECT COUNT(*) AS c FROM ${q(table)}`).toArray()[0] as { c: number }).c
    for (;;) {
      const page = await legacy.prepare(`SELECT * FROM ${q(table)} ORDER BY rowid LIMIT ? OFFSET ?`).bind(CHUNK, offset).all<Record<string, unknown>>()
      if (page.results.length === 0) break
      transact(() => {
        for (const row of page.results) {
          const cols = Object.keys(row).filter(c => localCols.has(c))
          sql.exec(
            `INSERT INTO ${q(table)} (${cols.map(q).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
            ...cols.map(c => row[c] as string | number | null),
          ).toArray()
        }
      })
      offset += page.results.length
      if (page.results.length < CHUNK) break
    }
    progress = { ...progress, done: [...progress.done, table] }
    setProgress(progress)
  }
  return true
}
