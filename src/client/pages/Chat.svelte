<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { angel } from '../streamManager';
  import type { ConversationState, StreamPart } from '../streamManager';

  export let conversationId: string;

  let messageText = '';
  let messagesEl: HTMLDivElement;
  let textareaEl: HTMLTextAreaElement;
  let unsub: (() => void) | null = null;
  let convState: ConversationState;
  let userHasScrolledUp = false;

  $: convState = angel.getConvState(conversationId);
  $: streaming = convState?.streamState === 'streaming';

  onMount(() => {
    unsub = angel.subscribe(() => {
      convState = angel.getConvState(conversationId);
      if (!userHasScrolledUp) {
        tick().then(scrollToBottom);
      }
    });
    angel.loadConversation(conversationId);
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
    userHasScrolledUp = scrollHeight - scrollTop - clientHeight > 100;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  function sendMessage() {
    const text = messageText.trim();
    if (!text || streaming) return;
    angel.sendChat(conversationId, text);
    messageText = '';
    userHasScrolledUp = false;
    tick().then(() => {
      if (textareaEl) textareaEl.style.height = 'auto';
      scrollToBottom();
    });
  }

  function autoResize() {
    if (!textareaEl) return;
    textareaEl.style.height = 'auto';
    textareaEl.style.height = Math.min(textareaEl.scrollHeight, 168) + 'px';
  }

  function renderContent(content: string): string {
    return content
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/\n/g, '<br>');
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
</script>

<div class="chat">
  <div class="messages" bind:this={messagesEl} on:scroll={handleScroll}>
    {#if convState}
      {#each convState.messages as msg (msg.id + msg.created_at)}
        {#if msg.role === 'user'}
          <div class="message user">
            <div class="message-content">{msg.content}</div>
          </div>
        {:else if msg.role === 'assistant'}
          <div class="message assistant">
            <div class="message-content">
              {@html renderContent(msg.content)}
              {#if msg.tool_calls}
                {@const tools = typeof msg.tool_calls === 'string' ? JSON.parse(msg.tool_calls) : msg.tool_calls}
                <div class="tool-actions">
                  {#each tools as tool}
                    <span class="tool-pill" title={tool.name}>
                      {tool.label || toolLabel(tool.name)}
                    </span>
                  {/each}
                </div>
              {/if}
            </div>
          </div>
        {/if}
      {/each}

      <!-- Streaming content - interleaved -->
      {#if streaming && convState.streamParts.length > 0}
        <div class="message assistant streaming">
          <div class="message-content">
            {#each convState.streamParts as part}
              {#if part.type === 'text'}
                {@html renderContent(part.content)}
              {:else}
                <span class="tool-pill {part.result ? 'done' : 'active'}" title={part.name}>
                  {part.label || toolLabel(part.name)}
                  {#if !part.result}
                    <span class="tool-dot"></span>
                  {/if}
                </span>
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
    <textarea
      bind:this={textareaEl}
      bind:value={messageText}
      on:keydown={handleKeydown}
      on:input={autoResize}
      placeholder="Message Angel..."
      rows="1"
      disabled={streaming}
    ></textarea>
    <button
      class="send-btn"
      on:click={sendMessage}
      disabled={!messageText.trim() || streaming}
    >
      {#if streaming}
        ...
      {:else}
        ↑
      {/if}
    </button>
  </div>
</div>

<style>
  .chat {
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
    gap: 12px;
  }

  .message {
    max-width: 80%;
    padding: 10px 14px;
    border-radius: 16px;
    font-size: 0.9rem;
    line-height: 1.5;
    word-wrap: break-word;
  }

  .message.user {
    align-self: flex-end;
    background: var(--accent);
    color: white;
    border-bottom-right-radius: 4px;
    white-space: pre-wrap;
  }

  .message.assistant {
    align-self: flex-start;
    background: var(--bg-message);
    color: var(--text-primary);
    border-bottom-left-radius: 4px;
  }

  .message-content :global(pre) {
    background: var(--bg-code);
    padding: 8px 12px;
    border-radius: 8px;
    overflow-x: auto;
    font-size: 0.82rem;
    margin: 8px 0;
  }

  .message-content :global(code) {
    background: var(--bg-code);
    padding: 1px 4px;
    border-radius: 4px;
    font-size: 0.85em;
  }

  .message-content :global(pre code) {
    background: none;
    padding: 0;
  }

  .message-content :global(a) {
    color: var(--accent);
    text-decoration: underline;
  }

  .tool-actions {
    margin-top: 6px;
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .tool-pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 0.72rem;
    color: var(--text-secondary);
    background: var(--bg-code);
    padding: 2px 8px;
    border-radius: 10px;
    white-space: nowrap;
  }

  .tool-pill.active {
    color: var(--accent);
  }

  .tool-dot {
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
    animation: pulse 1.2s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 0.4; }
    50% { opacity: 1; }
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

  .input-area {
    padding: 12px 16px;
    border-top: 1px solid var(--border);
    display: flex;
    gap: 8px;
    align-items: flex-end;
    background: var(--bg-surface);
  }

  textarea {
    flex: 1;
    resize: none;
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 10px 14px;
    font-size: 0.9rem;
    font-family: inherit;
    background: var(--bg-input);
    color: var(--text-primary);
    line-height: 1.4;
    max-height: 168px;
  }
  textarea:focus {
    outline: none;
    border-color: var(--accent);
  }
  textarea:disabled {
    opacity: 0.6;
  }

  .send-btn {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    border: none;
    background: var(--accent);
    color: white;
    font-size: 1.2rem;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  .send-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
</style>
