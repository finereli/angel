<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { angel } from '../streamManager';
  import type { ConversationState } from '../streamManager';
  import { TOOL_LABELS } from '../../worker/tools/registry';
  import { renderMarkdown, dayKey, dateLabel } from '../util';

  export let conversationId: string;

  let messageText = '';
  let messagesEl: HTMLDivElement;
  let textareaEl: HTMLTextAreaElement;
  let unsub: (() => void) | null = null;
  let convState: ConversationState;
  let userHasScrolledUp = false;

  // Small text attachments: read client-side, inlined into the message, bytes
  // discarded. No upload, no storage - the file's text becomes part of what Angel
  // reads. Anything at or past DOC_THRESHOLD_CHARS is too big to dump into context,
  // so it's stored as an out-of-context document Angel reads in passes instead.
  const DOC_THRESHOLD_CHARS = 6000; // above this, store as a document, not inline
  const DOC_MAX_BYTES = 1024 * 1024; // 1 MB ceiling over the WebSocket (PDF/large uploads come later)
  // Paste over either threshold becomes an attachment instead of flooding the box.
  const PASTE_ATTACH_CHARS = 600;
  const PASTE_ATTACH_LINES = 8;
  const TEXT_EXTS = new Set([
    '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.yaml', '.yml',
    '.toml', '.xml', '.js', '.ts', '.jsx', '.tsx', '.py', '.rb', '.go', '.rs', '.java',
    '.c', '.h', '.cpp', '.cs', '.php', '.swift', '.kt', '.sh', '.bash', '.zsh', '.sql',
    '.html', '.css', '.scss', '.svelte', '.vue', '.log', '.diff', '.patch', '.env',
    '.ini', '.conf', '.cfg',
  ]);

  interface Attachment { name: string; size: number; text: string }
  let attachments: Attachment[] = [];
  let fileInputEl: HTMLInputElement;
  let attachError = '';

  // Long input stored as an out-of-context document. It's uploaded on attach; the
  // real id arrives via onDocAdded. On send its pointer is folded into the message.
  interface PendingDoc { clientDocId: string; title: string; lines: number; status: 'uploading' | 'ready'; id?: string }
  let pendingDocs: PendingDoc[] = [];

  function isTextFile(name: string, type: string): boolean {
    const dot = name.lastIndexOf('.');
    const ext = dot >= 0 ? name.slice(dot).toLowerCase() : '';
    if (TEXT_EXTS.has(ext)) return true;
    if (type && (type.startsWith('text/') || type === 'application/json' || type === 'application/xml' || type.includes('yaml'))) return true;
    return false;
  }

  async function addFiles(files: File[]) {
    attachError = '';
    for (const file of files) {
      if (!isTextFile(file.name, file.type)) {
        attachError = `${file.name}: text files only for now (images and PDFs come later)`;
        continue;
      }
      if (file.size > DOC_MAX_BYTES) {
        attachError = `${file.name} is too big - ${Math.round(file.size / 1024)} KB, max ${Math.round(DOC_MAX_BYTES / 1024)} KB for now (large/PDF uploads come later)`;
        continue;
      }
      let text: string;
      try { text = await file.text(); } catch { attachError = `Couldn't read ${file.name}`; continue; }
      if (text.includes('\u0000')) { attachError = `${file.name} looks binary, skipping`; continue; }
      if (text.length >= DOC_THRESHOLD_CHARS) {
        storeDoc(file.name.replace(/"/g, ''), text);
      } else {
        attachments = [...attachments, { name: file.name.replace(/"/g, ''), size: file.size, text }];
      }
    }
  }

  function handleFileSelect(e: Event) {
    const input = e.target as HTMLInputElement;
    if (input.files?.length) addFiles(Array.from(input.files));
    input.value = '';
  }

  function addPastedText(text: string) {
    attachError = '';
    const bytes = new Blob([text]).size;
    if (bytes > DOC_MAX_BYTES) {
      attachError = `That paste is large - ${Math.round(bytes / 1024)} KB, max ${Math.round(DOC_MAX_BYTES / 1024)} KB for now.`;
      return;
    }
    if (text.length >= DOC_THRESHOLD_CHARS) {
      const d = pendingDocs.filter(p => p.title.startsWith('Pasted text')).length;
      storeDoc(d === 0 ? 'Pasted text' : `Pasted text ${d + 1}`, text);
      return;
    }
    const n = attachments.filter(a => a.name.startsWith('Pasted text')).length;
    attachments = [...attachments, { name: n === 0 ? 'Pasted text' : `Pasted text ${n + 1}`, size: bytes, text }];
  }

  // Upload a long attachment/paste as an out-of-context document; hold a chip until
  // its id comes back, then fold its pointer into the next message on send.
  function storeDoc(title: string, text: string) {
    const clientDocId = crypto.randomUUID();
    const lines = text.split('\n').length;
    pendingDocs = [...pendingDocs, { clientDocId, title, lines, status: 'uploading' }];
    angel.addDocument(conversationId, clientDocId, title, text);
  }

  function removePendingDoc(clientDocId: string) {
    pendingDocs = pendingDocs.filter(d => d.clientDocId !== clientDocId);
  }

  // Short pastes drop into the box as usual; long ones become an attachment.
  function handlePaste(e: ClipboardEvent) {
    const text = e.clipboardData?.getData('text/plain') ?? '';
    if (!text) return;
    if (text.length >= PASTE_ATTACH_CHARS || text.split('\n').length >= PASTE_ATTACH_LINES) {
      e.preventDefault();
      addPastedText(text);
    }
  }

  function removeAttachment(i: number) {
    attachments = attachments.filter((_, idx) => idx !== i);
  }

  function attachMeta(a: Attachment): string {
    const lines = a.text.split('\n').length;
    return `${a.name} · ${lines} line${lines === 1 ? '' : 's'} · ${a.text.length} chars`;
  }

  function attachPreview(text: string): string {
    let p = text.split('\n').slice(0, 8).join('\n');
    if (p.length > 600) p = p.slice(0, 600) + '…';
    return p;
  }

  function buildContent(): string {
    const blocks = attachments.map(a => `<attached-file name="${a.name}">\n${a.text}\n</attached-file>`);
    // A document's pointer, not its text - Angel reads it out of context.
    const docs = pendingDocs
      .filter(d => d.status === 'ready' && d.id)
      .map(d => `<document id="${d.id}" title="${d.title}" lines="${d.lines}"/>`);
    return [...blocks, ...docs, messageText.trim()].filter(Boolean).join('\n\n');
  }

  // Pull attached-file blocks and document pointers back out for display so the
  // transcript shows a chip, not the whole dumped file or a raw tag.
  function parseUserContent(content: string): { files: string[]; docs: { title: string; lines: number }[]; text: string } {
    const files: string[] = [];
    const docs: { title: string; lines: number }[] = [];
    const text = content
      .replace(/<attached-file name="([^"]*)">\n?[\s\S]*?\n?<\/attached-file>/g, (_m, name) => { files.push(name); return ''; })
      .replace(/<document id="[^"]*" title="([^"]*)" lines="(\d+)"\s*\/>/g, (_m, title, lines) => { docs.push({ title, lines: +lines }); return ''; })
      .replace(/^\n+/, '')
      .trim();
    return { files, docs, text };
  }

  function isMobile(): boolean {
    return window.matchMedia('(max-width: 1024px)').matches || 'ontouchstart' in window;
  }

  function formatElapsed(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }

  $: convState = angel.getConvState(conversationId);
  $: streaming = convState?.streamState === 'streaming';
  $: connState = angel.getConnState();

  // "Waiting on the API" indicator (ported from Glopus). The socket can be open and
  // the stream live while nothing comes back for seconds at a time - a provider
  // stall, a backoff retry, the gap between rounds. We track when the stream last
  // advanced (streamSeq changing) and, if it's been quiet past a threshold, say so.
  // We also show total elapsed since the turn began, so a long silence has a number.
  let lastActivity = Date.now();
  let lastSeq = -1;
  let now = Date.now();
  $: if (convState && convState.streamSeq !== lastSeq) { lastSeq = convState.streamSeq; lastActivity = Date.now(); }
  $: elapsedSeconds = (streaming && convState?.streamStartTime) ? Math.floor((now - convState.streamStartTime) / 1000) : 0;
  $: lastPart = convState?.streamParts?.[convState.streamParts.length - 1];
  $: lastIsActiveTool = !!lastPart && lastPart.type === 'tool' && lastPart.result === undefined;
  // A tool mid-execution already shows its own spinner - don't stack a second one.
  $: waitingOnApi = streaming && (convState?.streamParts?.length ?? 0) > 0 && !lastIsActiveTool && (now - lastActivity) > 1500;

  // Draft persistence
  function saveDraft() {
    if (messageText.trim()) {
      localStorage.setItem(`angel-draft-${conversationId}`, messageText);
    } else {
      localStorage.removeItem(`angel-draft-${conversationId}`);
    }
  }

  function loadDraft() {
    messageText = localStorage.getItem(`angel-draft-${conversationId}`) || '';
    tick().then(autoResize);
  }

  let prevConvId: string | undefined;
  $: if (conversationId !== prevConvId) {
    if (prevConvId) saveDraft();
    prevConvId = conversationId;
    // Attachments and stored-doc pointers belong to the conversation they were
    // made in - a doc's id is bound to it - so don't carry them across a switch.
    attachments = [];
    pendingDocs = [];
    attachError = '';
    loadDraft();
  }

  let unsubDoc: (() => void) | null = null;
  let thinkTimer: ReturnType<typeof setInterval> | null = null;

  onMount(() => {
    thinkTimer = setInterval(() => { if (streaming) now = Date.now(); }, 500);
    unsub = angel.subscribe(() => {
      convState = angel.getConvState(conversationId);
      connState = angel.getConnState();
      if (!userHasScrolledUp) {
        tick().then(scrollToBottom);
      }
    });
    unsubDoc = angel.onDocAdded((d) => {
      pendingDocs = pendingDocs.map(p =>
        p.clientDocId === d.clientDocId
          ? { ...p, status: 'ready', id: d.id, title: d.title, lines: d.lineCount }
          : p
      );
    });
    angel.loadConversation(conversationId);
    loadDraft();
  });

  onDestroy(() => {
    unsub?.();
    unsubDoc?.();
    if (thinkTimer) clearInterval(thinkTimer);
    saveDraft();
  });

  function scrollToBottom() {
    if (messagesEl) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  }

  function handleScroll() {
    if (!messagesEl) return;
    const { scrollTop, scrollHeight, clientHeight } = messagesEl;
    userHasScrolledUp = scrollHeight - scrollTop - clientHeight > 100;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && e.altKey && !isMobile()) {
      e.preventDefault();
      const ta = e.target as HTMLTextAreaElement;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      messageText = messageText.substring(0, start) + '\n' + messageText.substring(end);
      tick().then(() => {
        ta.selectionStart = ta.selectionEnd = start + 1;
        autoResize();
      });
    } else if (e.key === 'Enter' && !e.shiftKey && !isMobile()) {
      e.preventDefault();
      sendMessage();
    }
  }

  function sendMessage() {
    if (streaming) return;
    if (pendingDocs.some(d => d.status === 'uploading')) return; // wait for the doc id
    if (!messageText.trim() && attachments.length === 0 && pendingDocs.length === 0) return;
    angel.sendChat(conversationId, buildContent());
    messageText = '';
    attachments = [];
    pendingDocs = [];
    attachError = '';
    localStorage.removeItem(`angel-draft-${conversationId}`);
    userHasScrolledUp = false;
    tick().then(() => {
      if (textareaEl) textareaEl.style.height = 'auto';
      scrollToBottom();
    });
  }

  function stopStream() {
    angel.stopStream(conversationId);
  }

  function autoResize() {
    if (!textareaEl) return;
    textareaEl.style.height = 'auto';
    const clamped = Math.min(textareaEl.scrollHeight, 168);
    textareaEl.style.height = clamped + 'px';
    textareaEl.style.overflowY = textareaEl.scrollHeight > 168 ? 'auto' : 'hidden';
  }

  // [in-progress, done] label per tool - kind only, no description.
  function toolProgress(name: string): string {
    return TOOL_LABELS[name]?.[0] || 'Working';
  }
  function toolDone(name: string, fallback?: string): string {
    return TOOL_LABELS[name]?.[1] || fallback || name;
  }

  function relativeTime(ts: string): string {
    const diff = Date.now() - new Date(ts).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    const days = Math.floor(hrs / 24);
    return `${days}d`;
  }
</script>

<div class="chat">
  <!-- Connection banner -->
  {#if connState === 'reconnecting'}
    <div class="banner warn">Reconnecting...</div>
  {/if}
  {#if convState?.error}
    <div class="banner error">{convState.error}</div>
  {/if}

  <div class="messages" bind:this={messagesEl} on:scroll={handleScroll}>
    {#if convState}
      {#each convState.messages as msg, i (msg.id)}
        {#if i === 0 || dayKey(msg.created_at) !== dayKey(convState.messages[i - 1].created_at)}
          <div class="date-line"><span>{dateLabel(msg.created_at)}</span></div>
        {/if}
        {#if msg.role === 'user'}
          {@const uc = parseUserContent(msg.content)}
          <div class="message user">
            {#if uc.files.length || uc.docs.length}
              <div class="attach-chips">
                {#each uc.files as fname}
                  <span class="attach-chip">
                    <svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12"><path d="M4 1.5A1.5 1.5 0 0 0 2.5 3v10A1.5 1.5 0 0 0 4 14.5h8a1.5 1.5 0 0 0 1.5-1.5V6L9 1.5H4z"/></svg>
                    {fname}
                  </span>
                {/each}
                {#each uc.docs as d}
                  <span class="attach-chip doc-chip">
                    <svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12"><path d="M3 2.5A1.5 1.5 0 0 1 4.5 1H12a1 1 0 0 1 1 1v11.5a.5.5 0 0 1-.5.5H4.5A1.5 1.5 0 0 1 3 12.5v-10zM4.5 12a.5.5 0 0 0 0 1H12v-1H4.5z"/></svg>
                    {d.title} · {d.lines} lines
                  </span>
                {/each}
              </div>
            {/if}
            {#if uc.text}<div class="message-content">{uc.text}</div>{/if}
          </div>
        {:else if msg.role === 'assistant'}
          <div class="message assistant">
            <div class="message-content prose">
              {#if msg.parts}
                <!-- Ordered parts: tools render exactly where they were used. -->
                {@const parts = typeof msg.parts === 'string' ? JSON.parse(msg.parts) : msg.parts}
                {#each parts as part}
                  {#if part.type === 'text'}
                    {@html renderMarkdown(part.content)}
                  {:else}
                    <div class="tool-row done" title={part.name}>
                      <svg class="tool-check" viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg>
                      {toolDone(part.name, part.label)}
                    </div>
                  {/if}
                {/each}
              {:else}
                {@html renderMarkdown(msg.content)}
                {#if msg.tool_calls}
                  {@const tools = typeof msg.tool_calls === 'string' ? JSON.parse(msg.tool_calls) : msg.tool_calls}
                  <div class="tool-actions">
                    {#each tools as tool}
                      <span class="tool-row done" title={tool.name}>
                        <svg class="tool-check" viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg>
                        {toolDone(tool.name, tool.label)}
                      </span>
                    {/each}
                  </div>
                {/if}
              {/if}
            </div>
          </div>
        {/if}
      {/each}

      <!-- Streaming content -->
      {#if streaming && convState.streamParts.length > 0}
        <div class="message assistant streaming">
          <div class="message-content prose">
            {#each convState.streamParts as part}
              {#if part.type === 'text'}
                {@html renderMarkdown(part.content)}
              {:else}
                <div class="tool-row {part.result ? 'done' : 'active'}">
                  {#if part.result}
                    <svg class="tool-check" viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg>
                  {:else}
                    <span class="tool-spinner"></span>
                  {/if}
                  {part.result ? toolDone(part.name, part.label) : toolProgress(part.name) + '…'}
                </div>
              {/if}
            {/each}
            {#if waitingOnApi}
              <div class="tool-row waiting">
                <span class="tool-spinner"></span>
                Waiting on the model ({formatElapsed(elapsedSeconds)})
              </div>
            {/if}
          </div>
        </div>
      {:else if streaming}
        <div class="message assistant streaming">
          <div class="message-content thinking-row">
            <span class="typing-indicator">
              <span></span><span></span><span></span>
            </span>
            {#if elapsedSeconds > 2}
              <span class="thinking-elapsed">Thinking ({formatElapsed(elapsedSeconds)})</span>
            {/if}
          </div>
        </div>
      {/if}
    {/if}
  </div>

  <div class="input-area">
    {#if attachError}
      <div class="attach-error">{attachError}</div>
    {/if}
    {#if attachments.length}
      <div class="attach-cards">
        {#each attachments as a, i}
          <div class="attach-card">
            <div class="attach-card-head">
              <span class="attach-card-meta">{attachMeta(a)}</span>
              <button class="chip-x" on:click={() => removeAttachment(i)} title="Remove">×</button>
            </div>
            <pre class="attach-card-preview">{attachPreview(a.text)}</pre>
          </div>
        {/each}
      </div>
    {/if}
    {#if pendingDocs.length}
      <div class="doc-pending-row">
        {#each pendingDocs as d}
          <span class="attach-chip doc-chip" class:uploading={d.status === 'uploading'}>
            {#if d.status === 'uploading'}
              <span class="tool-spinner"></span>{d.title} · storing…
            {:else}
              <svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12"><path d="M3 2.5A1.5 1.5 0 0 1 4.5 1H12a1 1 0 0 1 1 1v11.5a.5.5 0 0 1-.5.5H4.5A1.5 1.5 0 0 1 3 12.5v-10zM4.5 12a.5.5 0 0 0 0 1H12v-1H4.5z"/></svg>
              {d.title} · {d.lines} lines to read
            {/if}
            <button class="chip-x" on:click={() => removePendingDoc(d.clientDocId)} title="Remove">×</button>
          </span>
        {/each}
      </div>
    {/if}
    <div class="input-wrap">
      <textarea
        bind:this={textareaEl}
        bind:value={messageText}
        on:keydown={handleKeydown}
        on:paste={handlePaste}
        on:input={() => { autoResize(); saveDraft(); }}
        placeholder="Message Angel..."
        rows="1"
      ></textarea>
      <div class="composer-actions">
        <input type="file" multiple bind:this={fileInputEl} on:change={handleFileSelect} style="display:none" />
        <button class="attach-btn" on:click={() => fileInputEl.click()} disabled={streaming} title="Attach a text file">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
        <div class="composer-spacer"></div>
        {#if streaming}
          <button class="send-btn stop" on:click={stopStream} title="Stop">
            <svg viewBox="0 0 16 16" fill="currentColor" width="16" height="16"><rect x="3" y="3" width="10" height="10" rx="1.5"/></svg>
          </button>
        {:else}
          <button
            class="send-btn"
            on:click={sendMessage}
            disabled={(!messageText.trim() && attachments.length === 0 && pendingDocs.length === 0) || pendingDocs.some(d => d.status === 'uploading')}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
          </button>
        {/if}
      </div>
    </div>
  </div>
</div>

<style>
  .chat {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .banner {
    padding: 6px 16px;
    font-size: 0.78rem;
    text-align: center;
  }
  .banner.warn {
    background: #f59e0b22;
    color: #d97706;
  }
  .banner.error {
    background: #ef444422;
    color: #ef4444;
  }

  .messages {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .message {
    max-width: 100%;
    padding: 8px 16px;
    border-radius: 16px;
    font-size: 1rem;
    line-height: 1.5;
    word-wrap: break-word;
  }

  .date-line {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 4px 0;
    color: var(--text-secondary);
    font-size: 0.72rem;
  }
  .date-line::before,
  .date-line::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--border);
  }

  @media (min-width: 1024px) {
    .message {
      max-width: 70%;
    }
  }

  .message.user {
    align-self: flex-end;
    background: var(--accent);
    color: white;
    border-bottom-right-radius: 2px;
  }
  /* pre-wrap on the text itself, NOT the container - otherwise the template's
     own newlines between elements render as blank lines around the message. */
  .message.user .message-content {
    white-space: pre-wrap;
  }

  .message.assistant {
    align-self: flex-start;
    background: var(--bg-message);
    color: var(--text-primary);
    border-bottom-left-radius: 2px;
  }

  .tool-actions {
    margin-top: 6px;
  }

  .tool-row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.78rem;
    color: var(--text-secondary);
    padding: 2px 0;
    font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace;
  }

  .tool-row.active {
    color: var(--accent);
  }
  .tool-row.waiting {
    color: var(--text-secondary);
    font-style: italic;
    opacity: 0.85;
  }
  .thinking-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .thinking-elapsed {
    font-size: 0.78rem;
    color: var(--text-secondary);
    font-style: italic;
    font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace;
  }

  .tool-check {
    width: 12px;
    height: 12px;
    color: #22c55e;
    flex-shrink: 0;
  }

  .tool-spinner {
    display: inline-block;
    width: 10px;
    height: 10px;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    flex-shrink: 0;
  }

  .typing-indicator {
    display: flex;
    gap: 4px;
    padding: 4px 0;
  }
  .typing-indicator span {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--text-secondary);
    animation: bounce 1.2s infinite;
  }
  .typing-indicator span:nth-child(2) { animation-delay: 0.2s; }
  .typing-indicator span:nth-child(3) { animation-delay: 0.4s; }
  @keyframes bounce {
    0%, 80%, 100% { transform: translateY(0); }
    40% { transform: translateY(-6px); }
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .input-area {
    padding: 12px 16px;
    border-top: 1px solid var(--border);
    background: var(--bg-surface);
  }

  .input-wrap {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .composer-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .composer-spacer { flex: 1; }

  .attach-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  /* Pending attachment/paste preview cards */
  .attach-cards {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 8px;
  }
  .attach-card {
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--bg-code);
    padding: 10px 12px;
  }
  .attach-card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    font-size: 0.75rem;
    color: var(--text-secondary);
    font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace;
  }
  .attach-card-meta {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .attach-card-preview {
    margin: 8px 0 0;
    font-size: 0.72rem;
    line-height: 1.45;
    color: var(--text-secondary);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 7.2em;
    overflow: hidden;
    font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace;
  }
  .attach-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 8px;
    border-radius: 8px;
    font-size: 0.78rem;
    background: var(--bg-code);
    color: var(--text-secondary);
    border: 1px solid var(--border);
    max-width: 100%;
  }
  .message.user .attach-chip {
    background: rgba(255, 255, 255, 0.18);
    color: white;
    border-color: rgba(255, 255, 255, 0.25);
    margin-bottom: 6px;
  }
  .chip-x {
    border: none;
    background: none;
    color: inherit;
    cursor: pointer;
    font-size: 1rem;
    line-height: 1;
    padding: 0 0 0 2px;
    opacity: 0.6;
  }
  .chip-x:hover { opacity: 1; }

  /* A stored document reads differently from an inlined file - tinted, and it
     names how much there is to read rather than previewing it. */
  .doc-chip {
    background: var(--accent-soft, rgba(99, 102, 241, 0.12));
    color: var(--accent, #4f46e5);
    border-color: var(--accent, #4f46e5);
  }
  .doc-pending-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 0 4px 8px;
  }
  .doc-chip.uploading {
    opacity: 0.7;
  }

  .attach-error {
    margin: 0 0 8px;
    font-size: 0.78rem;
    color: #ef4444;
  }

  .attach-btn {
    width: 44px;
    height: 44px;
    border-radius: 50%;
    border: none;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: color 0.15s, background 0.15s;
  }
  .attach-btn:not(:disabled):hover {
    color: var(--accent);
    background: var(--bg-code);
  }
  .attach-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }

  textarea {
    width: 100%;
    resize: none;
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 10px 16px;
    font-size: 1rem;
    font-family: inherit;
    background: var(--bg-input);
    color: var(--text-primary);
    line-height: 1.5;
    max-height: 168px;
    overflow-y: hidden;
  }
  textarea:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent);
  }

  .send-btn {
    width: 44px;
    height: 44px;
    border-radius: 50%;
    border: none;
    background: var(--accent);
    color: white;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: opacity 0.15s;
  }
  .send-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .send-btn:not(:disabled):hover {
    filter: brightness(0.9);
  }
  .send-btn.stop {
    background: #b91c1c99;
  }
  :global(.dark) .send-btn.stop {
    background: #991b1b88;
  }
</style>
