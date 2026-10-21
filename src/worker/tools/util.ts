import type { Tool } from './registry'

export const utilTools: Tool[] = [
  {
    def: {
      type: 'function',
      function: {
        name: 'current_time',
        description: 'Get the current date and time in UTC and, when known, the person\'s local timezone.',
        parameters: { type: 'object', properties: {} },
      },
    },
    label: ['Checking time', 'Checked time'],
    run: async (ctx) => {
      const now = new Date()
      const utc = now.toISOString()
      const tz = ctx.env.USER_TZ
      if (!tz) return `UTC: ${utc}\n(Their timezone isn't known yet.)`
      const local = now.toLocaleString('en-US', {
        timeZone: tz,
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
      })
      return `UTC: ${utc}\nTheir local time (${tz}): ${local}`
    },
  },
]
