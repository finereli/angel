import { NodeHtmlMarkdown } from 'node-html-markdown'

const MAX_MD_CHARS = 100_000
const STRIP_TAGS = ['script', 'style', 'noscript', 'svg', 'iframe', 'nav', 'footer']

const nhm = new NodeHtmlMarkdown({
  keepDataImages: false,
  useLinkReferenceDefinitions: false,
  useInlineLinks: true,
})

export function looksLikeHtml(text: string): boolean {
  const head = text.slice(0, 500)
  return /^\s*<!doctype\s+html/i.test(head) || /^\s*<html[\s>]/i.test(head) || /<head[\s>]/i.test(head)
}

export function htmlToMarkdown(html: string, fallbackTitle?: string): string {
  const title = extractTitle(html) || fallbackTitle
  const content = extractMainContent(html)
  const clean = stripBlocks(content, STRIP_TAGS)
  const md = nhm.translate(clean)
  const result = title ? `# ${title}\n\n${md}` : md
  return truncate(result)
}

export async function fetchPage(url: string): Promise<string> {
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; Angel/1.0)',
      'Accept': 'text/html,text/plain,text/markdown,*/*',
    },
    redirect: 'follow',
  })

  if (!resp.ok) return `Failed to fetch: ${resp.status} ${resp.statusText}`

  const ct = resp.headers.get('content-type') || ''
  const body = await resp.text()

  if (ct.includes('text/plain') || ct.includes('text/markdown') || ct.includes('application/json')) {
    return truncate(body)
  }

  return htmlToMarkdown(body)
}

function truncate(text: string): string {
  if (text.length <= MAX_MD_CHARS) return text
  return text.slice(0, MAX_MD_CHARS) + '\n\n[...truncated]'
}

function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (!m) return ''
  return m[1]!.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim()
}

function extractMainContent(html: string): string {
  for (const re of [
    /<article[^>]*>([\s\S]*)<\/article>/i,
    /<main[^>]*>([\s\S]*)<\/main>/i,
    /<[^>]+role=["']main["'][^>]*>([\s\S]*?)<\/\w+>/i,
  ]) {
    const m = html.match(re)
    if (m) return m[1]!
  }
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)
  return body ? body[1]! : html
}

function stripBlocks(html: string, tags: string[]): string {
  let h = html
  for (const tag of tags) {
    h = h.replace(new RegExp(`<${tag}[\\s>][\\s\\S]*?<\\/${tag}>`, 'gi'), '')
    h = h.replace(new RegExp(`<${tag}[^>]*/?>`, 'gi'), '')
  }
  return h
}
