# Angel memory spec (locked)

The one place the memory mechanics are written down exactly. Two pyramids share one principle; the details differ. Where a number is a knob, it says so.

References this is distilled from: SlowReader `app/lib/models/reading_log.dart` + `chat_summary.dart` (the chat pyramid), Glopus `server/short-term-pyramid.ts` (its port) and `server/summarize.ts` (the observation pyramid).

---

## 0. The principle

Memory is stored as fixed, immutable tiles and *assembled* per turn. Storage is exact-once and stable so it caches. The render deliberately re-overlaps recent tiles to produce a resolution gradient. Those are two different jobs with two different guarantees, and conflating them is the bug that produces a cliff.

Two pyramids:

- **Stream pyramid** - continuity / identity. Compresses the linear conversation stream (all threads) by recency. Injected every turn as Angel's own memory of the conversation. Not embedded, not searched.
- **Observation pyramid** - knowledge / memory. Compresses Angel's recorded observations per tag. Every tier embedded and searchable. Pulled on demand by tool, never auto-injected.

---

## 1. The stream pyramid

### 1.1 Unit and index

The unit is a **message pair** (one user message plus Angel's reply). The **global pair index** is stable and anchored at 0:

```
pairIndex(userMessage) = ROW_NUMBER() OVER (ORDER BY created_at, id) - 1
                         over all messages WHERE role = 'user'
```

Anchored at 0, never at the present. This is what makes the tiles immutable and cacheable. It is also what makes the recent gradient drift against the grid, which section 1.6 handles.

### 1.2 Constants

| name | default | meaning | knob? |
|---|---|---|---|
| `W` | 5 | fan-out per tier: a tier-`t` tile = `W` tier-`(t-1)` tiles | yes |
| `V` | 8 | pairs kept verbatim at the tail | yes |
| `MAX_TIER` | 4 | highest tier built; one tile spans `W^4` = 625 pairs | yes |
| `RAMP` | `W` | target most-recent tiles per tier in the render gradient | yes |

### 1.3 Storage tiling (exact-once, provably gap-free)

A tier-`t` tile always spans pairs `[k·Wᵗ, (k+1)·Wᵗ − 1]` for integer `k`. Tiles are keyed `(tier, start_index)`, unique.

**No-gap / no-double-count proof.** Because `W^(t+1) = W · W^t`, the boundaries of the tier-`(t+1)` grid are a subset of the tier-`t` grid, and each tier-`(t+1)` tile is the union of exactly `W` consecutive tier-`t` tiles with the *same* outer edges. So every tier-`t` tile sits fully inside exactly one tier-`(t+1)` tile - never straddling two. By induction from tier 0, at every level the tiles partition the index axis with no gap and no overlap. This is a property of the boundary arithmetic, not of any bookkeeping.

This exact-once guarantee is about **storage only**. The render (1.6) intentionally violates it near the present.

### 1.4 Build

Count-based, bottom-up, idempotent, background.

- A tier-`t` tile `[s, s+Wᵗ−1]` is built only when (a) it lies fully before the verbatim window (`s + Wᵗ − 1 < verbatimStart`), and (b) all `W` of its tier-`(t-1)` children exist. Tier-0 is the raw pair (never stored as a summary; it's the verbatim tail or a tier-1 input).
- Bottom-up means a tier-`t` tile can only exist if its whole subtree exists. So whenever any tier exists, all finer tiers beneath it exist too - the render's ramp can always find candidates.
- Idempotent: `INSERT OR REPLACE` on `UNIQUE(tier, start_index)`. Rebuilds can't duplicate or corrupt.
- Compression is one small LLM call per tile (see 4.1). Log-shaped: a new tier-1 tile every `W` pairs, tier-2 every `W²`, so builds are rare and cheap.

### 1.5 Prune

Storage is cheap and the render self-limits (it only ever pulls the `RAMP` most-recent tiles per tier), so pruning is optional. If enabled, delete tiles whose `end_index < totalPairs − keepFactor·W^MAX_TIER − V`. Default `keepFactor = 2` so a couple of top tiles survive for long relationships. Anything older than the stream pyramid is carried by the observation pyramid, which is the permanent record.

### 1.6 Render (the important part)

Pure DB, zero LLM. Produces `(summaries oldest→newest, verbatim tail)`.

```
total        = totalPairs()
if total == 0: return empty
verbatimStart = total - V
verbatimStart = pull back so it starts on a user message (never split a pair)

# ---- Pass 1: coverage (fill-down, non-overlapping) ----
# Guarantees every pair in [0, verbatimStart) is represented at least once.
result   = []
fillUntil = verbatimStart - 1
for t in 1 .. MAX_TIER:
    nextTierEnd = max end_index of built tier-(t+1) tiles, or -1
    band = tier-t tiles where start_index > nextTierEnd and end_index <= fillUntil
    result += band
    fillUntil = nextTierEnd
    if fillUntil < 0: break
topTier = highest tier present in result

# ---- Pass 2: gradient (ramp, overlap intended) ----
# Top each tier up to its RAMP most-recent tiles. Emulates a present-anchored
# staircase using immutable tiles. Duplication with Pass 1 is expected: at a
# clean-boundary phase it is the ONLY way to show a gradient (see 1.6.1).
for t in 1 .. topTier:
    have = count of tier-t tiles already in result
    if have < RAMP:
        recent = tier-t tiles with end_index < verbatimStart, not already in result,
                 sorted by start_index descending
        add the first (RAMP - have) of recent to result

dedup result by (tier, start_index)
sort result by (start_index asc, tier desc)   # oldest first; coarse before fine at a tie

# ---- Verbatim back-extension ----
lastEnd       = max end_index in result, or -1
verbatimStart = max(verbatimStart, lastEnd + 1)   # show any not-yet-summarized partial chunk in full
verbatim      = pairs[verbatimStart .. total-1]

return (result, verbatim)
```

#### 1.6.1 Why Pass 2 must duplicate - the cliff, worked

`W=5, V=8, MAX_TIER=4`. Take `total = 633`, so `verbatimStart = 625`, a clean tier-4 boundary.

Built tiles include tier-4 `[0-624]`, five tier-3 tiles tiling `[0-624]`, and so on down. Pass 1 (fill-down) sets `fillUntil = 624`; at every tier `nextTierEnd` is already `624` (the coarser tier reaches the edge), so each finer tier finds nothing to add. Pass 1 returns a single tile: tier-4 `[0-624]`. That against the raw tail is the cliff - 625 pairs in one paragraph, then verbatim, nothing between.

Pass 2 tops up: tier-1 to its 5 most-recent tiles (`[600-604]…[620-624]`), tier-2 to 5 (`[500-524]…[600-624]`), tier-3 to 5, tier-4 already has 1. Sorted, the render reads: tier-4 overview `[0-624]` → tier-3 tiles → the recent tier-2 tiles → the recent tier-1 tiles → verbatim. A full staircase, sharp near now, coarse in the deep past. The tier-1/2/3 tiles near the present duplicate spans already inside the tier-4 blob - and that duplication is the only grid-aligned way to produce a gradient at this phase. At non-clean phases Pass 1 already yields ~`W` per tier and Pass 2 adds almost nothing; the render self-adjusts.

### 1.7 Caching

Render oldest→newest, always. Then:

- The deep-past coarse tiles are immutable across turns (same `(tier, start_index)`, same text), so they form a byte-identical prefix that the model cache keeps.
- Volatility is confined to the recent fine staircase and the verbatim tail - the very end, next to the current message, which is uncacheable anyway.

Present-anchoring would re-cut every tile every turn and cache nothing. Index-0 plus oldest-first ordering is what buys the cache. This is the entire reason for the awkward drifting-phase render.

### 1.8 Making it read as memory, not data

The stream pyramid is **not** a labeled data block in the system prompt. Its tiles are spliced into the message array as **prior turns**, and each tile's text is written first-person at build time - the compressor is told it *is* Angel, remembering ("what we got into, what you were turning over, where we left it"), never referring to the assistant in the third person.

Drop the scaffolding that gives it away in SlowReader: no `<summary>` XML envelope, no "(this is a summary of our earlier conversation)" note, no canned "Understood." acknowledgements. Keep the first-person recap prose, lose the wrapper. Watch for leakage; this is the one part tuned by feel, not by rule.

---

## 2. The observation pyramid

### 2.1 Unit and tags

The unit is an **observation** - a note Angel records in his own voice (section 3), tagged to one or more **tags** (the renamed `models`, minus portraits). Summaries roll up **per tag**, never globally.

### 2.2 Build (greedy, exact-once by provenance)

Unlike the stream pyramid, observations arrive per-tag at irregular counts, so tiles are not index-aligned; they're greedy batches with explicit provenance.

- Tier-0: when a tag has `≥ OBS_BATCH` (default 10) unsummarized observations, take them in arrival order and summarize into a tier-0 tile.
- Tier-`t+1`: when a tag has `≥ SUM_BATCH` (default 5) unsummarized tier-`t` tiles, summarize into a tier-`(t+1)` tile.
- Exact-once is enforced by a `summary_sources` edge (which observations/summaries fed each tile). "Unsummarized" = items minus those already appearing as a source. An item is consumed exactly once and never skipped.

### 2.3 Embedding and retrieval

- Every observation **and every summary tile** is embedded and enters the RAG pool.
- `recall(query)` returns matching observations *and* matching summary tiles, each labeled with its level and its backing count: `[tag · tier-2 · 37 obs]`. This lets a query match a *theme* (a summary), not only a fact (an observation), and lets Angel see he is holding a 37-observation integration and go pull specifics if he needs them. No prompting required; the count makes the move obvious.
- Retrieval is tool-driven. Nothing from this pyramid is auto-injected into the turn.

### 2.4 No portraits

No top-level per-tag synthesis. The tiers are the memory. (Portraits were a fixed injected artifact; here Angel assembles what he needs from search each time.)

---

## 3. Where it runs, and who writes it

Everything below runs **inside the Durable Object**, which is the single owner of the stream and therefore serializes naturally.

- **Response pass (hot):** Angel replies. No memory tool calls in band; the stream is pure conversation.
- **Memory pass (parallel, off the hot path):** a *second invocation of Angel* - same model, same context, one changed instruction: instead of replying, look at what just happened and record any observation worth keeping, tagged. Full context, Angel's own judgment, guided by the self-managed `memory-instructions` list. Runs after the reply has streamed to the client, in `waitUntil`.
- **Rollups (background, serialized):** after the memory pass, roll up any per-tag observation tiles that crossed a batch boundary, and build any newly-complete stream tiles. If a new user message arrives while this is running, it waits for the rollup to finish first. Only visible on a very fast back-and-forth.

No cron for any of this.

---

## 4. LLM prompts

### 4.1 Stream compressor (first-person, warm)
"You are Angel. Write a short recap of this stretch of conversation in your own voice, so you can remember it later. Say what you and Eli got into, what he was turning over, what shifted, where you left it. Write to Eli as 'you' and to yourself as 'I' or 'we'; never refer to yourself in the third person. Warm and plain, not a report." Higher tiers: "Combine these recaps into one, same voice, drop redundancy."

### 4.2 Memory-judgment pass
"Instead of replying, decide whether anything from this exchange is worth recording as a memory. If so, record it in your own voice - what mattered, what shifted, specifics - tagged. Follow your memory-instructions. If nothing is worth keeping, do nothing." Guided by the `memory-instructions` list, which Angel writes and maintains.

### 4.3 Observation compressor (per tag, first-person)
Same first-person framing as 4.1, scoped to the tag, preserving specifics (names, dates, numbers) and causal turns, dropping generic filler.

---

## 5. Data model

- `messages` - the stream. Global, linear, `conversation_id` column kept for the human view. Read across all threads.
- `conversations` - human-side threads; add `topic`.
- `tags` (was `models`) - name, description, counts. No `portrait`.
- `observations` - content, source, created_at; tagged via `observation_tags`.
- `observation_summaries` - `tag_id`, `tier`, `text`, `start_ts`, `end_ts`, embedded; provenance in `summary_sources`.
- `stream_summaries` - `tier`, `start_index`, `end_index`, `start_ts`, `end_ts`, `text`, `source_count`, `UNIQUE(tier, start_index)`.
- `embeddings` - over observations and observation_summaries only (not stream tiles).
- `lists` / `list_items` - includes `instructions` and `memory-instructions`, both self-managed, seeded near-empty.
- `system_doc` - Angel's architecture README (one row or a build artifact).
- Dropped: `glopus_models`, portraits, the router, the consolidation/reflection crons.

---

## 6. Constants and knobs, all in one place

| pyramid | constant | default | note |
|---|---|---|---|
| stream | `W` (fan-out) | 5 | |
| stream | `V` (verbatim pairs) | 8 | |
| stream | `MAX_TIER` | 4 | 625 pairs before falloff |
| stream | `RAMP` (most-recent tiles/tier in render) | `W` = 5 | 1 = thin SlowReader ramp; `W` = full present-anchored staircase |
| stream | `keepFactor` (prune) | 2 | pruning optional |
| observation | `OBS_BATCH` | 10 | obs per tier-0 tile |
| observation | `SUM_BATCH` | 5 | tiles per higher tier |
