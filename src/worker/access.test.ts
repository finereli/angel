import { describe, it, expect } from 'vitest'
import { tokenOf, isAllowed, identify, offersAngelProtocol } from './access'
import type { Env } from './types'

const env = (over: Partial<Env> = {}) => ({ OWNER_EMAIL: 'Owner@Example.com', ...over }) as Env
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

  it('allows the owner and the listed emails, case-insensitively, and nobody else', () => {
    const e = env({ ALLOWED_EMAILS: ' friend@x.com , Other@Y.com ' })
    expect(isAllowed(e, 'owner@example.com')).toBe(true)
    expect(isAllowed(e, 'FRIEND@x.com')).toBe(true)
    expect(isAllowed(e, 'other@y.com')).toBe(true)
    expect(isAllowed(e, 'stranger@x.com')).toBe(false)
    expect(isAllowed(env({ OWNER_EMAIL: '' }), '')).toBe(false)
  })

  it('refuses a request with no token, and the dev bypass needs both locks', async () => {
    expect(await identify(env(), req({}))).toBeNull()
    expect(await identify(env({ DEV_AUTH: 'allow' }), req({}, 'https://angel.finereli.com/ws'))).toBeNull() // deployed host
    expect(await identify(env(), req({}, 'http://localhost:8787/ws'))).toBeNull() // no DEV_AUTH
    expect((await identify(env({ DEV_AUTH: 'allow' }), req({}, 'http://localhost:8787/ws')))?.sub).toBe('dev-user')
  })
})
