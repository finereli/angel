import { hexToHsl } from '$shared/lib/theme'

// The app icon in the person's accent. Static files cover the default; once a
// colour is picked these are drawn at runtime and swapped into the favicon, the
// home-screen icon and the manifest (which Chrome reads again at install time).

const WINGS = `<g id="left-wing"><polygon points="244,150 76,118 76,196 244,236" fill="#fff"/><polygon points="244,262 100,238 100,306 244,334" fill="MID"/><polygon points="244,360 138,346 138,404 244,420" fill="TOP"/></g><g id="right-wing"><polygon points="268,150 436,118 436,196 268,236" fill="#fff"/><polygon points="268,262 412,238 412,306 268,334" fill="MID"/><polygon points="268,360 374,346 374,404 268,420" fill="TOP"/></g>`

// Wing scale, matching logos/make-icons.py. Smaller on the maskable icon, since
// Android crops it and anything past the central 80% is lost.
export const ICON_SCALE = 0.86
export const MASKABLE_SCALE = 0.76

export function iconSvg(hex: string, opts: { maskable?: boolean; rounded?: boolean } = {}): string {
  const [h, s, l] = hexToHsl(hex)
  const bg = `hsl(${h}, ${s}%, ${Math.max(l - 8, 10)}%)`
  const mid = `hsl(${h}, ${Math.min(s, 90)}%, 76%)`
  const scale = opts.maskable ? MASKABLE_SCALE : ICON_SCALE
  // PNG icons are opaque squares (platforms round them); only the tab favicon is rounded.
  const rect = opts.rounded ? '<rect width="512" height="512" rx="112" fill="BG"/>' : '<rect width="512" height="512" fill="BG"/>'
  const body = (rect + `<g transform="translate(256 256) scale(${scale}) translate(-256 -269)">${WINGS}</g>`)
    .replaceAll('BG', bg).replaceAll('MID', mid).replaceAll('TOP', hex)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${body}</svg>`
}

function rasterize(svg: string, size: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const c = document.createElement('canvas')
      c.width = c.height = size
      c.getContext('2d')!.drawImage(img, 0, 0, size, size)
      resolve(c.toDataURL('image/png'))
    }
    img.onerror = reject
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  })
}

function link(rel: string, attrs: Record<string, string>): HTMLLinkElement {
  let el = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"][data-accent]`)
  if (!el) {
    el = document.createElement('link')
    el.rel = rel
    el.dataset.accent = ''
    document.head.appendChild(el)
  }
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  return el
}

let seq = 0
let manifestUrl: string | null = null

// Point the favicon, apple-touch-icon and manifest at an icon in this colour.
// null puts the shipped files back.
export async function applyAppIcon(hex: string | null) {
  const mine = ++seq
  if (!hex) {
    document.head.querySelectorAll('link[data-accent]').forEach(el => el.remove())
    const m = document.head.querySelector<HTMLLinkElement>('link[rel="manifest"]')
    if (m?.dataset.shipped) m.href = m.dataset.shipped
    if (manifestUrl) { URL.revokeObjectURL(manifestUrl); manifestUrl = null }
    return
  }
  try {
    const [p180, p192, p512, m512] = await Promise.all([
      rasterize(iconSvg(hex), 180), rasterize(iconSvg(hex), 192),
      rasterize(iconSvg(hex), 512), rasterize(iconSvg(hex, { maskable: true }), 512),
    ])
    if (mine !== seq) return // a newer pick overtook this one
    link('icon', { type: 'image/svg+xml', href: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(iconSvg(hex, { rounded: true })) })
    link('apple-touch-icon', { href: p180 })

    const real = document.head.querySelector<HTMLLinkElement>('link[rel="manifest"]')
    if (!real) return
    real.dataset.shipped ||= real.getAttribute('href') ?? ''
    const o = location.origin
    const manifest = {
      name: 'Angel', short_name: 'Angel', lang: 'en', dir: 'ltr',
      start_url: `${o}/chat`, scope: `${o}/`, display: 'standalone',
      background_color: '#1e1e2e', theme_color: hex,
      icons: [
        { src: p192, sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: p512, sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: m512, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    }
    if (manifestUrl) URL.revokeObjectURL(manifestUrl)
    manifestUrl = URL.createObjectURL(new Blob([JSON.stringify(manifest)], { type: 'application/manifest+json' }))
    real.href = manifestUrl
  } catch { /* the shipped icons stay */ }
}
