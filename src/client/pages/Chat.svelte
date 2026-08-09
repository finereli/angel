<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { marked } from 'marked';
  import { angel } from '../streamManager';
  import type { ConversationState } from '../streamManager';

  export let conversationId: string;

  let messageText = '';
  let messagesEl: HTMLDivElement;
  let textareaEl: HTMLTextAreaElement;
  let unsub: (() => void) | null = null;
  let convState: ConversationState;
  let userHasScrolledUp = false;

  const renderer = new marked.Renderer();
  renderer.link = ({ href, title, text }) => {
    const titleAttr = title ? ` title="${title}"` : '';
    return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
  };
  marked.setOptions({ breaks: true, gfm: true, renderer });

  function renderMarkdown(content: string): string {
    return marked.parse(content) as string;
  }

  function isMobile(): boolean {
    return window.matchMedia('(max-width: 1024px)').matches || 'ontouchstart' in window;
  }

  $: convState = angel.getConvState(conversationId);
  $: streaming = convState?.streamState === 'streaming';
  $: connState = angel.getConnState();

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
    loadDraft();
  }

  onMount(() => {
    unsub = angel.subscribe(() => {
      convState = angel.getConvState(conversationId);
      connState = angel.getConnState();
      if (!userHasScrolledUp) {
        tick().then(scrollToBottom);
      }
    });
    angel.loadConversation(conversationId);
    loadDraft();
  });

  onDestroy(() => {
    unsub?.();
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
    const text = messageText.trim();
    if (!text || streaming) return;
    angel.sendChat(conversationId, text);
    messageText = '';
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

  function toolLabel(name: string): string {
    const labels: Record<string, string> = {
      record_observation: 'Noting something',
      recall: 'Searching memory',
      create_model: 'Creating model',
      update_model_description: 'Updating model',
      memory_load_model: 'Loading model',
      memory_stats: 'Checking memory',
      catchup: 'Loading context',
      glopus_models: 'Browsing Glopus models',
      glopus_load: 'Loading from Glopus',
      lists_catalog: 'Checking lists',
      list_create: 'Creating list',
      list_read: 'Reading list',
      list_add: 'Adding to list',
      list_supersede: 'Updating item',
      list_archive: 'Archiving item',
    };
    return labels[name] || name;
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
      {#each convState.messages as msg (msg.id)}
        {#if msg.role === 'user'}
          <div class="message user">
            <div class="message-content">{msg.content}</div>
          </div>
        {:else if msg.role === 'assistant'}
          <div class="message assistant">
            <div class="message-content prose">
              {@html renderMarkdown(msg.content)}
              {#if msg.tool_calls}
                {@const tools = typeof msg.tool_calls === 'string' ? JSON.parse(msg.tool_calls) : msg.tool_calls}
                <div class="tool-actions">
                  {#each tools as tool}
                    <span class="tool-row done" title={tool.name}>
                      <svg class="tool-check" viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg>
                      {tool.label || toolLabel(tool.name)}
                    </span>
                  {/each}
                </div>
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
                  {part.label || toolLabel(part.name)}
                </div>
              {/if}
            {/each}
          </div>
        </div>
      {:else if streaming}
        <div class="message assistant streaming">
          <div class="message-content">
            <span class="typing-indicator">
              <span></span><span></span><span></span>
            </span>
          </div>
        </div>
      {/if}
    {/if}
  </div>

  <div class="input-area">
    <div class="input-wrap">
      <textarea
        bind:this={textareaEl}
        bind:value={messageText}
        on:keydown={handleKeydown}
        on:input={() => { autoResize(); saveDraft(); }}
        placeholder="Message Angel..."
        rows="1"
      ></textarea>
      {#if streaming}
        <button class="send-btn stop" on:click={stopStream} title="Stop">
          <svg viewBox="0 0 16 16" fill="currentColor" width="16" height="16"><rect x="3" y="3" width="10" height="10" rx="1.5"/></svg>
        </button>
      {:else}
        <button
          class="send-btn"
          on:click={sendMessage}
          disabled={!messageText.trim()}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
        </button>
      {/if}
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
    white-space: pre-wrap;
  }

  .message.assistant {
    align-self: flex-start;
    background: var(--bg-message);
    color: var(--text-primary);
    border-bottom-left-radius: 2px;
  }

  /* Prose styles for markdown */
  .prose :global(p) {
    margin: 0.4em 0;
  }
  .prose :global(p:first-child) {
    margin-top: 0;
  }
  .prose :global(p:last-child) {
    margin-bottom: 0;
  }
  .prose :global(ul), .prose :global(ol) {
    margin: 0.4em 0;
    padding-left: 1.5em;
  }
  .prose :global(li) {
    margin: 0.2em 0;
  }
  .prose :global(h1), .prose :global(h2), .prose :global(h3) {
    margin: 0.6em 0 0.3em;
    font-weight: 600;
  }
  .prose :global(h1) { font-size: 1.2em; }
  .prose :global(h2) { font-size: 1.1em; }
  .prose :global(h3) { font-size: 1.05em; }
  .prose :global(blockquote) {
    border-left: 3px solid var(--border);
    padding-left: 12px;
    margin: 0.4em 0;
    color: var(--text-secondary);
  }

  .prose :global(pre) {
    background: var(--bg-code);
    padding: 12px 16px;
    border-radius: 8px;
    overflow-x: auto;
    font-size: 0.85rem;
    margin: 0.5em 0;
    line-height: 1.5;
  }

  .prose :global(code) {
    background: var(--bg-code);
    padding: 1px 4px;
    border-radius: 4px;
    font-size: 0.88em;
  }

  .prose :global(pre code) {
    background: none;
    padding: 0;
  }

  .prose :global(a) {
    color: var(--accent);
    text-decoration: underline;
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
    gap: 8px;
    align-items: flex-end;
    max-width: 48rem;
    margin: 0 auto;
  }

  textarea {
    flex: 1;
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
