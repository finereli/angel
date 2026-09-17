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
]