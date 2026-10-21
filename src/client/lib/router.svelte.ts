// Angel's hash routes: the main line, a side conversation, and settings with
// its sub-pages. Deep links survive an app restart from the home screen (the
// manifest starts at /chat).
import { Router } from '$shared/lib/router.svelte'

export type SettingsSection = 'angel' | 'connectors' | 'account'

export type Route =
  | { view: 'chat' }
  | { view: 'side'; id: string }
  | { view: 'settings'; section?: SettingsSection }
  | { view: 'connector'; id: string }

const SECTIONS: SettingsSection[] = ['angel', 'connectors', 'account']

export const router = new Router<Route>({
  home: '/chat',
  parse(path) {
    const side = path.match(/^\/side\/([\w-]+)$/)
    if (side) return { view: 'side', id: side[1]! }
    if (path === '/settings') return { view: 'settings' }
    const section = path.match(/^\/settings\/(\w+)$/)?.[1] as SettingsSection | undefined
    if (section && SECTIONS.includes(section)) return { view: 'settings', section }
    const connector = path.match(/^\/settings\/connectors\/([\w-]+)$/)
    if (connector) return { view: 'connector', id: connector[1]! }
    return { view: 'chat' }
  },
})

// Where the back arrow goes from a settings page; null on the top level.
export function parentOf(route: Route): string | null {
  if (route.view === 'connector') return '/settings/connectors'
  if (route.view === 'settings' && route.section) return '/settings'
  return null
}
