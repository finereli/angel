// Light, dark or follow the device. One rune state shared by the sidebar's
// toggle and the Theme page, so they never disagree. The choice is per device
// (localStorage, like the kit's dark mode); "device" is no stored value at all,
// which is what index.html's first-paint script already reads as "ask the OS".
import { isDark, setDarkMode } from '$shared/lib/theme'
import { storedAccent } from './accent'

export type Mode = 'light' | 'dark' | 'device'

const KEY = 'angel.dark.v1' // shared with index.html and the kit's setDarkMode
const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null

function readMode(): Mode {
  try {
    const v = localStorage.getItem(KEY)
    return v === '1' ? 'dark' : v === '0' ? 'light' : 'device'
  } catch {
    return 'device'
  }
}

class Appearance {
  mode = $state<Mode>(readMode())
  dark = $state(isDark())
  // The accent to re-derive for the new mode (the saved one, else this device's cache).
  accent: () => string | null = storedAccent

  constructor() {
    media?.addEventListener('change', () => {
      if (this.mode === 'device') this.#apply(media.matches)
    })
  }

  set(mode: Mode) {
    this.mode = mode
    this.#apply(mode === 'device' ? !!media?.matches : mode === 'dark')
    if (mode === 'device') {
      try { localStorage.removeItem(KEY) } catch { /* private mode */ }
    }
  }

  // The sidebar's one-tap switch: always to an explicit light or dark.
  toggle() {
    this.set(this.dark ? 'light' : 'dark')
  }

  #apply(on: boolean) {
    this.dark = on
    setDarkMode(on, this.accent())
  }
}

export const appearance = new Appearance()
