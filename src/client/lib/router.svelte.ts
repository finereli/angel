// Angel's hash routes: the one conversation, and settings. Deep links survive an
// app restart from the home screen (the manifest starts at /chat).
import { Router } from '$shared/lib/router.svelte'

export type Route = { view: 'chat' } | { view: 'settings' }

export const router = new Router<Route>({
  home: '/chat',
  parse(path) {
    return path === '/settings' ? { view: 'settings' } : { view: 'chat' }
  },
})