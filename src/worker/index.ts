import { Hono } from 'hono'
import type { Env } from './types'
import { handleScheduled } from './cron'

export { AngelDO } from './durable-object'

type AppContext = { Bindings: Env }
const app = new Hono<AppContext>()

// WebSocket upgrade → Durable Object
app.get('/ws', async (c) => {
  const id = c.env.ANGEL_DO.idFromName('angel')
  const stub = c.env.ANGEL_DO.get(id)
  return stub.fetch(c.req.raw)
})

// Health check (no auth)
app.get('/api/health', (c) => c.json({ ok: true, name: 'Angel' }))

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(handleScheduled(env, controller.cron))
  },
}
