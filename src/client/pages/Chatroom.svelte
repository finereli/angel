<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { angel } from '../streamManager';
  import type { ChatroomMessageRow } from '../../worker/types';
  import { renderMarkdown, dayKey, dateLabel, timeLabel } from '../util';

  let messages: ChatroomMessageRow[] = [];
  let messageText = '';
  let messagesEl: HTMLDivElement;
  let textareaEl: HTMLTextAreaElement;
  let unsub: (() => void) | null = null;
  let userHasScrolledUp = false;

  onMount(() => {
    unsub = angel.onRoomUpdate(() => {
      const prev = messages;
      messages = angel.getRoomMessages();
      if (messages.length > prev.length && !userHasScrolledUp) {
        tick().then(scrollToBottom);
      }
    });
    angel.loadRoom();
    tick().then(scrollToBottom);
  });

  onDestroy(() => {
    unsub?.();
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
    textareaEl.style.height = Math.min(textareaEl.scrollHeight, 168) + 'px';
  }

  function authorColor(author: string): string {
    if (author === 'eli') return 'var(--accent)';
    // Distinct hues for different agents
    const colors = ['#22c55e', '#f59e0b', '#ec4899', '#06b6d4', '#8b5cf6'];
    let hash = 0;
    for (let i = 0; i < author.length; i++) hash = (hash * 31 + author.charCodeAt(i)) | 0;
    return colors[Math.abs(hash) % colors.length];
  }

  function authorLabel(author: string): string {
    return author.charAt(0).toUpperCase() + author.slice(1);
  }

</script>

<div class="chatroom">
  <div class="messages" bind:this={messagesEl} on:scroll={handleScroll}>
    {#each messages as msg, i (msg.id)}
      {#if i === 0 || dayKey(msg.created_at) !== dayKey(messages[i - 1].created_at)}
        <div class="date-line"><span>{dateLabel(msg.created_at)}</span></div>
      {/if}
      <div class="room-msg" class:own={msg.author === 'eli'}>
        <div class="msg-header">
          <span class="author-tag" style="--author-color: {authorColor(msg.author)}">
            {authorLabel(msg.author)}
          </span>
          <span class="msg-time">{timeLabel(msg.created_at)}</span>
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
        on:input={autoResize}
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
  }

  .messages {
    flex: 1;
    overflow-y: auto;
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
  }
  .room-msg:hover {
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
