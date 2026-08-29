<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { angel } from '../streamManager';
  import type { ChatroomMessageRow, WallPinRow } from '../../worker/types';
  import { renderMarkdown, dayKey, dateLabel, timeLabel } from '../util';

  export let showWall = false;

  let messages: ChatroomMessageRow[] = [];
  let wallPins: WallPinRow[] = [];
  let messageText = '';
  let messagesEl: HTMLDivElement;
  let textareaEl: HTMLTextAreaElement;
  let unsub: (() => void) | null = null;
  let wallUnsub: (() => void) | null = null;
  let userHasScrolledUp = false;

  const DRAFT_KEY = 'angel-draft-chatroom';

  function saveDraft() {
    if (messageText.trim()) {
      localStorage.setItem(DRAFT_KEY, messageText);
    } else {
      localStorage.removeItem(DRAFT_KEY);
    }
  }

  function loadDraft() {
    messageText = localStorage.getItem(DRAFT_KEY) || '';
    tick().then(autoResize);
  }

  onMount(() => {
    unsub = angel.onRoomUpdate(() => {
      const prev = messages;
      messages = angel.getRoomMessages();
      if (messages.length > prev.length && !userHasScrolledUp) {
        tick().then(scrollToBottom);
      }
    });
    wallUnsub = angel.onWallUpdate(() => {
      wallPins = angel.getWallPins();
    });
    angel.loadRoom();
    angel.loadWall();
    loadDraft();
    tick().then(scrollToBottom);
  });

  onDestroy(() => {
    unsub?.();
    wallUnsub?.();
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
    userHasScrolledUp = scrollHeight - scrollTop - clientHeight > 80;
  }

  function sendMessage() {
    const text = messageText.trim();
    if (!text) return;
    angel.postToRoom(text);
    messageText = '';
    localStorage.removeItem(DRAFT_KEY);
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

  function togglePin(msgId: number) {
    if (angel.isOnWall(msgId)) {
      angel.unpinFromWall(msgId);
    } else {
      angel.pinToWall(msgId);
    }
  }

  function scrollToMessage(messageId: number) {
    showWall = false;
    tick().then(() => {
      const el = messagesEl?.querySelector(`[data-msg-id="${messageId}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('highlight');
        setTimeout(() => el.classList.remove('highlight'), 1500);
      }
    });
  }

</script>

<div class="chatroom">
  {#if showWall}
    <button class="drawer-scrim" on:click={() => showWall = false} aria-label="Close wall"></button>
    <div class="wall-drawer">
      <div class="drawer-header">
        <span class="drawer-title">Wall</span>
        <span class="drawer-count">{wallPins.length} pin{wallPins.length !== 1 ? 's' : ''}</span>
      </div>
      <div class="drawer-body">
        {#each wallPins as pin (pin.id)}
          <div class="wall-pin">
            <div class="pin-reason">{pin.reason || pin.content.slice(0, 120)}</div>
            <div class="pin-foot">
              <button class="pin-source" on:click={() => scrollToMessage(pin.message_id)} title="Jump to message">
                <span class="source-author" style="--author-color: {authorColor(pin.author)}">{authorLabel(pin.author)}</span>
                <span class="source-sep">&middot;</span>
                <span class="source-time">{timeLabel(pin.message_created_at)}</span>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12"><polyline points="9 18 15 12 9 6"/></svg>
              </button>
              <span class="pin-by">pinned by {authorLabel(pin.pinned_by)}</span>
              <button class="action-btn unpin-btn" on:click={() => angel.unpinFromWall(pin.message_id)} title="Unpin">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
          </div>
        {/each}
        {#if wallPins.length === 0}
          <div class="empty-wall">The wall is empty</div>
        {/if}
      </div>
    </div>
  {/if}

  <div class="messages" bind:this={messagesEl} on:scroll={handleScroll}>
    {#each messages as msg, i (msg.id)}
      {#if i === 0 || dayKey(msg.created_at) !== dayKey(messages[i - 1].created_at)}
        <div class="date-line"><span>{dateLabel(msg.created_at)}</span></div>
      {/if}
      <div class="room-msg" class:own={msg.author === 'eli'} class:on-wall={angel.isOnWall(msg.id)} data-msg-id={msg.id}>
        <div class="msg-header">
          <span class="author-tag" style="--author-color: {authorColor(msg.author)}">
            {authorLabel(msg.author)}
          </span>
          <span class="msg-time">{timeLabel(msg.created_at)}</span>
          <button class="pin-btn" class:pinned={angel.isOnWall(msg.id)} on:click={() => togglePin(msg.id)} title={angel.isOnWall(msg.id) ? 'Unpin from wall' : 'Pin to wall'}>
            &#x1f4cc;
          </button>
        </div>
        <div class="msg-body" class:prose={msg.author !== 'eli'}>
          {#if msg.author === 'eli'}
            <div class="msg-text">{msg.content}</div>
          {:else}
            {@html renderMarkdown(msg.content)}
          {/if}
        </div>
      </div>
    {/each}
    {#if messages.length === 0}
      <div class="empty-room">No messages yet</div>
    {/if}
  </div>

  <div class="input-area">
    <div class="input-wrap">
      <textarea
        bind:this={textareaEl}
        bind:value={messageText}
        on:keydown={handleKeydown}
        on:input={() => { autoResize(); saveDraft(); }}
        placeholder="Post to chatroom..."
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
  .chatroom {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    position: relative;
    overflow: hidden;
  }

  /* Wall drawer */
  .drawer-scrim {
    position: absolute;
    inset: 0;
    z-index: 10;
    background: rgba(0, 0, 0, 0.3);
    border: none;
    cursor: default;
  }

  .wall-drawer {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    max-height: 70%;
    z-index: 11;
    background: var(--bg-sidebar);
    border-bottom: 1px solid var(--border);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
    display: flex;
    flex-direction: column;
    animation: slideDown 0.2s ease-out;
  }

  @keyframes slideDown {
    from { transform: translateY(-100%); opacity: 0; }
    to { transform: translateY(0); opacity: 1; }
  }

  .drawer-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .drawer-title {
    font-size: 0.9rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .drawer-count {
    font-size: 0.75rem;
    color: var(--text-secondary);
  }

  .drawer-body {
    overflow-y: auto;
    padding: 8px 16px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .empty-wall {
    padding: 24px 0;
    text-align: center;
    color: var(--text-secondary);
    font-size: 0.85rem;
  }

  .wall-pin {
    padding: 10px 12px;
    border-left: 2px solid var(--accent);
    border-radius: 0 6px 6px 0;
  }
  .wall-pin:hover {
    background: var(--bg-hover);
  }

  .pin-reason {
    font-size: 0.9rem;
    line-height: 1.45;
    color: var(--text-primary);
    margin-bottom: 6px;
  }

  .pin-foot {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.72rem;
    color: var(--text-secondary);
  }

  .pin-source {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    border: none;
    background: none;
    padding: 0;
    cursor: pointer;
    font-size: inherit;
    color: var(--text-secondary);
    line-height: 1;
  }
  .pin-source:hover {
    color: var(--accent);
  }
  .pin-source svg {
    opacity: 0;
    transition: opacity 0.15s;
  }
  .pin-source:hover svg {
    opacity: 1;
  }

  .source-author {
    color: var(--author-color, var(--text-secondary));
    font-weight: 500;
  }

  .pin-by {
    margin-left: auto;
    opacity: 0.6;
  }

  .action-btn {
    border: none;
    background: none;
    color: var(--text-secondary);
    cursor: pointer;
    padding: 2px;
    border-radius: 4px;
    opacity: 0;
    transition: opacity 0.15s;
  }
  .wall-pin:hover .action-btn {
    opacity: 0.4;
  }
  .action-btn:hover {
    opacity: 1 !important;
    background: var(--bg-active);
  }

  /* Messages */
  .messages {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
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

  .room-msg {
    padding: 6px 12px;
    border-radius: 8px;
    max-width: 100%;
    position: relative;
  }
  .room-msg:hover {
    background: var(--bg-hover);
  }
  .room-msg.on-wall {
    border-left: 2px solid var(--accent);
  }

  :global(.room-msg.highlight) {
    animation: flash 1.5s ease-out;
  }
  @keyframes flash {
    0%, 20% { background: color-mix(in srgb, var(--accent) 20%, transparent); }
    100% { background: transparent; }
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

  .pin-btn {
    border: none;
    background: none;
    cursor: pointer;
    font-size: 0.7rem;
    opacity: 0;
    transition: opacity 0.15s;
    padding: 0 2px;
    line-height: 1;
    filter: grayscale(1);
  }
  .room-msg:hover .pin-btn {
    opacity: 0.5;
  }
  .pin-btn:hover {
    opacity: 1 !important;
    filter: none !important;
  }
  .pin-btn.pinned {
    opacity: 0.7;
    filter: none;
  }

  .msg-body {
    font-size: 0.95rem;
    line-height: 1.5;
    color: var(--text-primary);
  }

  .msg-text {
    white-space: pre-wrap;
    word-wrap: break-word;
  }

  .empty-room {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-secondary);
    font-size: 0.9rem;
  }

  .input-area {
    padding: 12px 16px;
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
