import { describe, it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { userDb, migrate, type SqlLike, type Transact } from './user-db'

// node:sqlite stands in for ctx.storage.sql: same shape (exec -> cursor with
// toArray), real SQLite underneath.
function fake() {
  const raw = new DatabaseSync(':memory:')
  raw.exec('PRAGMA foreign_keys = ON')
  const sql: SqlLike = {
    exec(query, ...b) {
      if (b.length === 0 && /;\s*\S/.test(query)) { raw.exec(query); return { toArray: () => [] } }
      const rows = raw.prepare(query).all(...(b as never[])) as Record<string, unknown>[]
      return { toArray: () => rows }
    },
  }
  const transact: Transact = (fn) => {
    raw.exec('BEGIN')
    try { const r = fn(); raw.exec('COMMIT'); return r } catch (e) { raw.exec('ROLLBACK'); throw e }
  }
  return { sql, transact }
}

describe('user db', () => {
  it('migrates once and seeds the agent', async () => {
    const { sql, transact } = fake()
    migrate(sql, transact)
    migrate(sql, transact) // second run is a no-op, not a duplicate seed
    const db = userDb(sql, transact)
    const agents = await db.prepare('SELECT id, name FROM agents').all<{ id: string; name: string }>()
    expect(agents.results).toEqual([{ id: 'angel', name: 'Angel' }])
    const cols = await db.prepare('PRAGMA table_info(agents)').all<{ name: string }>()
    expect(cols.results.map(c => c.name)).toContain('reasoning_effort')
    expect((await db.prepare("SELECT name FROM sqlite_master WHERE name = 'system_doc'").first())).toBeNull()
  })

  it('reports last_row_id and changes like D1', async () => {
    const { sql, transact } = fake()
    migrate(sql, transact)
    const db = userDb(sql, transact)
    const ins = await db.prepare(`INSERT INTO messages (conversation_id, role, content) VALUES (?, 'user', ?)`).bind('main', 'hi').run()
    const ins2 = await db.prepare(`INSERT INTO messages (conversation_id, role, content) VALUES (?, 'user', ?)`).bind('main', 'again').run()
    expect(ins2.meta.last_row_id).toBe(ins.meta.last_row_id + 1)
    const upd = await db.prepare(`UPDATE messages SET content = ? WHERE conversation_id = ?`).bind('x', 'main').run()
    expect(upd.meta.changes).toBe(2)
    expect((await db.prepare(`SELECT content FROM messages WHERE id = ?`).bind(ins.meta.last_row_id).first<{ content: string }>())?.content).toBe('x')
  })

  it('batch is atomic and returns one result per statement', async () => {
    const { sql, transact } = fake()
    migrate(sql, transact)
    const db = userDb(sql, transact)
    const out = await db.batch([
      db.prepare('SELECT COUNT(*) AS c FROM agents'),
      db.prepare('SELECT COUNT(*) AS c FROM lists'),
    ])
    expect((out[0]!.results[0] as { c: number }).c).toBe(1)
    expect((out[1]!.results[0] as { c: number }).c).toBe(2)
    await expect(db.batch([
      db.prepare(`INSERT INTO tags (id, name) VALUES ('t1', 'a')`),
      db.prepare(`INSERT INTO tags (id, name) VALUES ('t1', 'b')`), // PK clash
    ])).rejects.toThrow()
    expect((await db.prepare('SELECT COUNT(*) AS c FROM tags').first<{ c: number }>())?.c).toBe(0)
  })

  it('treats undefined binds as NULL and first() as null on no rows', async () => {
    const { sql, transact } = fake()
    migrate(sql, transact)
    const db = userDb(sql, transact)
    await db.prepare(`INSERT INTO kv (key, value) VALUES (?, ?)`).bind('k', 'v').run()
    expect(await db.prepare('SELECT value FROM kv WHERE key = ?').bind('nope').first()).toBeNull()
    await db.prepare(`INSERT INTO conversations (id, title) VALUES (?, ?)`).bind('c2', undefined).run()
    expect((await db.prepare('SELECT title FROM conversations WHERE id = ?').bind('c2').first<{ title: string | null }>())?.title).toBeNull()
  })
})
