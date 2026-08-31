import type { Tool } from './registry'
import { fetchPage } from '../web'
import { ingestContent } from '../documents'

const MAX_RESPONSE = 50_000
const POST_TIMEOUT_MS = 15_000

export const webTools: Tool[] = [
  {
    def: {
      type: 'function',
      function: {
        name: 'web_fetch',
        description: 'Fetch a web page and return its content as Markdown. Use this when Eli shares a URL or when you need to read something from the web.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'The URL to fetch' },
          },
          required: ['url'],
        },
      },
    },
    label: ['Reading web page', 'Read web page'],
    run: async (ctx, args) => {
      const md = await fetchPage(args.url as string)
      if (md.startsWith('Failed to fetch:')) return md
      const title = md.match(/^# (.+)/m)?.[1] || (args.url as string)
      const result = await ingestContent(ctx.env, ctx.conversationId, title, md)
      if (!result.stored) return result.text
      return `Stored as a document for deep reading:\n"${result.meta.title}" - ${result.meta.line_count} lines (id: ${result.meta.id})\nUse read_document to read it in passes.`
    },
  },
  {
    def: {
      type: 'function',
      function: {
        name: 'web_post',
        description: 'Send an HTTP POST request to a URL and return the response. Use this for testing APIs, endpoints, or any POST request.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'The URL to POST to' },
            body: { type: 'string', description: 'Request body (usually JSON). Will be sent as-is.' },
            content_type: { type: 'string', description: 'Content-Type header. Defaults to application/json.' },
          },
          required: ['url'],
        },
      },
    },
    label: ['Sending request', 'Sent request'],
    run: async (_ctx, args) => {
      const url = args.url as string
      const body = (args.body as string) || undefined
      const contentType = (args.content_type as string) || 'application/json'
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS)
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': contentType },
          body,
          signal: controller.signal,
        })
        clearTimeout(timer)
        const text = await res.text()
        const truncated = text.length > MAX_RESPONSE ? text.slice(0, MAX_RESPONSE) + '...(truncated)' : text
        return `${res.status} ${res.statusText}\n\n${truncated}`
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`
      }
    },
  },
]
