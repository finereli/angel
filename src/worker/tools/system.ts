import type { Tool } from './registry'
import { buildSystemDoc } from '../system-doc'

// The machine Angel runs on, on demand. It is reference material, not something
// worth spending context on every turn, so it lives behind a tool rather than in
// the system prompt.
export const systemTools: Tool[] = [
  {
    def: {
      type: 'function',
      function: {
        name: 'read_system_doc',
        description:
          "Read the reference for the machine you run on: the runtime, how your stream and memory work, wake-ups, storage, and what you can and cannot change. It is short. Read it when a question turns on how you work. It is not in your context by default.",
        parameters: { type: 'object', properties: {} },
      },
    },
    label: ['Reading system doc', 'Read system doc'],
    run: async () => buildSystemDoc(),
  },
  {
    def: {
      type: 'function',
      function: {
        name: 'rename_self',
        description:
          'Change the name you go by. Use it when the person asks to call you something else, or when you both settle on a name. It takes effect from your next turn and shows up in their sidebar and Settings.',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string', description: 'Your new name, up to 40 characters.' } },
          required: ['name'],
        },
      },
    },
    label: ['Changing name', 'Changed name'],
    doneLabel: (args) => `Renamed to ${String(args.name ?? '').trim().slice(0, 40)}`,
    run: async (ctx, args) => {
      const name = String(args.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)
      if (!name) return 'Error: a name cannot be empty.'
      await ctx.env.DB.prepare(`UPDATE agents SET name = ? WHERE id = ?`).bind(name, ctx.agentId).run()
      ctx.broadcast?.({ type: 'agent:renamed', name })
      return `You now go by ${name}, from your next turn.`
    },
  },
]
