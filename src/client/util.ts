import { marked } from 'marked'

const renderer = new marked.Renderer()
renderer.link = ({ href, title, text }) => {
  const titleAttr = title ? ` title="${title}"` : ''
  return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`
}
marked.setOptions({ breaks: true, gfm: true, renderer })

export function renderMarkdown(content: string): string {
  try { return marked.parse(content, { async: false }) as string }
  catch { return content }
}

function utc(ts: string): Date {
  return new Date(ts.endsWith('Z') ? ts : ts + 'Z')
}

export function dayKey(ts: string): string {
  return utc(ts).toDateString()
}

export function dateLabel(ts: string): string {
  const d = utc(ts)
  const today = new Date()
  const yest = new Date()
  yest.setDate(today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === yest.toDateString()) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

export function timeLabel(ts: string): string {
  try {
    const d = utc(ts)
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  } catch { return '' }
}
