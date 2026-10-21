// Per-user storage. Each user's Durable Object owns a private SQLite database
// (ctx.storage.sql). The worker's queries were written against D1, so this wraps
// that database in the slice of the D1 API they use - prepare/bind/first/all/run
// and batch - and the call sites stay as they are. The DO hands this to the rest
// of the worker as `env.DB`; the real D1 (shared: users, MCP) stays on the
// untouched env.

import { USER_SCHEMA } from './user-schema'

type Binding = string | number | null | ArrayBuffer

// The part of DurableObjectStorage's SqlStorage that this file touches. Narrow on
// purpose, so tests can back it with node:sqlite.
export interface SqlLike {
  exec(query: string, ...bindings: Binding[]): { toArray(): Record<string, unknown>[] }
}

export type Transact = <T>(fn: () => T) => T

interface Meta { changes: number; last_row_id: number }
interface Result<T> { results: T[]; success: true; meta: Meta }

class Statement {
  constructor(
    private sql: SqlLike,
    private query: string,
    private params: Binding[] = [],
  ) {}

  bind(...values: unknown[]): Statement {
    return new Statement(this.sql, this.query, values.map(v => (v === undefined ? null : v as Binding)))
  }

  // Sync core. Everything runs without an await, so last_insert_rowid() and
  // changes() still describe the statement just executed.
  execute<T>(): Result<T> {
    const results = this.sql.exec(this.query, ...this.params).toArray() as T[]
    const m = this.sql.exec('SELECT changes() AS c, last_insert_rowid() AS id').toArray()[0] as { c: number; id: number }
    return { results, success: true, meta: { changes: m.c, last_row_id: m.id } }
  }

  async all<T = Record<string, unknown>>(): Promise<Result<T>> { return this.execute<T>() }
  async run(): Promise<Result<never>> { return this.execute<never>() }
  async first<T = Record<string, unknown>>(): Promise<T | null> { return this.execute<T>().results[0] ?? null }
}

export interface UserDb {
  prepare(query: string): Statement
  batch<T = unknown>(statements: Statement[]): Promise<Result<T>[]>
}

export function userDb(sql: SqlLike, transact: Transact): D1Database {
  const db: UserDb = {
    prepare: (query) => new Statement(sql, query),
    // D1 runs a batch as one transaction.
    batch: async (statements) => transact(() => statements.map(s => s.execute())) as Result<never>[],
  }
  return db as unknown as D1Database
}

// Apply any schema steps this database hasn't seen. Runs in the DO constructor,
// before anything else touches storage.
export function migrate(sql: SqlLike, transact: Transact, steps: string[] = USER_SCHEMA): void {
  sql.exec('CREATE TABLE IF NOT EXISTS _schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)').toArray()
  const row = sql.exec('SELECT version FROM _schema WHERE id = 1').toArray()[0] as { version: number } | undefined
  const current = row?.version ?? 0
  for (let v = current; v < steps.length; v++) {
    transact(() => {
      sql.exec(steps[v]!).toArray()
      sql.exec('INSERT INTO _schema (id, version) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version', v + 1).toArray()
    })
  }
}
