<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { angel } from '../streamManager';
  import type { DmMessageRow } from '../../worker/types';
  import { renderMarkdown, dayKey, dateLabel, timeLabel } from '../util';

  export let agentId: string;
  export let agentName: string;

  let messages: DmMessageRow[] = [];
  let messageText = '';
  let messagesEl: HTMLDivElement;
  let textareaEl: HTMLTextAreaElement;
  let unsub: (() => void) | null = null;
  let userHasScrolledUp = false;
  let loaded = false;

  $: draftKey = `angel-draft-dm-${agentId}`;

  function saveDraft() {
    if (messageText.trim()) {
      localStorage.setItem(draftKey, messageText);
    } else {
      localStorage.removeItem(draftKey);
    }
  }

  function loadDraft() {
    messageText = localStorage.getItem(draftKey) || '';
    tick().then(autoResize);
  }

  function setup() {
    messages = angel.getDmMessages(agentId);
    loaded = angel.isDmLoaded(agentId);
    angel.loadDm(agentId);
    loadDraft();
    tick().then(scrollToBottom);
  }

  onMount(() => {
    unsub = angel.onDmUpdate(() => {
      const prev = messages;
      messages = angel.getDmMessages(agentId);
      loaded = angel.isDmLoaded(agentId);
      if (messages.length > prev.length && !userHasScrolledUp) {
        tick().then(scrollToBottom);
      }
    });
    setup();
  });

  onDestroy(() => {
    unsub?.();
    saveDraft();
  });

  $: if (agentId) {
    if (unsub) {
      messages = angel.getDmMessages(agentId);
      loaded = angel.isDmLoaded(agentId);
      angel.loadDm(agentId);
      loadDraft();
      tick().then(scrollToBottom);
    }
  }

  function scrollToBottom() {
    if (messagesEl) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  }

  function handleScroll() {
    if (!messagesEl) return;
    const { scrollTop, scrollHeight, clientHeight } = messagesEl;
    userHasScrolledUp = scrollHeight - scrollTop - clientHeight > 80;
  }

  function sendMessage() {
    const text = messageText.trim();
    if (!text) return;
    angel.postDm(agentId, text);
    messageText = '';
    localStorage.removeItem(draftKey);
    userHasScrolledUp = false;
    tick().then(() => {
      autoResize();
      scrollToBottom();
    });
  }

  function isMobile(): boolean {
    return window.matchMedia('(max-width: 1024px)').matches || 'ontouchstart' in window;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey && !isMobile()) {
      e.preventDefault();
      sendMessage();
    }
  }

  function autoResize() {
    if (!textareaEl) return;
    textareaEl.style.height = 'auto';
    const clamped = Math.min(textareaEl.scrollHeight, 168);
    textareaEl.style.height = clamped + 'px';
    textareaEl.style.overflowY = textareaEl.scrollHeight > 168 ? 'auto' : 'hidden';
  }

  function authorColor(author: string): string {
    if (author === 'eli') return 'var(--accent)';
    const colors = ['#22c55e', '#f59e0b', '#ec4899', '#06b6d4', '#8b5cf6'];
    let hash = 0;
    for (let i = 0; i < author.length; i++) hash = (hash * 31 + author.charCodeAt(i)) | 0;
    return colors[Math.abs(hash) % colors.length];
  }

  function authorLabel(author: string): string {
    return author.charAt(0).toUpperCase() + author.slice(1);
  }
</script>

<div class="dm">
  <div class="messages" bind:this={messagesEl} on:scroll={handleScroll}>
    {#each messages as msg, i (msg.id)}
      {#if i === 0 || dayKey(msg.created_at) !== dayKey(messages[i - 1].created_at)}
        <div class="date-line"><span>{dateLabel(msg.created_at)}</span></div>
      {/if}
      <div class="dm-msg" class:own={msg.author === 'eli'}>
        <div class="msg-header">
          <span class="author-tag" style="--author-color: {authorColor(msg.author)}">
            {authorLabel(msg.author)}
          </span>
          <span class="msg-time">{timeLabel(msg.created_at)}</span>
        </div>
        <div class="msg-body prose">
          {@html renderMarkdown(msg.content)}
        </div>
      </div>
    {/each}
    {#if !loaded}
      <div class="empty-dm">Loading…</div>
    {:else if messages.length === 0}
      <div class="empty-dm">No messages yet — say hi to {agentName}</div>
    {/if}
  </div>

  {#if userHasScrolledUp}
    <button class="scroll-bottom-btn" on:click={() => { userHasScrolledUp = false; scrollToBottom(); }} aria-label="Scroll to bottom">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><polyline points="6 9 12 15 18 9"/></svg>
    </button>
  {/if}

  <div class="input-area">
    <div class="input-wrap">
      <textarea
        bind:this={textareaEl}
        bind:value={messageText}
        on:keydown={handleKeydown}
        on:input={() => { autoResize(); saveDraft(); }}
        placeholder="Message {agentName}..."
        rows="1"
      ></textarea>
      <button
        class="send-btn"
        on:click={sendMessage}
        disabled={!messageText.trim()}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
      </button>
    </div>
  </div>
</div>

<style>
  .dm {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    position: relative;
    overflow: hidden;
  }

  .messages {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    overscroll-behavior: contain;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .date-line {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 8px 0;
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

  .dm-msg {
    padding: 6px 12px;
    border-radius: 8px;
    max-width: 100%;
    min-width: 0;
  }
  .dm-msg:hover {
    background: var(--bg-hover);
  }

  .msg-header {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-bottom: 2px;
  }

  .author-tag {
    font-size: 0.82rem;
    font-weight: 600;
    color: var(--author-color, var(--text-primary));
  }

  .msg-time {
    font-size: 0.7rem;
    color: var(--text-secondary);
  }

  .msg-body {
    font-size: 0.95rem;
    line-height: 1.5;
    color: var(--text-primary);
    overflow-wrap: break-word;
    min-width: 0;
  }

  .empty-dm {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-secondary);
    font-size: 0.9rem;
  }

  .scroll-bottom-btn {
    position: absolute;
    bottom: 80px;
    right: 24px;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    border: 1px solid var(--border);
    background: var(--bg-surface);
    color: var(--text-secondary);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
    z-index: 5;
    transition: color 0.15s, border-color 0.15s;
  }
  .scroll-bottom-btn:hover {
    color: var(--accent);
    border-color: var(--accent);
  }

  .input-area {
    padding: 12px 16px calc(12px + var(--safe-bottom));
    border-top: 1px solid var(--border);
    background: var(--bg-surface);
    flex-shrink: 0;
  }

  .input-wrap {
    display: flex;
    align-items: flex-end;
    gap: 8px;
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
    overscroll-behavior: contain;
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
</style>
