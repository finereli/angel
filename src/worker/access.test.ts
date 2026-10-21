import { describe, it, expect } from 'vitest'
import { tokenOf, isAllowed, identify, offersAngelProtocol, ownerSub } from './access'
import type { Env } from './types'

const env = (over: Partial<Env> = {}) => ({ OWNER_EMAIL: 'Owner@Example.com', ...over }) as Env
// A stand-in for D1 holding the allowed_emails table.
const db = (emails: string[]) => ({ prepare: () => ({ all: async () => ({ results: emails.map(email => ({ email })) }) }) }) as unknown as D1Database
const req = (headers: Record<string, string>, url = 'https://angel.finereli.com/ws') => new Request(url, { headers })

describe('access', () => {
  it('reads the token from a bearer header or the websocket subprotocols', () => {
    expect(tokenOf(req({ Authorization: 'Bearer abc.def.ghi' }))).toBe('abc.def.ghi')
    expect(tokenOf(req({ 'Sec-WebSocket-Protocol': 'angel.v1, auth.abc.def.ghi' }))).toBe('abc.def.ghi')
    expect(tokenOf(req({ 'Sec-WebSocket-Protocol': 'angel.v1' }))).toBeUndefined()
    expect(tokenOf(req({}))).toBeUndefined()
    expect(offersAngelProtocol(req({ 'Sec-WebSocket-Protocol': 'x, angel.v1' }))).toBe(true)
    expect(offersAngelProtocol(req({}))).toBe(false)
  })

  it('allows the owner and the listed emails, in any Gmail spelling, and nobody else', async () => {
    const e = env({ DB: db(['friend@x.com', 'Dana.Smith@gmail.com', 'old@googlemail.com']) })
    expect(await isAllowed(e, 'owner@example.com')).toBe(true) // the owner is always in
    expect(await isAllowed(e, 'FRIEND@x.com')).toBe(true)
    expect(await isAllowed(e, 'danasmith@gmail.com')).toBe(true) // dots don't matter at Gmail
    expect(await isAllowed(e, 'd.a.n.a.smith+angel@gmail.com')).toBe(true)
    expect(await isAllowed(e, 'old@gmail.com')).toBe(true) // googlemail.com is gmail.com
    expect(await isAllowed(e, 'stranger@x.com')).toBe(false)
    expect(await isAllowed(e, 'f.riend@x.com')).toBe(false) // dots matter everywhere else
    expect(await isAllowed(env({ OWNER_EMAIL: '', DB: db([]) }), '')).toBe(false)
  })

  it('finds the owner among the users however Google spells the address', async () => {
    const users = { prepare: () => ({ all: async () => ({ results: [{ sub: 's1', email: 'someone@x.com' }, { sub: 's2', email: 'o.wner@gmail.com' }] }) }) } as unknown as D1Database
    expect(await ownerSub(env({ OWNER_EMAIL: 'owner@gmail.com', DB: users }))).toBe('s2')
    expect(await ownerSub(env({ OWNER_EMAIL: 'nobody@gmail.com', DB: users }))).toBeNull()
  })

  it('refuses a request with no token, and the dev bypass needs both locks', async () => {
    expect(await identify(env(), req({}))).toBeNull()
    expect(await identify(env({ DEV_AUTH: 'allow' }), req({}, 'https://angel.finereli.com/ws'))).toBeNull() // deployed host
    expect(await identify(env(), req({}, 'http://localhost:8787/ws'))).toBeNull() // no DEV_AUTH
    expect((await identify(env({ DEV_AUTH: 'allow' }), req({}, 'http://localhost:8787/ws')))?.sub).toBe('dev-user')
  })
})
