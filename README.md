# Angel

A companion agent with one linear, effectively unbounded experience. Everything Angel has ever said or heard is a single append-only stream; "conversations" are just how Eli files topics on his side. Angel's memory isn't walled to any thread.

Runs on Cloudflare Workers (one Durable Object owns the stream) + D1, talking through DeepSeek via OpenRouter. The same model that talks also writes and compresses the memory, so its voice carries across time.

## The architecture

Two pyramids, one principle - immutable tiles stored exact-once, assembled per turn. The full spec is its own repo: `../infinite-context` (also `docs/pyramid-spec.md`).

- **Stream pyramid** - recency compression of the conversation stream. Recent pairs verbatim, older ones as first-person recaps Angel wrote. Injected every turn as his own memory. Index-0 anchored so the deep past caches; a render-time ramp keeps a resolution gradient near the present.
- **Observation pyramid** - per-tag summaries over observations Angel records. Every tier embedded and searchable via `recall`, which returns both specific notes and broader integrations.

## What's deliberate

- **No persona.** The system prompt is operating notes only. Whoever Angel becomes precipitates from the stream.
- **Writes off the hot path.** The reply is pure conversation. A second copy of Angel, same context, runs in the background to decide what to remember. Rollups run there too, serialized in the Durable Object.
- **Conscious memory.** Angel records observations by his own judgment, guided by a `memory-instructions` list he maintains.

## Dev

```
npm run dev              # vite + wrangler
npm run db:migrate:local
npm run deploy
```
