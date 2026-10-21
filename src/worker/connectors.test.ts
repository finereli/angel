import { describe, it, expect } from 'vitest'
import { parseSse, formatToolResult } from './mcp-client'
import { parseWwwAuthenticate, metadataUrls, pkceChallenge } from './mcp-oauth'
import { slugFromUrl, cleanName, normalizeUrl } from './connectors'

describe('parseSse', () => {
  it('finds the reply with our id past notifications', () => {
    const body = [
      'event: message', 'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}', '',
      'event: message', 'data: {"jsonrpc":"2.0","id":7,"result":{"ok":true}}', '',
    ].join('\n')
    expect(parseSse(body, 7)).toEqual({ jsonrpc: '2.0', id: 7, result: { ok: true } })
  })
  it('handles a last event without a trailing blank line, and CRLF', () => {
    expect(parseSse('data: {"id":1,"result":2}\r\n', 1)).toEqual({ id: 1, result: 2 })
  })
  it('joins multi-line data', () => {
    expect(parseSse('data: {"id":3,\ndata: "result":4}\n\n', 3)).toEqual({ id: 3, result: 4 })
  })
  it('returns undefined when the id never comes', () => {
    expect(parseSse('data: {"id":2,"result":1}\n\n', 9)).toBeUndefined()
  })
})

describe('formatToolResult', () => {
  it('joins text and notes what the model cannot see', () => {
    const r = formatToolResult({ content: [{ type: 'text', text: 'hi' }, { type: 'image', mimeType: 'image/png', data: 'x' }] })
    expect(r).toEqual({ text: 'hi\n\n[image (image/png) - not shown]', isError: false })
  })
  it('falls back to structured content', () => {
    expect(formatToolResult({ content: [], structuredContent: { a: 1 } }).text).toBe('{\n  "a": 1\n}')
  })
  it('carries isError', () => {
    expect(formatToolResult({ content: [{ type: 'text', text: 'bad' }], isError: true }).isError).toBe(true)
  })
})

describe('oauth helpers', () => {
  it('reads resource_metadata and scope', () => {
    expect(parseWwwAuthenticate('Bearer error="invalid_token", resource_metadata="https://x.com/.well-known/oauth-protected-resource", scope="read write"'))
      .toEqual({ resourceMetadata: 'https://x.com/.well-known/oauth-protected-resource', scope: 'read write' })
    expect(parseWwwAuthenticate(null)).toEqual({})
  })
  it('builds metadata URLs with and without an issuer path', () => {
    expect(metadataUrls('https://auth.x.com')).toEqual([
      'https://auth.x.com/.well-known/oauth-authorization-server',
      'https://auth.x.com/.well-known/openid-configuration',
    ])
    expect(metadataUrls('https://x.com/tenant/1/')[0]).toBe('https://x.com/.well-known/oauth-authorization-server/tenant/1')
  })
  it('makes the RFC 7636 S256 challenge', async () => {
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })
})

describe('connector names', () => {
  it('derives a short name from the host', () => {
    expect(slugFromUrl('https://mcp.notion.com/mcp')).toBe('notion')
    expect(slugFromUrl('https://mcp.linear.app/mcp')).toBe('linear')
    expect(slugFromUrl('https://api.githubcopilot.com/mcp/')).toBe('githubcopilot')
    expect(slugFromUrl('https://docs.mcp.cloudflare.com/mcp')).toBe('docs-cloudflare')
  })
  it('cleans names', () => {
    expect(cleanName('  My Notion! ')).toBe('my-notion')
  })
  it('adds https and refuses plain http', () => {
    expect(normalizeUrl('mcp.deepwiki.com/mcp')).toBe('https://mcp.deepwiki.com/mcp')
    expect(() => normalizeUrl('http://example.com/mcp')).toThrow()
  })
})
