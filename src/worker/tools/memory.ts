import type { Tool } from './registry'
import {
  addObservation, createTag, updateTagDescription, getAllTags, recall, getMemoryStats,
} from '../memory'

export const memoryTools: Tool[] = [
  {
    def: {
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
    label: ['Recording observation', 'Recorded observation'],
    run: async (env, conversationId, args) => {
      const id = await addObservation(env, args.content as string, (args.tags as string[]) || [], 'agent', conversationId)
      return `Recorded (${id}).`
    },
  },
  {
    def: {
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
    label: ['Searching memory', 'Searched memory'],
    run: async (env, _cid, args) => {
      const hits = await recall(env, args.query as string, (args.limit as number) || 8)
      if (hits.length === 0) return 'Nothing found.'
      return hits.map(h => `[${h.label}] ${h.text}`).join('\n\n')
    },
  },
  {
    def: {
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
    label: ['Creating tag', 'Created tag'],
    run: async (env, _cid, args) => {
      await createTag(env, args.name as string, args.description as string)
      return `Tag "${args.name}" ready.`
    },
  },
  {
    def: {
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
    label: ['Updating tag', 'Updated tag'],
    run: async (env, _cid, args) => {
      await updateTagDescription(env, args.name as string, args.description as string)
      return `Tag "${args.name}" updated.`
    },
  },
  {
    def: {
      type: 'function',
      function: {
        name: 'list_tags',
        description: 'List your tags with their descriptions and observation counts.',
        parameters: { type: 'object', properties: {} },
      },
    },
    label: ['Reviewing tags', 'Reviewed tags'],
    run: async (env) => {
      const tags = await getAllTags(env)
      if (tags.length === 0) return 'No tags yet.'
      return tags.map(t => `- ${t.name} (${t.observation_count}): ${t.description || ''}`).join('\n')
    },
  },
  {
    def: {
      type: 'function',
      function: {
        name: 'memory_stats',
        description: 'Counts: tags, observations, summaries.',
        parameters: { type: 'object', properties: {} },
      },
    },
    label: ['Checking memory', 'Checked memory'],
    run: async (env) => {
      const s = await getMemoryStats(env)
      return `Tags: ${s.tags}\nObservations: ${s.observations}\nSummaries: ${s.summaries}`
    },
  },
]
