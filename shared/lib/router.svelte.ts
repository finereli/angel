// pwa-kit: router/lib/router.svelte.ts v1
// Hash routing, so the phone's back button works and a deep link survives an
// app restart from the home screen. No library: the whole thing is a parse
// function the app supplies plus a few history rules that are easy to get
// wrong.
//
//   // src/lib/router.svelte.ts
//   import { Router } from '$shared/lib/router.svelte'
//   type Route = { view: 'library' } | { view: 'about' } | { view: 'play'; id: string }
//   export const router = new Router<Route>({
//     home: '/',
//     parse(path) {
//       const play = path.match(/^\/play\/([\w-]+)$/)
//       if (play) return { view: 'play', id: play[1] }
//       if (path === '/about') return { view: 'about' }
//       return { view: 'library' }
//     },
//   })
//   router.start()
//
// Then read `router.route.view` etc. in components. Rules baked in:
//   - `replace()` for sequential navigation within a list (skipping through
//     five items must not leave five entries to back out of)
//   - `back()` falls back to home when there is no history (cold deep link)
//   - unknown paths resolve to whatever parse() returns for them - make it home
//   - the drawer/overlay closes on any navigation: subscribe with onChange()

export class Router<R extends object = Record<string, unknown>> {
  route = $state({}) as R
  #parse: (path: string) => R | null | undefined
  #home: string
  #listeners: Array<(r: R) => void> = []

  constructor({ parse, home = '/' }: { parse: (path: string) => R | null | undefined; home?: string }) {
    this.#parse = parse
    this.#home = home
  }

  start() {
    const apply = () => {
      const path = location.hash.replace(/^#/, '') || this.#home
      this.route = (this.#parse(path) ?? this.#parse(this.#home)) as R
      for (const fn of this.#listeners) fn(this.route)
    }
    apply()
    addEventListener('hashchange', apply)
  }

  onChange(fn: (r: R) => void) { this.#listeners.push(fn) }

  go(path: string) { location.hash = path }

  // Replace rather than push, so skipping through five items doesn't leave
  // five entries to back out of.
  replace(path: string) {
    history.replaceState(null, '', `#${path}`)
    this.route = (this.#parse(path) ?? this.#parse(this.#home)) as R
  }

  back(fallback: string = this.#home) {
    if (history.length > 1) history.back()
    else location.hash = fallback
  }
}
