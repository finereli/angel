// Angel's hash routes: the main line, a side conversation, and settings. Deep
// links survive an app restart from the home screen (the manifest starts at /chat).
import { Router } from '$shared/lib/router.svelte'

export type Route = { view: 'chat' } | { view: 'settings' } | { view: 'side'; id: string }

export const router = new Router<Route>({
  home: '/chat',
  parse(path) {
    const side = path.match(/^\/side\/([\w-]+)$/)
    if (side) return { view: 'side', id: side[1]! }
    if (path === '/settings') return { view: 'settings' }
    return { view: 'chat' }
  },
})