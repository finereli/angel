import type { Tool } from './registry'
import { fetchPage } from '../web'
import { ingestContent } from '../documents'

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
    run: async (env, conversationId, args) => {
      const md = await fetchPage(args.url as string)
      if (md.startsWith('Failed to fetch:')) return md
      const title = md.match(/^# (.+)/m)?.[1] || (args.url as string)
      const result = await ingestContent(env, conversationId, title, md)
      if (!result.stored) return result.text
      return `Stored as a document for deep reading:\n"${result.meta.title}" - ${result.meta.line_count} lines (id: ${result.meta.id})\nUse read_document to read it in passes.`
    },
  },
]
