import { describe, it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { userDb, migrate, type SqlLike, type Transact } from './user-db'
import { importLegacy } from './legacy-import'

function fake() {
  const raw = new DatabaseSync(':memory:') // foreign keys enforced, like the real thing
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
  return { sql, transact, db: userDb(sql, transact) }
}

// The old D1 looks like a user database (same tables), plus tables that now live
// only in the control plane, which the import must leave alone.
function legacyWithData() {
  const legacy = fake()
  migrate(legacy.sql, legacy.transact)
  legacy.sql.exec(`CREATE TABLE users (sub TEXT PRIMARY KEY)`).toArray()
  legacy.sql.exec(`INSERT INTO users VALUES ('someone')`).toArray()
  legacy.sql.exec(`UPDATE agents SET cadence_minutes = 45 WHERE id = 'angel'`).toArray()
  for (let i = 1; i <= 450; i++) legacy.sql.exec(`INSERT INTO messages (conversation_id, role, content) VALUES ('main', 'user', ?)`, `m${i}`).toArray()
  legacy.sql.exec(`INSERT INTO lists (id, name, description, load_mode, agent_id) VALUES ('l-extra', 'extra', 'x', 'on-demand', 'angel')`).toArray()
  // Item 1 was superseded by item 2: copied in rowid order, it points forward.
  legacy.sql.exec(`INSERT INTO list_items (id, list_id, content) VALUES (2, 'l-extra', 'new')`).toArray()
  legacy.sql.exec(`INSERT INTO list_items (id, list_id, content, superseded_by) VALUES (1, 'l-extra', 'old', 2)`).toArray()
  return legacy
}

function progressStore() {
  let p: { done: string[]; wiped: boolean } | null = null
  return { get: () => p, set: (v: { done: string[]; wiped: boolean }) => { p = v } }
}

describe('legacy import', () => {
  it('copies everything across pages, keeps ids, replaces the seed rows', async () => {
    const legacy = legacyWithData()
    const local = fake()
    migrate(local.sql, local.transact)
    const store = progressStore()
    await importLegacy(legacy.db, local.sql, local.transact, store.get, store.set)

    expect((await local.db.prepare('SELECT COUNT(*) AS c FROM messages').first<{ c: number }>())?.c).toBe(450)
    expect((await local.db.prepare('SELECT MAX(id) AS m FROM messages').first<{ m: number }>())?.m).toBe(450)
    expect((await local.db.prepare(`SELECT cadence_minutes AS c FROM agents WHERE id = 'angel'`).first<{ c: number }>())?.c).toBe(45)
    expect((await local.db.prepare('SELECT COUNT(*) AS c FROM lists').first<{ c: number }>())?.c).toBe(3) // 2 seeded + extra
    expect(await local.db.prepare(`SELECT name FROM sqlite_master WHERE name = 'users'`).first()).toBeNull()
    expect(store.get()?.done).toContain('messages')
    expect((await local.db.prepare('SELECT superseded_by AS s FROM list_items WHERE id = 1').first<{ s: number }>())?.s).toBe(2)
  })

  it('does nothing when the old database holds no messages', async () => {
    const legacy = fake()
    migrate(legacy.sql, legacy.transact)
    const local = fake()
    migrate(local.sql, local.transact)
    local.sql.exec(`UPDATE agents SET cadence_minutes = 10 WHERE id = 'angel'`).toArray()
    const store = progressStore()
    await importLegacy(legacy.db, local.sql, local.transact, store.get, store.set)
    expect((await local.db.prepare(`SELECT cadence_minutes AS c FROM agents WHERE id = 'angel'`).first<{ c: number }>())?.c).toBe(10) // not wiped
  })

  it('resumes after an interruption without duplicating rows', async () => {
    const legacy = legacyWithData()
    const local = fake()
    migrate(local.sql, local.transact)
    const store = progressStore()
    // Die partway: let the first page of messages land, then fail the second read.
    let reads = 0
    const flaky = {
      prepare: (q: string) => {
        const stmt = legacy.db.prepare(q)
        if (!/FROM "messages"/.test(q)) return stmt
        return { bind: (...a: unknown[]) => { const s = stmt.bind(...a); return { all: async () => { if (++reads === 2) throw new Error('boom'); return s.all() } } } }
      },
    } as unknown as D1Database
    await expect(importLegacy(flaky, local.sql, local.transact, store.get, store.set)).rejects.toThrow('boom')
    expect((await local.db.prepare('SELECT COUNT(*) AS c FROM messages').first<{ c: number }>())?.c).toBe(200)

    await importLegacy(legacy.db, local.sql, local.transact, store.get, store.set)
    expect((await local.db.prepare('SELECT COUNT(*) AS c FROM messages').first<{ c: number }>())?.c).toBe(450)
  })
})
