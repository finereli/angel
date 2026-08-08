import type { Env, ToolDefinition } from './types'
import {
  addObservation, createModel, updateModelDescription, getModel,
  getAllModels, recall, getGlopusModels, getGlopusModel
} from './memory'
import {
  getLists, getList, getListItems, addListItem,
  supersedeListItem, archiveListItem, createList
} from './lists'
import { renderShortTermPyramid } from './short-term'

export function getToolDefinitions(): ToolDefinition[] {
  return [
    // Memory tools
    {
      type: 'function',
      function: {
        name: 'record_observation',
        description: 'Record something worth remembering across sessions. Write in your own voice - what mattered, what shifted, specific facts. Tag with one or more model names. Pyramid is for narrative and insight, not records or lists - if you would update a row rather than append a thought, use a list instead.',
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'The observation to record' },
            models: {
              type: 'array',
              items: { type: 'string' },
              description: 'Model names to tag this observation to',
            },
          },
          required: ['content', 'models'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'create_model',
        description: 'Create a new memory model when a genuinely new person, project, or topic emerges that deserves its own cluster.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Short kebab-case name' },
            description: { type: 'string', description: 'What this model tracks' },
          },
          required: ['name', 'description'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'update_model_description',
        description: 'Update the description of an existing memory model.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
          },
          required: ['name', 'description'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'recall',
        description: 'Search memory for specific facts. Use to verify names, dates, numbers, quotes before stating them. Returns raw observation fragments.',
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
        name: 'memory_load_model',
        description: 'Load a specific memory model by name. Use when the automatic router missed a relevant model, or when you want to explore a topic the catalog lists.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Model name from the catalog' },
          },
          required: ['name'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'memory_stats',
        description: 'Get memory system statistics - model count, observation count, summary count.',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'catchup',
        description: 'Pull the short-term cross-conversation pyramid for continuity context.',
        parameters: { type: 'object', properties: {} },
      },
    },
    // Glopus reference memory
    {
      type: 'function',
      function: {
        name: 'glopus_models',
        description: 'List all available Glopus (predecessor) memory models. Glopus is the companion agent that came before you - his accumulated knowledge is available as reference.',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'glopus_load',
        description: 'Load a specific Glopus model portrait. Use to access your predecessor\'s accumulated knowledge about a person, project, or topic.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Glopus model name' },
          },
          required: ['name'],
        },
      },
    },
    // List tools
    {
      type: 'function',
      function: {
        name: 'lists_catalog',
        description: 'List all available lists with their load modes and item counts.',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_create',
        description: 'Create a new list for structured records, procedures, or rules.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
            load_mode: {
              type: 'string',
              enum: ['always', 'per-message', 'on-demand', 'search-only'],
              description: 'When to inject: always (every turn), per-message (as reminder), on-demand (agent loads explicitly), search-only (vector search only)',
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
          properties: {
            name: { type: 'string', description: 'List name' },
          },
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
            name: { type: 'string', description: 'List name' },
            content: { type: 'string' },
            ordinal: { type: 'number', description: 'Position number for ordered lists' },
          },
          required: ['name', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_supersede',
        description: 'Replace a list item with an updated version. Preserves history.',
        parameters: {
          type: 'object',
          properties: {
            item_id: { type: 'number', description: 'ID of the item to replace' },
            content: { type: 'string', description: 'New content' },
          },
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
          properties: {
            item_id: { type: 'number', description: 'ID of the item to archive' },
          },
          required: ['item_id'],
        },
      },
    },
  ]
}

export async function executeTool(
  env: Env,
  conversationId: string,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  switch (name) {
    // Memory
    case 'record_observation': {
      const id = await addObservation(
        env,
        args.content as string,
        args.models as string[],
        'agent',
        conversationId
      )
      return `Observation ${id} recorded.`
    }
    case 'create_model': {
      const id = await createModel(env, args.name as string, args.description as string)
      return `Model "${args.name}" created (${id}).`
    }
    case 'update_model_description': {
      await updateModelDescription(env, args.name as string, args.description as string)
      return `Model "${args.name}" description updated.`
    }
    case 'recall': {
      const results = await recall(env, args.query as string, (args.limit as number) || 8)
      if (results.length === 0) return 'No matching observations found.'
      return results.map(r =>
        `[${r.created_at}] (score: ${r.score.toFixed(3)}) ${r.content}`
      ).join('\n\n')
    }
    case 'memory_load_model': {
      const model = await getModel(env, args.name as string)
      if (!model) return `Model "${args.name}" not found.`
      if (!model.portrait) return `Model "${args.name}" exists but has no portrait yet (${model.observation_count} observations).`
      return `# ${model.name}\n${model.description || ''}\n\n${model.portrait}`
    }
    case 'memory_stats': {
      const { getMemoryStats } = await import('./memory')
      const stats = await getMemoryStats(env)
      return `Models: ${stats.models}\nObservations: ${stats.observations}\nSummaries: ${stats.summaries}`
    }
    case 'catchup': {
      const pyramid = await renderShortTermPyramid(env)
      return pyramid || 'No short-term context available yet.'
    }

    // Glopus reference
    case 'glopus_models': {
      const models = await getGlopusModels(env)
      if (models.length === 0) return 'No Glopus models imported yet.'
      return models.map(m =>
        `- ${m.name} (${m.observation_count} obs): ${m.description || ''}`
      ).join('\n')
    }
    case 'glopus_load': {
      const model = await getGlopusModel(env, args.name as string)
      if (!model) return `Glopus model "${args.name}" not found.`
      if (!model.portrait) return `Glopus model "${args.name}" has no portrait.`
      return `# Glopus: ${model.name}\n${model.description || ''}\n\n${model.portrait}`
    }

    // Lists
    case 'lists_catalog': {
      const lists = await getLists(env)
      if (lists.length === 0) return 'No lists exist yet.'
      const items: string[] = []
      for (const list of lists) {
        const listItems = await getListItems(env, list.id)
        items.push(`- ${list.name} [${list.load_mode}] (${listItems.length} items): ${list.description || ''}`)
      }
      return items.join('\n')
    }
    case 'list_create': {
      const id = await createList(env, args.name as string, args.description as string, args.load_mode as string)
      return `List "${args.name}" created (${id}).`
    }
    case 'list_read': {
      const list = await getList(env, args.name as string)
      if (!list) return `List "${args.name}" not found.`
      const items = await getListItems(env, list.id)
      if (items.length === 0) return `List "${args.name}" is empty.`
      return items.map(item => {
        const prefix = item.ordinal != null ? `${item.ordinal}. ` : ''
        return `[${item.id}] ${prefix}${item.content}`
      }).join('\n')
    }
    case 'list_add': {
      const list = await getList(env, args.name as string)
      if (!list) return `List "${args.name}" not found.`
      const id = await addListItem(env, list.id, args.content as string, args.ordinal as number | undefined)
      return `Item ${id} added to "${args.name}".`
    }
    case 'list_supersede': {
      const newId = await supersedeListItem(env, args.item_id as number, args.content as string)
      return `Item ${args.item_id} superseded by ${newId}.`
    }
    case 'list_archive': {
      await archiveListItem(env, args.item_id as number)
      return `Item ${args.item_id} archived.`
    }

    default:
      return `Unknown tool: ${name}`
  }
}
