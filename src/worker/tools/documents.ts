import type { Tool } from './registry'
import { readDocument, formatDocsForTool } from '../documents'

export const documentTools: Tool[] = [
  {
    def: {
      type: 'function',
      function: {
        name: 'list_documents',
        description: 'List the documents you have been given to read in this conversation, with each one\'s id, title, length, and outline. Documents are held outside your context; this is how you see what is available. When someone gives you something long it is kept out here, and their message carries a pointer tag, <document id="..." title="..." lines="N"/>, so you can start right away; use this to look back at what you can still read.',
        parameters: { type: 'object', properties: {} },
      },
    },
    label: ['Checking documents', 'Checked documents'],
    run: async (ctx) => {
      return await formatDocsForTool(ctx.env, ctx.conversationId)
    },
  },
  {
    def: {
      type: 'function',
      function: {
        name: 'read_document',
        description: 'Read a bounded range of lines from a document held outside your context. Read in passes, not all at once: recall what you already know, pull a bounded chunk, integrate it against that memory (confirming, contradicting, extending), record what is worth keeping, then continue from where you stopped. The response reports the total length and where to continue.',
        parameters: {
          type: 'object',
          properties: {
            document_id: { type: 'string', description: 'The document id' },
            start_line: { type: 'number', description: 'First line to read (1-based)' },
            end_line: { type: 'number', description: 'Last line to read; capped to a bounded window' },
          },
          required: ['document_id', 'start_line', 'end_line'],
        },
      },
    },
    label: ['Reading', 'Read a passage'],
    run: async (ctx, args) => {
      return await readDocument(ctx.env, args.document_id as string, args.start_line as number, args.end_line as number)
    },
  },
]
