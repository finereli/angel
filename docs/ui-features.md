# Angel UI features - what's worth porting from Glopus

You asked which Glopus client features are simple and useful here, weighted by what's reasonable on Cloudflare Workers. I surveyed the Glopus client and Angel's current one. Here's the list. Nothing is built yet.

## The one thing that changes everything

Glopus can see images. Angel can't. DeepSeek v4 is text-only, and that single fact reshapes the whole attachment story.

In Glopus an attachment is a file the agent reads. Bytes get saved to disk, the agent Reads them or sees images natively as multimodal blocks. On Angel there's no coding harness, no disk, and no vision. So the useful move isn't "store the file" - it's **extract the text and inline it, then throw the bytes away**. A .docx, a .csv, a code file, a log - all become text, and text is the only thing Angel ever needed. No R2, no storage, no file-serving endpoint. The attachment is a client-side convenience that turns into `<attached-file>` text in the message.

That reframing is what makes attachments cheap on CF. Keep it in mind reading the rest.

## Baseline - what Angel already has

So we don't re-list these: draft persistence per thread, auto-resizing textarea, scroll-to-bottom anchoring, markdown rendering (hand-rolled), interleaved tool-call rows, stop button, reconnect snapshots. The composer basics are done.

---

## Tier 1 - simple and clearly worth it

### Paste-long-text as a block
**What:** paste over ~200 chars or 3+ lines and it collapses into a chip instead of flooding the textarea. Click to view full, x to remove. On send it wraps in `<pasted-content>`.
**CF:** pure client. Zero backend. Zero storage.
**Cost:** small. It's ~40 lines of Chat.svelte plus a parse-on-render helper Angel already has the shape for.
**Verdict:** do it. This is the highest ratio on the list - you paste logs and articles into Angel constantly and right now they bury the input.

### Text/document attachments (extract-and-inline)
**What:** attach button + a file picker. Text files, code, csv, json, md, .docx get their contents extracted and folded into the message as `<attached-file name=...>...text...</attached-file>`.
**CF:** extraction runs fine on a Worker. Text files are trivial. .docx is a zip of XML - a small unzip in the Worker, no native deps. **No R2 needed** if we inline-and-discard (see the reframing above). If you later want the file to persist for re-download, that's when R2 enters - but for a memory companion I don't think you do.
**Cost:** small-to-medium. Client picker + chips (Glopus's FileAttachments is a clean model), one Worker route that takes bytes and returns text, a couple extractors. Skip the docx extractor at first and it's small.
**Verdict:** do it, text-only. This is 80% of the value of attachments at 20% of the cost.

### Code-block copy button
**What:** hover a fenced code block, get a copy button.
**CF:** pure client.
**Cost:** small, but Angel's markdown is hand-rolled so it needs a real fenced-code path first (see below).
**Verdict:** do it alongside the markdown upgrade.

---

## Tier 2 - useful, more work, still reasonable on CF

### Voice input (speak instead of type)
**What:** mic button, record, transcribe to text in the composer. Glopus sends audio to Whisper.
**CF:** **this works natively.** Workers AI has `@cf/openai/whisper`. No external service, no key, no multer/disk - MediaRecorder in the browser, POST the blob to a Worker route, run Whisper, return text. Angel already binds `AI`.
**Cost:** medium. Client recorder component + one Worker route. Glopus's audioRecorder.ts and VoiceInput.svelte are a good reference but you can slim them.
**Verdict:** worth it if you actually talk to Angel on your phone. It's the most "companion" feature here. Defer if you mostly type.

### Real markdown rendering
**What:** Angel's renderer is a regex hand-roll. A proper parser gives you tables, nested lists, fenced code with a language class, blockquotes - and it's the foundation for both syntax highlighting and copy buttons.
**CF:** client only. A small parser bundles fine.
**Cost:** medium, mostly a swap plus re-checking the interleaved-parts rendering still lines up.
**Verdict:** do it if code and structured replies start looking rough. It's a prerequisite for the two code features, so bundle them.

### Syntax highlighting
**What:** colored code blocks.
**CF:** client only, but a highlighter is real bundle weight.
**Cost:** medium.
**Verdict:** nice, not urgent. Only after the markdown upgrade. Lowest priority in this tier.

---

## Tier 3 - possible on CF but I'd skip for now

### Image attachments / paste-a-screenshot
Blocked by the model, not the platform. DeepSeek can't see. To make an image mean anything you'd route it to a vision model (a second OpenRouter model, or Workers AI vision for a caption) - real cost, split-brain model routing, and it fights the "one fast text companion" design. Skip until Angel has a reason to see.

### Text-to-speech (Angel talks back)
**CF:** Workers AI has TTS models (melotts), so it's *possible* natively. But it's a prefetch-queue, a player, audio-quality caveats, and a lot of surface for a companion you mostly read. Glopus's ttsPlayer.ts is 280 lines for a reason.
**Verdict:** skip unless you specifically want hands-free replies. High effort, narrow payoff.

### File persistence / re-download, drag-and-drop-to-disk, multi-file galleries
All presume the file is an artifact you keep. Angel's attachments are text that dissolves into the message. If that assumption holds, none of this applies.

---

## If I were sequencing it

1. **Paste-as-block** - an afternoon, immediate daily relief.
2. **Text attachments, inline-and-discard** - the big one, no new infra.
3. **Markdown upgrade + copy button + highlighting** - one bundle when replies start looking rough.
4. **Voice input** - when you want to talk to him on the phone.
5. Everything in Tier 3 stays parked until the model or the use case changes.

The through-line: Angel is a text companion with no disk and no eyes. The features that fit are the ones that turn input into text and never try to hold a file. Paste and text-attachments are exactly that, which is why they lead.
