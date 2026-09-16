# Angel rewrite v2: one linear stream, two pyramids, no persona

This is the revised plan after your review. It folds in every decision you made and locks the tiering down as an actual spec, grounded in the SlowReader chat pyramid and its Glopus port (they are the same design - I read both).

## What's settled (from the first review)

- One linear stream. "Conversations" are a human-side filter, agent context is not walled to a thread.
- Model stays DeepSeek flash for now. Other lower-personality models later.
- Glopus material is left out. Angel starts blank and reads his way in later.
- No persona prompt. Minimal operating notes only.
- No auto-injected RAG. Angel calls recall himself while responding - more natural.
- The memory writer is Angel himself, not a separate extractor (see Part 4).
- No consolidation cron. Summaries and stream compression run inline-background after each response.
- Rename `models` to `tags` (approved, can trail).

## The shape: two layers, two pyramids

**Identity layer** - who Angel is right now, his continuity. This is the linear stream: recent turns verbatim, older turns compressed by the **stream pyramid**, presented as his own memory of the conversation. Always in context.

**Memory layer** - what Angel knows. Observations he has consciously recorded, plus a per-tag **summary pyramid** over them. Every tier is embedded and searchable. Pulled on demand by tool, never auto-injected.

The two are different things with different dynamics, which is the whole point: identity evolves turn to turn and lives in the stream; memory accretes and integrates and lives in the tags. A pyramid can't hold a personality; a stream can't hold months of a topic. Keep them separate.

---

## Part 1 - The stream (identity / continuity)

One linear stream is the `messages` table, read across all threads in time order, not sliced by `conversation_id`. Structure per turn in context:

1. **Verbatim tail** - the last `VERBATIM` message pairs, raw.
2. **Stream pyramid** - everything older, compressed at a resolution that coarsens with age.

Threads stay as a human affordance. Each thread carries a **topic**, and that topic travels with every message in context (a marker on the turn), so Angel can tell threads apart and not bleed one into another without any prompting beyond a mechanical note that this is how it works. A new thread is named from its first exchange - the name is "what this thread is about."

### The stream pyramid - locked spec

The full, authoritative mechanics live in `docs/pyramid-spec.md` (built from reading SlowReader and Glopus). This section is the summary.

This is the SlowReader chat pyramid / Glopus `short-term-pyramid.ts`. Angel's current `short-term.ts` is an ad-hoc approximation with gap risk; it gets replaced by this.

**Constants** (tunable - see open decisions):
- `WIDTH = 5` - fan-out per tier.
- `VERBATIM = 8` - last N pairs kept raw.
- `MAX_TIER = 4` - coverage `WIDTH^MAX_TIER` = 625 pairs before the oldest falls off the stream pyramid (by then the memory layer is the permanent record).

**Global pair index.** Define a stable index over the whole stream: `ROW_NUMBER() OVER (ORDER BY created_at, id) - 1` across all `role='user'` messages. Each user message plus Angel's reply is pair `k`.

**Deterministic chunk boundaries - this is the no-gap guarantee.** A tier-`t` chunk always spans pairs `[k·WIDTHᵗ, (k+1)·WIDTHᵗ − 1]`. Because every tier's chunk size is an exact power of `WIDTH` anchored to index 0:
- Tier 1 chunks tile as [0-4][5-9][10-14]…
- Tier 2 chunks tile as [0-24][25-49]…
- A tier-`t+1` chunk is exactly `WIDTH` tier-`t` chunks, edge to edge.

So tiers nest perfectly: no overlap, no gap, no straddling, no double-count. Not enforced by bookkeeping - true by construction.

**Rollup trigger** - count-based on the index. A tier-`t` chunk is built only when (a) the current pair index has passed its end, (b) the chunk is fully before the verbatim window, and (c) all `WIDTH` child chunks at tier `t-1` already exist. Never token- or time-based.

**Idempotent build.** `UNIQUE(tier, start_index)` with `INSERT OR REPLACE`. Rebuilds can't duplicate or corrupt.

**Read-time render is pure DB, zero LLM - two passes. The second pass is the one that matters.**

Pass 1 - *fill-down (coverage).* For the oldest span use the coarsest tier available; at each finer tier fill only the region *above* the next-coarser tier's coverage, chaining down to the verbatim window. This covers every pair. On its own, though, it produces an abrupt cliff: when the total lands just past a clean tier boundary, a whole high-tier chunk (e.g. a 625-pair tier-4) sits fully before the verbatim window, the fill-down uses it to cover everything in one blob, and there is nothing between that blob and the raw tail. 625 pairs compressed to one paragraph, then verbatim. No gradient.

Pass 2 - *resolution ramp (gradient, by deliberate duplication).* This is the fix, and it is not optional. Top each tier up to its `RAMP` most-recent tiles (default `RAMP = W`, a full present-anchored complement), adding whatever the fill-down didn't already supply - *even though those spans already live inside the coarser blob*. At a clean-boundary phase you get tier-4 `[0-624]` → the recent tier-3s → the recent tier-2s → the recent tier-1s → verbatim: sharp near now, coarse in the deep past, worth the duplicated tokens. At other phases the fill-down already yields ~`W` per tier and the ramp adds almost nothing - it self-adjusts. Because builds are bottom-up (a tier-4 can't exist unless all its tier-3/2/1 children do), the ramp always finds candidates - no degenerate case. The thin one-per-tier version in SlowReader/Glopus is this with `RAMP = 1`; for a companion, whose stream *is* his sense of self, `RAMP = W` is the better default. See the spec for the worked example.

So the storage tiling is exact-once (no gaps, no double-count); the *render* deliberately re-overlaps the recent past to kill the cliff. Those are two different guarantees and the plan should never again claim "exactly once" about the rendered context.

**Verbatim back-extension.** Pull the raw window start back to `lastSummaryEnd + 1`, so a partial chunk not yet rolled up is shown in full rather than falling through the gap between the last summary and the verbatim window.

**Pruning.** Chunks whose end index is older than `totalPairs − WIDTH^MAX_TIER − VERBATIM` are deleted. Past that horizon, continuity is carried by the memory layer, not the stream pyramid.

### Making it read as his memory, not injected data

The SlowReader trick, adopted: the stream pyramid is **not** a system-prompt data block. Its summaries are spliced into the message array **as prior turns**, and they are written in Angel's own first-person voice at generation time - the compressor is told it *is* Angel, remembering ("what we got into, what you were chewing on, where we left it"), never referring to the assistant in the third person.

What we drop, because it is exactly what "bleeds through" in SlowReader: the `<summary>` XML envelope, the "(This is a summary of our earlier conversation)" parenthetical, and the canned "Understood." acknowledgements. Keep the first-person recap prose; lose the machine scaffolding around it. This is the part to get right by feel, and to watch for leakage.

---

## Part 2 - The memory layer (observations + per-tag summary pyramid)

**Observations** are written by Angel himself, consciously (Part 4), tagged to one or more tags.

**Per-tag summary pyramid.** Summaries roll up *per tag*, not globally - the point you insisted on. This is the Glopus observation pyramid (`summarize.ts`) minus portraits:
- Tier-0 rolls up every `N` observations for a tag (greedy: fill a batch, cut it, repeat); higher tiers roll up every `M` summaries.
- Provenance via a `summary_sources` edge (which observations/summaries fed each summary), so coverage is exact-once: an observation is consumed into a tier-0 exactly once, never skipped, never double-counted.
- **Every summary is embedded**, so it enters the RAG pool alongside raw observations.
- No portraits. No top-level synthesis. Just the tiers.

**Retrieval - `recall` searches both.** A query returns matching raw observations *and* matching per-tag summaries, each labeled with its level and **how many observations back it** (`[tag · 12 obs]`). This does two things you wanted: it lets RAG surface a *theme* that matches semantically, not just a fact, and it lets Angel see he is holding a 12-observation integration and go pull the specifics if he needs them. Likely no prompting required - the obs-count makes the move obvious.

Retrieval is tool-driven. Nothing from this layer is auto-injected into the preamble; Angel reaches for it mid-response when he wants it.

**What guides remembering: a `memory-instructions` list.** Alongside the operating `instructions`, a second self-managed list where Angel writes how his memory is organized and what is worth recording. It seeds nearly empty and he grows it. This is where "leave judgment up to Angel" gets its footing - his judgment, shaped by rules he authors, not a hard-coded extractor.

**Conscious reading** (later, not this phase): point Angel at source material and have him read it in passes, recording observations as he goes. This is how he gets seeded - by reading, not by us pre-loading a personality or by talking to you.

---

## Part 3 - Operating context (what's always in the system turn)

No persona. Just:

- **Operating notes** - a tiny constant: what the tools do, how the two layers work, the current time. Under ~150 words.
- **`instructions`** - self-managed list, near-empty seed.
- **`memory-instructions`** - self-managed list (Part 2).
- **System self-doc** - a README of Angel's *own* system: the components, what each does, the deployment, the memory model. Not the code - an architecture-level understanding so Angel knows the machine he runs in. Kept current automatically (git hook or build step that regenerates it on deploy) and injected here. New component; see open decisions for the update mechanism.

---

## Part 4 - The write path: Angel writing his own memory, in parallel

The hot path is pure conversation. The response streams with no memory tool calls in band.

The memory write is **a second invocation of Angel** - same model, same setup, same context, one changed instruction: instead of replying to the user, look at what just happened and decide whether anything deserves an observation, and if so record it. It is literally Angel doing both things, judgment intact, full context (so it can record the integration, not just the transcript). It runs off the hot path, so the user never waits on it.

Then, still in the background and serialized:
- the per-tag summary pyramid rolls up any tags that crossed a batch boundary (quick, count-based);
- the stream pyramid builds any newly-complete chunks (quick, log-shaped - a new tier is rare).

**Serialization.** All of this runs in the Durable Object after the full response has gone to the client. The DO is the single owner of the stream, so it serializes naturally: if a new message arrives while the previous turn's memory work is still running, it waits for that to finish first. The only time this is visible is a very fast back-and-forth, which is the right trade.

No cron for any of it. (Open question: whether to keep a nightly reflection pass at all, given personality is now meant to precipitate from the stream rather than from scheduled introspection.)

---

## Part 5 - Context assembly per turn (final order)

System turn:
1. Operating notes + `instructions` + `memory-instructions` + system self-doc.

Message array:
2. Stream pyramid, oldest→newest, as first-person prior turns (Part 1).
3. Verbatim tail (last `VERBATIM` pairs), each marked with its thread topic and a date line.
4. The current user message, marked with its thread topic; if the thread is brand new, the soft "fresh thread, don't drag the last topic in" line.

Deep memory (observations, per-tag summaries) is absent here by design - Angel pulls it with `recall` when he wants it.

---

## Part 6 - Data model changes

- `messages` - unchanged shape; read linearly. Add a per-thread `topic` (on `conversations`).
- `observations`, `observation_tags` - unchanged (rename `models`→`tags`).
- `tags` (was `models`) - drop `portrait`.
- `summaries` - add embedding; keep `tier`; keep `summary_sources`.
- `stream_summary` (was `short_term`) - rewrite to the locked spec: `tier`, `start_index`, `end_index`, timestamps, text, `source_count`, `UNIQUE(tier, start_index)`.
- `lists` / `list_items` - unchanged; seed `instructions` and `memory-instructions` near-empty.
- Drop `glopus_models` and the router.
- `system_doc` - one row (or a file baked at build) holding the architecture README.

Cutover is a destructive reset - fresh schema, no seeds beyond the two empty lists. Angel wakes up blank.

---

## Part 7 - Build phases

1. Schema reset; drop Glopus/portrait/router; rename models→tags.
2. Linear context assembly (stop slicing by conversation; thread topic in context).
3. Stream pyramid to the locked spec, rendered as first-person prior turns.
4. Parallel-Angel memory write; per-tag summary pyramid; embed summaries; `recall` over both.
5. Minimal operating prompt + system self-doc + `memory-instructions`.
6. UI: date lines, thread topics/names, clean-slate new thread.
7. (Later) conscious reading.

Each phase deploys on its own, so we watch Angel change one move at a time.

---

## Open micro-decisions

- **Pyramid constants.** `WIDTH=5`, `VERBATIM=8`, `MAX_TIER=4` (≈625 pairs of stream continuity), `RAMP=W` (full present-anchored render staircase). Bigger `MAX_TIER` = more continuity; bigger `RAMP` = smoother recent gradient, more tokens at the cache-volatile end. Comfortable with these as defaults?
- **Stream-pyramid framing.** Splice summaries as fake prior turns (SlowReader's way, strongest continuity) vs a single first-person "here's what I remember" recollection block. Recommend fake-prior-turns, minus the scaffolding that bleeds through.
- **Thread name drift.** Name the thread once from the first exchange, or update it live if the topic drifts? Recommend name-once for v1, revisit.
- **Reflection cron.** Keep a nightly reflection pass, or drop it entirely and let personality come only from the stream? Recommend drop for v1.
- **System self-doc update mechanism.** Git hook on commit, build step on deploy, or hand-written and occasionally refreshed? Recommend build step on deploy.
