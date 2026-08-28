import type { Tool } from './registry'

export const utilTools: Tool[] = [
  {
    def: {
      type: 'function',
      function: {
        name: 'current_time',
        description: 'Get the current date and time in UTC and Eli\'s local timezone.',
        parameters: { type: 'object', properties: {} },
      },
    },
    label: ['Checking time', 'Checked time'],
    run: async () => {
      const now = new Date()
      const utc = now.toISOString()
      const local = now.toLocaleString('en-US', {
        timeZone: 'Asia/Jerusalem',
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
      })
      return `UTC: ${utc}\nEli's local time (Israel): ${local}`
    },
  },
]
