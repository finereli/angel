<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { angel } from '../streamManager';
  import type { ChatroomMessageRow, WallPinRow } from '../../worker/types';
  import { renderMarkdown, dayKey, dateLabel, timeLabel } from '../util';

  let messages: ChatroomMessageRow[] = [];
  let wallPins: WallPinRow[] = [];
  let messageText = '';
  let messagesEl: HTMLDivElement;
  let textareaEl: HTMLTextAreaElement;
  let unsub: (() => void) | null = null;
  let wallUnsub: (() => void) | null = null;
  let userHasScrolledUp = false;
  let showWall = false;

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
  <div class="view-toggle">
    <button class:active={!showWall} on:click={() => showWall = false}>Room</button>
    <button class:active={showWall} on:click={() => showWall = true}>
      Wall{#if wallPins.length > 0}<span class="pin-count">{wallPins.length}</span>{/if}
    </button>
  </div>

  {#if showWall}
    <div class="messages wall-view">
      {#each wallPins as pin (pin.id)}
        <div class="wall-pin">
          <div class="pin-meta">
            <span class="pin-icon">&#x1f4cc;</span>
            <span class="pinned-by">pinned by {authorLabel(pin.pinned_by)}</span>
            {#if pin.reason}
              <span class="pin-reason">&mdash; {pin.reason}</span>
            {/if}
          </div>
          <div class="room-msg pinned-msg">
            <div class="msg-header">
              <span class="author-tag" style="--author-color: {authorColor(pin.author)}">
                {authorLabel(pin.author)}
              </span>
              <span class="msg-time">{timeLabel(pin.message_created_at)}</span>
            </div>
            <div class="msg-body prose">
              {@html renderMarkdown(pin.content)}
            </div>
            <div class="pin-actions">
              <button class="action-btn jump-btn" on:click={() => scrollToMessage(pin.message_id)} title="Jump to message">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="9 18 15 12 9 6"/></svg>
              </button>
              <button class="action-btn unpin-btn" on:click={() => angel.unpinFromWall(pin.message_id)} title="Unpin">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
          </div>
        </div>
      {/each}
      {#if wallPins.length === 0}
        <div class="empty-room">The wall is empty</div>
      {/if}
    </div>
  {:else}
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
  {/if}
</div>

<style>
  .chatroom {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .view-toggle {
    display: flex;
    gap: 0;
    padding: 8px 16px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-surface);
    flex-shrink: 0;
  }
  .view-toggle button {
    flex: 1;
    padding: 6px 16px;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text-secondary);
    font-size: 0.82rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
  }
  .view-toggle button:first-child {
    border-radius: 8px 0 0 8px;
  }
  .view-toggle button:last-child {
    border-radius: 0 8px 8px 0;
    border-left: none;
  }
  .view-toggle button.active {
    background: var(--bg-hover);
    color: var(--text-primary);
    font-weight: 600;
  }
  .pin-count {
    font-size: 0.7rem;
    background: var(--accent);
    color: white;
    border-radius: 8px;
    padding: 0 5px;
    min-width: 16px;
    text-align: center;
    line-height: 16px;
  }

  .messages {
    flex: 1;
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

  /* Wall view */
  .wall-view {
    gap: 12px;
  }

  .wall-pin {
    border-radius: 8px;
    border: 1px solid var(--border);
    overflow: hidden;
  }

  .pin-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    background: var(--bg-hover);
    font-size: 0.75rem;
    color: var(--text-secondary);
  }
  .pin-icon {
    font-size: 0.7rem;
  }
  .pinned-by {
    font-weight: 500;
  }
  .pin-reason {
    font-style: italic;
  }

  .pinned-msg {
    border-left: none;
  }
  .pinned-msg:hover {
    background: transparent;
  }

  .pin-actions {
    display: flex;
    gap: 4px;
    justify-content: flex-end;
    margin-top: 4px;
  }
  .action-btn {
    border: none;
    background: none;
    color: var(--text-secondary);
    cursor: pointer;
    padding: 4px;
    border-radius: 4px;
    opacity: 0.5;
    transition: opacity 0.15s;
  }
  .action-btn:hover {
    opacity: 1;
    background: var(--bg-hover);
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
