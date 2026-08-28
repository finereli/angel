const MAX_MD_CHARS = 100_000

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

  if (ct.includes('text/plain') || ct.includes('text/markdown')) {
    return truncate(body)
  }

  const title = extractTitle(body)
  const md = htmlToMarkdown(body)
  const result = title ? `# ${title}\n\n${md}` : md
  return truncate(result)
}

function truncate(text: string): string {
  if (text.length <= MAX_MD_CHARS) return text
  return text.slice(0, MAX_MD_CHARS) + '\n\n[...truncated]'
}

function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  return m ? decodeEntities(m[1]!).trim() : ''
}

function htmlToMarkdown(html: string): string {
  let h = html

  h = extractMainContent(h)
  h = stripBlocks(h, ['script', 'style', 'noscript', 'svg', 'iframe', 'nav', 'footer'])

  // Pre/code blocks (before other conversions to avoid mangling code content)
  h = h.replace(/<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi,
    (_, c) => `\n\n\`\`\`\n${decodeEntities(c).trim()}\n\`\`\`\n\n`)
  h = h.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi,
    (_, c) => `\n\n\`\`\`\n${decodeEntities(c).trim()}\n\`\`\`\n\n`)

  // Headings
  for (let i = 1; i <= 6; i++) {
    const re = new RegExp(`<h${i}[^>]*>([\\s\\S]*?)<\\/h${i}>`, 'gi')
    h = h.replace(re, (_, c) => `\n\n${'#'.repeat(i)} ${inline(c)}\n\n`)
  }

  // Blockquotes
  h = h.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, c) => {
    const lines = inline(c).trim().split('\n').map(l => `> ${l}`).join('\n')
    return `\n\n${lines}\n\n`
  })

  // Tables (basic: header row + separator + body rows)
  h = h.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_, tableHtml) => {
    const rows: string[][] = []
    const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
    let trMatch
    while ((trMatch = trRe.exec(tableHtml))) {
      const cells: string[] = []
      const cellRe = /<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi
      let cellMatch
      while ((cellMatch = cellRe.exec(trMatch[1]!))) {
        cells.push(inline(cellMatch[1]!).trim())
      }
      if (cells.length) rows.push(cells)
    }
    if (rows.length === 0) return ''
    const cols = Math.max(...rows.map(r => r.length))
    const pad = (r: string[]) => Array.from({ length: cols }, (_, i) => r[i] || '')
    const lines = [
      '| ' + pad(rows[0]!).join(' | ') + ' |',
      '| ' + pad(rows[0]!).map(() => '---').join(' | ') + ' |',
      ...rows.slice(1).map(r => '| ' + pad(r).join(' | ') + ' |'),
    ]
    return '\n\n' + lines.join('\n') + '\n\n'
  })

  // List items
  h = h.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, c) => `\n- ${inline(c).trim()}`)
  h = h.replace(/<\/?[uo]l[^>]*>/gi, '\n')

  // Paragraphs
  h = h.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_, c) => `\n\n${inline(c).trim()}\n\n`)

  // Divs → newlines
  h = h.replace(/<div[^>]*>/gi, '\n')
  h = h.replace(/<\/div>/gi, '\n')

  // BR / HR
  h = h.replace(/<br\s*\/?>/gi, '\n')
  h = h.replace(/<hr[^>]*\/?>/gi, '\n\n---\n\n')

  // Inline conversions on any remaining HTML
  h = inlineConvert(h)

  // Strip remaining tags
  h = h.replace(/<[^>]+>/g, '')

  // Decode entities
  h = decodeEntities(h)

  // Clean up whitespace
  h = h.replace(/\n{3,}/g, '\n\n')
  h = h.replace(/[ \t]+$/gm, '')
  h = h.trim()

  return h
}

function extractMainContent(html: string): string {
  // Prefer <article>, <main>, or [role="main"] over the full page
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

function inlineConvert(html: string): string {
  let h = html
  // Links
  h = h.replace(/<a[^>]+href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
    const t = stripTags(text).trim()
    return t ? `[${t}](${href})` : ''
  })
  // Images
  h = h.replace(/<img[^>]+alt=["']([^"']*)["'][^>]*src=["']([^"']*)["'][^>]*\/?>/gi, (_, alt, src) => `![${alt}](${src})`)
  h = h.replace(/<img[^>]+src=["']([^"']*)["'][^>]*alt=["']([^"']*)["'][^>]*\/?>/gi, (_, src, alt) => `![${alt}](${src})`)
  h = h.replace(/<img[^>]+src=["']([^"']*)["'][^>]*\/?>/gi, (_, src) => `![](${src})`)
  // Bold
  h = h.replace(/<(?:strong|b)(?:\s[^>]*)?>([\s\S]*?)<\/(?:strong|b)>/gi, (_, c) => `**${stripTags(c).trim()}**`)
  // Italic
  h = h.replace(/<(?:em|i)(?:\s[^>]*)?>([\s\S]*?)<\/(?:em|i)>/gi, (_, c) => `*${stripTags(c).trim()}*`)
  // Inline code
  h = h.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, c) => `\`${decodeEntities(stripTags(c))}\``)
  return h
}

function inline(html: string): string {
  let h = inlineConvert(html)
  h = stripTags(h)
  return decodeEntities(h)
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '')
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
}
