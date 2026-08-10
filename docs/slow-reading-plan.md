# Angel slow reading - plan

## The question, first

You asked the right thing: is the Cloudflare constraint making a simple idea hard, or is slow reading genuinely interesting and worth the effort? I think two different things got tangled, and pulling them apart is most of the plan.

- **The reading loop** - read a section, recall what you already know, reflect, record, carry forward - is genuinely interesting and has nothing to do with CF.
- **The plumbing** I sketched last time - alarm-driven jobs, R2, PDF extraction - is mostly *not* CF-specific, and the one piece that genuinely is CF-hard we don't need for a while.

So the honest answer is: keep at it, but we've been letting the plumbing set the difficulty, and it shouldn't.

## What slow reading actually buys - and what it doesn't

Let's be strict about the value, because it's easy to cargo-cult "read it slowly" into ceremony.

**It is not about context size.** DeepSeek v4 has a big window. Most docs fit whole. So "we have to chunk because it won't fit" is a false constraint, and if that were the only reason, chunking would be pure overhead. Say it plainly so we don't hide behind it.

**The real thing it buys is integration.** A single forward pass over a wall of text produces shallow, evenly-weighted notes - the model skims and never dwells. Reading section by section changes two things you cannot fake in one pass:

1. **Recall before each section.** Before reading section 5, pull what Angel already knows that's relevant, so he reads it *against* his memory - confirming, contradicting, extending. You can't do this in one pass because the steering has to happen at each step, and the observations from section 3 don't exist yet when section 1 is read.
2. **Carry-forward understanding.** A running note threads between sections, so later ones are read in light of earlier ones. The doc gets read as an argument, not a bag of facts.

The claim, then, is sharp and testable: **slow reading produces better memory, not just more memory.** That's the same bet as the whole Angel architecture - that integrated, connected observations beat a flat dump - applied to the input side. If the bet is worth making for conversation, it's worth making for reading.

**The load-bearing detail: the doc must stay out of context.** This is the thing that makes or breaks the whole idea. If the full document sits in the model's context and we just say "read it in passes," it's theater - he sees the whole thing at once and records a few flat observations about the whole. Sequential reading only happens if the rest of the doc is *not visible* and gets revealed one piece at a time. So the mechanism isn't "prompt him to go slow," it's "physically only show him the part he's on." That single constraint is what we're really testing, and it's what every stage below is built around.

**The honest counterweight.** There's a cheaper version that might capture 80%: one broad recall up front, then read the whole doc with that recall in context, then record once. The thing actually worth testing is whether *per-section* recall-and-reflect, with the rest out of view, beats *one upfront* recall plus a full read. Until we've seen that, building heavy machinery is premature. So the plan is staged to answer that question before it spends anything.

## Where Cloudflare actually bites - and where it doesn't

I over-attributed difficulty to CF last time. Sorting it honestly:

- **Alarm-driven job queue, one section per tick.** This sounds like CF tax, but it isn't - it's just "this is a background job." On any normal server you'd *still* want a queue and a worker loop for a 40-page read; you wouldn't hold a request open for five minutes. Not invented complexity, and - more to the point - not needed for v1 (see below).
- **Subrequest and wall-clock limits.** Generous on paid. A 20-section read is 20 to 40 model calls, nowhere near the ceiling. A single background invocation can loop through a reasonable doc without alarms at all.
- **The one genuine bite: binary formats without a bash env.** Extracting text from a PDF on a Worker means a WASM library, fiddly and heavy; zip is easier but still work. *This* is where CF makes it annoying - and the answer is simply: don't, not yet. v1 reads text, which the attachment feature already restricts to. PDF ingestion is a separate capability we can bolt on later without touching the reading loop.

So: the loop is platform-neutral and interesting. The plumbing is either not-CF-specific or deferrable. The only real CF wall is binary ingestion, and we route around it by staying on text.

## How long can a single tool loop run

This decides how much background machinery we actually need, so it's worth pinning down.

**Our side - a backstop, not a limit.** `MAX_TOOL_ROUNDS` is currently 12, which is tiny for modern models - they don't loop endlessly, so there's little reason to cap tightly. Raise it to **1000**: a runaway backstop against something completely crazy, not a real ceiling. Note the two caps then coincide - at ~1000 rounds you're also at the ~1000-subrequest invocation ceiling below, and a read that long is alarm territory (Stage 2) anyway. So in practice subrequests bite first and the round cap never does its job except as a last-resort sanity valve.

**CF side - far more room than a document needs.** The thing to internalize: time spent *awaiting the LLM stream does not count as CPU time*. A read loop is wall-clock heavy but CPU-light, so the ~30s CPU limit isn't the wall. What actually bounds an invocation:

- **Subrequests: ~1000 per invocation** on the paid plan. Each LLM call is one subrequest, so one invocation can do up to ~1000 chunks - no document you'd hand him comes close.
- **Our per-call timeouts** in llm.ts (`OVERALL_MS` = 3 min, `STALL_MS` = 30s) bound each call, not the loop.
- **Practical shape:** a 4,000-line doc at ~100 lines/chunk is ~40 calls - a couple minutes wall clock, near-zero CPU, 40 of 1000 subrequests. Comfortable in one invocation, even on the hot path (though two minutes of "Angel is typing" is itself the argument for background).

**When one invocation isn't enough** - only two cases: genuinely huge material (thousands of chunks), or wanting the read to survive a crash or a deploy mid-way. That's what alarms buy: each tick is a fresh invocation with a fresh 1000-subrequest budget, cursor persisted in D1 between ticks; chain them and the loop is effectively unbounded. That's precisely why alarms are Stage 2, not Stage 1 - a single document never needs them.

## The plan, staged so we learn before we build

The staging is the point. Each stage is usable, and stage 0 answers your question almost for free.

### Stage 0 - the real experiment: out of context, read sequentially

Not "zero infrastructure" - the minimum viable test needs exactly two things, and no more: a place to hold the document *out of context*, and a way to reveal it a piece at a time. Everything else (background, own thread, alarms, PDF) is dressing we can skip for the test.

**Reading isn't a mode - it's what the affordances produce.** The mechanics of reading (pull a chunk, reflect, record, continue) shouldn't be a command you invoke. They're just what Angel naturally does when he's handed something long behind a tool, the same way `recall` is a tool he chooses to fire rather than context force-fed to him. Documents-behind-a-tool is the same shape as memory-behind-recall: information he pulls when he wants it. So there's no "attach to discuss" vs "attach to read" for *you* to pick. There's one automatic rule: content over a size threshold gets stored out of context and handed to him as a handle; small stuff still drops inline so a quick "what's wrong with this config" gets answered immediately, no tool round-trip. The threshold is plumbing, not a decision.

**What's taught, not commanded.** He doesn't discover reading unprompted and he doesn't need a per-document instruction either - *how to read well* (recall first, take bounded bites, integrate against what you know, don't skim) lives in his standing instructions, the memory-instructions list or system doc. It becomes part of who he is. What's left for you to say per-document is only *intent and scope*: "really sit with this one" when you want depth, "take your time in the background" when it's long. Those aren't reading mechanics - they're how-deep and how-long.

**Store it, don't dump it.** The attachment we just shipped *dumps* the file's text into the message. A read needs the opposite: store the doc as a row of text with stable line numbers, and keep it out of the message so he only ever sees the part he's on.

**Reveal it with a line-range tool, not a fixed march.** Two mechanisms are possible:

- *Harness feeds sections* - the loop injects section i, he responds, it injects i+1. Guarantees order and coverage, but he's passive: no re-reading, no backtracking, a fixed cadence.
- *A `read_document(start, end)` tool* - he pulls a window, reflects, records, pulls the next, and can jump back to re-read. Matches the "leave judgment to Angel" design. The risk is a giant bite that becomes a dump, so **bound the window the tool returns** - bounded bites plus agent-driven pacing gives both sequentiality and agency.

I'd build the tool. On first contact he gets the doc's shape - total lines, and the header outline if it's markdown - so he navigates structure, not blind numbers. Then the loop is his: recall, read a bounded chunk, reflect against what he knows, record, continue.

**Background doesn't matter for the test; sequentiality does.** So Stage 0 runs in a normal visible thread on the hot path. It's capped by the tool-round budget, which is fine for a probe. This tells us, soon, whether reading with the rest out of view produces richer, more connected memory than a single pass. If it doesn't, we've saved ourselves the rest. If it does, we know exactly what to harden.

### Stage 1 - the real feature: a background reading job

If stage 0 earns it: take the same out-of-context, tool-driven loop and move it off the hot path. You attach a document, ask Angel to read it, and he reads in the background - still one DO invocation looping in memory, no alarms, because a doc that fits doesn't need them. Text only. What Stage 1 adds over Stage 0 is a **carry-forward note** threaded between chunks (so later parts are read in light of earlier ones), progress that survives a reload, and coverage you can trust.

Observations flow into the normal pipeline and get pyramided in the background as usual, so what he reads becomes part of his memory and folds into every future thread.

The nice property you noticed: because every conversation already folds into the one stream, the read doesn't strictly need to *be* a conversation - it can just record. But giving it a visible thread lets you watch him think, and lets you talk to him from *another* thread while he reads, with his reading folding into that context live. That's the version I'd build.

### Stage 2 - only if warranted

Reach for these only when a real need shows up, not preemptively:

- **Alarms + a job table** - when docs get big enough that one invocation can't finish, or when surviving a crash mid-read matters. This is where "one section per tick, resumable" earns its keep.
- **R2 + PDF/zip ingestion** - when you want to read things that aren't already text. This is the genuine-CF-hard part, cleanly separated so it never complicates the loop.

## Open decisions (settle before Stage 1)

1. **Who starts a read - you or him?** A button, or a tool he chooses when handed something long? The architecture leaves judgment to Angel, which argues for the tool. But a 40-page read is a real cost you might want to green-light.
2. **Its own thread, or silent recording?** Visible thread to watch him, or just observations that surface later. I lean visible.
3. **Live vs. background.** Background is robust and lets you keep chatting; the cost is he can't discuss it *as* he reads in that same thread. You talk from another thread instead.
4. **The per-section prompt.** Getting recall-then-reflect to read as genuine integration, not "here is a summary of section 4," is the same first-person craft as the stream recap - worth tuning deliberately.

## What I'd do next

Build Stage 0: an out-of-context document store (a text row with line numbers), a bounded `read_document(start, end)` tool, one size threshold that routes long input to the store instead of dumping it inline, and the how-to-read guidance added to his standing instructions. Small, and it directly answers the question you're asking - everything after depends on the answer. If reading with the rest out of view visibly deepens what Angel keeps, we build Stage 1 and it's clearly worth it. If it doesn't, we learned that cheaply and move on.
