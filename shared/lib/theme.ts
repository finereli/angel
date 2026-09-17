// pwa-kit: theme/lib/theme.ts v1
// Dark mode and accent-derived palettes for apps that let the user pick a
// colour, or that ship a dark theme.
//
// Two independent pieces:
//
// 1. Dark mode. The class must land on <html> BEFORE first paint or returning
//    users see a white flash. So the read happens in an inline script in
//    index.html <head> (copy this, it can't be imported):
//
//      <script>
//        (function(){var d=localStorage.getItem('angel.dark.v1');
//        if(d==='1'||(d===null&&matchMedia('(prefers-color-scheme: dark)').matches))
//          document.documentElement.classList.add('dark')})()
//      </script>
//
//    and setDarkMode() below keeps it in sync afterwards (localStorage,
//    class, theme-color meta). Device preference, so localStorage, never
//    the server.
//
// 2. applyAccent(hex, dark): derive a 6-stop scale (--c-50 … --c-600) from
//    one hex. Dark mode mutes saturation, lifts lightness and tints the
//    backgrounds with the hue at 14-18% L so a saturated red stays legible
//    and never neon. Sets theme-color to the dark surface in dark mode and
//    to the accent in light.

const DARK_KEY = 'angel.dark.v1'
const DARK_SURFACE = '#1e1e2e' // Catppuccin Mocha base

export function isDark(): boolean {
  return document.documentElement.classList.contains('dark')
}

export function setDarkMode(on: boolean, accentHex: string | null = null) {
  document.documentElement.classList.toggle('dark', on)
  localStorage.setItem(DARK_KEY, on ? '1' : '0')
  if (accentHex) applyAccent(accentHex, on)
  else setThemeColorMeta(on ? DARK_SURFACE : getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())
}

export function hexToHsl(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  let h = 0, s = 0
  const l = (max + min) / 2
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
    else if (max === g) h = ((b - r) / d + 2) / 6
    else h = ((r - g) / d + 4) / 6
  }
  return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)]
}

export function applyAccent(hex: string, dark: boolean = isDark()) {
  const [h, s, l] = hexToHsl(hex)
  const root = document.documentElement.style
  const set = (k: string, v: string) => root.setProperty(k, v)
  if (dark) {
    set('--c-50', `hsl(${h}, 20%, 14%)`)
    set('--c-100', `hsl(${h}, 15%, 18%)`)
    set('--c-300', `hsl(${h}, ${Math.min(s, 70)}%, 72%)`)
    set('--c-400', `hsl(${h}, ${Math.min(s, 60)}%, 58%)`)
    set('--c-500', `hsl(${h}, ${Math.min(Math.round(s * 0.65), 70)}%, ${Math.min(l + 8, 55)}%)`)
    set('--c-600', `hsl(${h}, ${Math.min(Math.round(s * 0.6), 65)}%, ${Math.min(l + 3, 48)}%)`)
  } else {
    set('--c-50', `hsl(${h}, ${Math.min(s, 100)}%, 97%)`)
    set('--c-100', `hsl(${h}, ${Math.min(s, 95)}%, 93%)`)
    set('--c-300', `hsl(${h}, ${Math.min(s, 90)}%, 76%)`)
    set('--c-400', `hsl(${h}, ${Math.min(s, 90)}%, 65%)`)
    set('--c-500', `hsl(${h}, ${s}%, ${l}%)`)
    set('--c-600', `hsl(${h}, ${s}%, ${Math.max(l - 8, 10)}%)`)
  }
  set('--accent', 'var(--c-500)')
  set('--accent-deep', 'var(--c-600)')
  set('--accent-light', 'var(--c-300)')
  set('--accent-soft', 'var(--c-100)')
  setThemeColorMeta(dark ? DARK_SURFACE : hex)
}

export function setThemeColorMeta(color: string) {
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', color)
}
