import type { Env, ToolDefinition } from './types'
import {
  addObservation, createTag, updateTagDescription, getAllTags, recall, getMemoryStats,
} from './memory'
import {
  getLists, getList, getListItems, addListItem,
  supersedeListItem, archiveListItem, createList,
} from './lists'
import { fetchPage } from './web'
import { readDocument, formatDocsForTool } from './documents'

export function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      type: 'function',
      function: {
        name: 'record_observation',
        description: 'Keep something worth remembering across time, in your own voice - what mattered, what shifted, specifics. Tag it. Tags are yours to name; new ones are created automatically. Use lists instead for structured records you would update a row of rather than append a thought to.',
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'The observation to record' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Tag names to file this under' },
          },
          required: ['content', 'tags'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'recall',
        description: 'Search your memory. Returns matching observations (specific notes) and summaries (broader integrations, each labeled with how many observations back it). If a summary is close but you need specifics, search again more narrowly.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'What to search for' },
            limit: { type: 'number', description: 'Max results (default 8)' },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'create_tag',
        description: 'Create a tag with a description. Optional - tags are also created automatically when you first use them. Use this to give a tag a clear description.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Short kebab-case name' },
            description: { type: 'string', description: 'What this tag is about' },
          },
          required: ['name', 'description'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'update_tag_description',
        description: 'Update a tag\'s description.',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string' }, description: { type: 'string' } },
          required: ['name', 'description'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_tags',
        description: 'List your tags with their descriptions and observation counts.',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'memory_stats',
        description: 'Counts: tags, observations, summaries.',
        parameters: { type: 'object', properties: {} },
      },
    },
    // Web
    {
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
    // Lists
    {
      type: 'function',
      function: {
        name: 'lists_catalog',
        description: 'List all lists with their load modes and item counts.',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_create',
        description: 'Create a list for structured records, rules, or procedures.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
            load_mode: {
              type: 'string',
              enum: ['always', 'on-demand'],
              description: 'always = injected every turn; on-demand = you load it explicitly',
            },
          },
          required: ['name', 'description', 'load_mode'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_read',
        description: 'Read all active items in a list.',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_add',
        description: 'Add an item to a list.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            content: { type: 'string' },
            ordinal: { type: 'number', description: 'Position for ordered lists' },
          },
          required: ['name', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_supersede',
        description: 'Replace a list item with an updated version, preserving history.',
        parameters: {
          type: 'object',
          properties: { item_id: { type: 'number' }, content: { type: 'string' } },
          required: ['item_id', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_archive',
        description: 'Archive a list item (soft delete).',
        parameters: {
          type: 'object',
          properties: { item_id: { type: 'number' } },
          required: ['item_id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_documents',
        description: 'List the documents Eli has given you to read in this conversation, with each one\'s id, title, length, and outline. Documents are held outside your context; this is how you see what is available. When Eli attaches something you also get its pointer inline in his message, so you rarely need this on the spot - use it to look back at what you can still read.',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_document',
        description: 'Read a bounded range of lines from a document held outside your context. Pull a chunk at a time and read in passes; the response reports the total length and where to continue.',
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
  ]
}

export async function executeTool(
  env: Env, conversationId: string, name: string, args: Record<string, unknown>
): Promise<string> {
  switch (name) {
    case 'record_observation': {
      const id = await addObservation(env, args.content as string, (args.tags as string[]) || [], 'agent', conversationId)
      return `Recorded (${id}).`
    }
    case 'recall': {
      const hits = await recall(env, args.query as string, (args.limit as number) || 8)
      if (hits.length === 0) return 'Nothing found.'
      return hits.map(h => `[${h.label}] ${h.text}`).join('\n\n')
    }
    case 'create_tag': {
      await createTag(env, args.name as string, args.description as string)
      return `Tag "${args.name}" ready.`
    }
    case 'update_tag_description': {
      await updateTagDescription(env, args.name as string, args.description as string)
      return `Tag "${args.name}" updated.`
    }
    case 'list_tags': {
      const tags = await getAllTags(env)
      if (tags.length === 0) return 'No tags yet.'
      return tags.map(t => `- ${t.name} (${t.observation_count}): ${t.description || ''}`).join('\n')
    }
    case 'memory_stats': {
      const s = await getMemoryStats(env)
      return `Tags: ${s.tags}\nObservations: ${s.observations}\nSummaries: ${s.summaries}`
    }
    case 'web_fetch': {
      return await fetchPage(args.url as string)
    }
    case 'lists_catalog': {
      const lists = await getLists(env)
      if (lists.length === 0) return 'No lists yet.'
      const out: string[] = []
      for (const l of lists) {
        const items = await getListItems(env, l.id)
        out.push(`- ${l.name} [${l.load_mode}] (${items.length}): ${l.description || ''}`)
      }
      return out.join('\n')
    }
    case 'list_create': {
      await createList(env, args.name as string, args.description as string, args.load_mode as string)
      return `List "${args.name}" created.`
    }
    case 'list_read': {
      const list = await getList(env, args.name as string)
      if (!list) return `List "${args.name}" not found.`
      const items = await getListItems(env, list.id)
      if (items.length === 0) return `List "${args.name}" is empty.`
      return items.map(i => `[${i.id}] ${i.ordinal != null ? `${i.ordinal}. ` : ''}${i.content}`).join('\n')
    }
    case 'list_add': {
      const list = await getList(env, args.name as string)
      if (!list) return `List "${args.name}" not found.`
      const id = await addListItem(env, list.id, args.content as string, args.ordinal as number | undefined)
      return `Added (${id}) to "${args.name}".`
    }
    case 'list_supersede': {
      const newId = await supersedeListItem(env, args.item_id as number, args.content as string)
      return `Item ${args.item_id} superseded by ${newId}.`
    }
    case 'list_archive': {
      await archiveListItem(env, args.item_id as number)
      return `Item ${args.item_id} archived.`
    }
    case 'list_documents': {
      return await formatDocsForTool(env, conversationId)
    }
    case 'read_document': {
      return await readDocument(env, args.document_id as string, args.start_line as number, args.end_line as number)
    }
    default:
      return `Unknown tool: ${name}`
  }
}
