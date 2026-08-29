import type { Tool } from './registry'
import {
  getLists, getList, getListItems, addListItem,
  supersedeListItem, archiveListItem, createList,
} from '../lists'

export const listTools: Tool[] = [
  {
    def: {
      type: 'function',
      function: {
        name: 'lists_catalog',
        description: 'List all lists with their load modes and item counts.',
        parameters: { type: 'object', properties: {} },
      },
    },
    label: ['Checking lists', 'Checked lists'],
    run: async (ctx) => {
      const lists = await getLists(ctx.env, ctx.agentId)
      if (lists.length === 0) return 'No lists yet.'
      const out: string[] = []
      for (const l of lists) {
        const items = await getListItems(ctx.env, l.id)
        out.push(`- ${l.name} [${l.load_mode}] (${items.length}): ${l.description || ''}`)
      }
      return out.join('\n')
    },
  },
  {
    def: {
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
              enum: ['always', 'on-demand', 'per-message'],
              description: 'always = injected every turn in system prompt; on-demand = you load it explicitly; per-message = appended as a reminder to each message (for transient nudges you want front of mind)',
            },
          },
          required: ['name', 'description', 'load_mode'],
        },
      },
    },
    label: ['Creating list', 'Created list'],
    run: async (ctx, args) => {
      await createList(ctx.env, ctx.agentId, args.name as string, args.description as string, args.load_mode as string)
      return `List "${args.name}" created.`
    },
  },
  {
    def: {
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
    label: ['Reading list', 'Read list'],
    run: async (ctx, args) => {
      const list = await getList(ctx.env, ctx.agentId, args.name as string)
      if (!list) return `List "${args.name}" not found.`
      const items = await getListItems(ctx.env, list.id)
      if (items.length === 0) return `List "${args.name}" is empty.`
      return items.map(i => `[${i.id}] ${i.ordinal != null ? `${i.ordinal}. ` : ''}${i.content}`).join('\n')
    },
  },
  {
    def: {
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
    label: ['Adding to list', 'Added to list'],
    run: async (ctx, args) => {
      const list = await getList(ctx.env, ctx.agentId, args.name as string)
      if (!list) return `List "${args.name}" not found.`
      const id = await addListItem(ctx.env, list.id, args.content as string, args.ordinal as number | undefined)
      return `Added (${id}) to "${args.name}".`
    },
  },
  {
    def: {
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
    label: ['Updating item', 'Updated item'],
    run: async (ctx, args) => {
      const newId = await supersedeListItem(ctx.env, args.item_id as number, args.content as string)
      return `Item ${args.item_id} superseded by ${newId}.`
    },
  },
  {
    def: {
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
    label: ['Archiving item', 'Archived item'],
    run: async (ctx, args) => {
      await archiveListItem(ctx.env, args.item_id as number)
      return `Item ${args.item_id} archived.`
    },
  },
]
