<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { angel } from './streamManager';
  import Login from './pages/Login.svelte';
  import Chat from './pages/Chat.svelte';

  let connState = angel.getConnState();
  let conversations = angel.getConversations();
  let currentChatId: string | null = null;
  let menuOpen = false;
  let darkMode = false;

  let unsub: (() => void) | null = null;

  $: if (currentChatId) {
    localStorage.setItem('lastConversationId', currentChatId);
  }

  onMount(() => {
    darkMode = localStorage.getItem('darkMode') === 'true' ||
      (!localStorage.getItem('darkMode') && window.matchMedia('(prefers-color-scheme: dark)').matches);
    applyDarkMode(darkMode);

    unsub = angel.subscribe(() => {
      connState = angel.getConnState();
      conversations = angel.getConversations();

      // Auto-select newly created conversation
      if (conversations.length > 0 && !currentChatId) {
        const last = localStorage.getItem('lastConversationId');
        if (last && conversations.some(c => c.id === last)) {
          currentChatId = last;
          angel.loadConversation(last);
        }
      }
    });

    // Try to connect with saved PIN
    const savedPin = localStorage.getItem('pin');
    if (savedPin) {
      angel.connect(savedPin);
    }
  });

  onDestroy(() => {
    unsub?.();
  });

  function applyDarkMode(dark: boolean) {
    document.documentElement.classList.toggle('dark', dark);
    localStorage.setItem('darkMode', String(dark));
    const meta = document.querySelector('meta[name="theme-color"]') as HTMLMetaElement;
    if (meta) meta.content = dark ? '#1e1e2e' : '#6366f1';
  }

  function handleLogin(event: CustomEvent<string>) {
    localStorage.setItem('pin', event.detail);
    angel.connect(event.detail);
  }

  function newConversation() {
    angel.createConversation();
    // The conv:created event will add it to the list;
    // we set currentChatId when the event arrives
    const convUnsub = angel.subscribe(() => {
      const convs = angel.getConversations();
      if (convs.length > 0 && convs[0].id !== currentChatId) {
        currentChatId = convs[0].id;
        angel.loadConversation(convs[0].id);
        menuOpen = false;
        convUnsub();
      }
    });
  }

  function selectConversation(id: string) {
    currentChatId = id;
    angel.loadConversation(id);
    menuOpen = false;
  }

  function archiveConversation(id: string) {
    angel.archiveConversation(id);
    if (currentChatId === id) currentChatId = null;
  }

  function toggleDark() {
    darkMode = !darkMode;
    applyDarkMode(darkMode);
  }

  $: needsAuth = connState === 'disconnected' && !localStorage.getItem('pin');
  $: authFailed = connState === 'disconnected' && !!localStorage.getItem('pin');
</script>

{#if needsAuth || authFailed}
  <Login on:login={handleLogin} failed={authFailed} />
{:else}
  <div class="app" class:menu-open={menuOpen}>
    <!-- Sidebar -->
    <aside class="sidebar" class:open={menuOpen}>
      <div class="sidebar-header">
        <h1>Angel</h1>
        <div class="header-actions">
          {#if connState === 'reconnecting' || connState === 'connecting'}
            <span class="status-dot reconnecting" title="Reconnecting..."></span>
          {:else if connState === 'connected'}
            <span class="status-dot connected" title="Connected"></span>
          {/if}
          <button class="icon-btn" on:click={toggleDark} title="Toggle dark mode">
            {#if darkMode}☀{:else}☾{/if}
          </button>
        </div>
      </div>
      <button class="new-chat-btn" on:click={newConversation}>
        New conversation
      </button>
      <div class="conversation-list">
        {#each conversations as conv (conv.id)}
          <button
            class="conv-item"
            class:active={currentChatId === conv.id}
            on:click={() => selectConversation(conv.id)}
          >
            <span class="conv-title">{conv.title || 'New conversation'}</span>
            <button
              class="archive-btn"
              on:click|stopPropagation={() => archiveConversation(conv.id)}
              title="Archive"
            >×</button>
          </button>
        {/each}
      </div>
    </aside>

    <!-- Main -->
    <main class="main">
      <header class="app-bar">
        <button class="menu-btn" on:click={() => menuOpen = !menuOpen}>
          ☰
        </button>
        <span class="app-bar-title">
          {#if currentChatId}
            {conversations.find(c => c.id === currentChatId)?.title || 'New conversation'}
          {:else}
            Angel
          {/if}
        </span>
      </header>

      {#if currentChatId}
        <Chat conversationId={currentChatId} />
      {:else}
        <div class="empty-state">
          <p>Start a new conversation</p>
          <button class="new-chat-btn" on:click={newConversation}>New conversation</button>
        </div>
      {/if}
    </main>

    {#if menuOpen}
      <div class="overlay" on:click={() => menuOpen = false} on:keydown={() => {}}></div>
    {/if}
  </div>
{/if}

<style>
  .app {
    display: flex;
    height: 100dvh;
    overflow: hidden;
  }

  .sidebar {
    width: 280px;
    background: var(--bg-sidebar);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    transition: transform 0.2s ease;
  }

  .sidebar-header {
    padding: 16px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid var(--border);
  }

  .sidebar-header h1 {
    font-size: 1.2rem;
    font-weight: 600;
    margin: 0;
    color: var(--text-primary);
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }
  .status-dot.connected { background: #22c55e; }
  .status-dot.reconnecting { background: #f59e0b; animation: pulse 1.5s infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

  .icon-btn {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 1.2rem;
    color: var(--text-secondary);
    padding: 4px 8px;
    border-radius: 6px;
  }
  .icon-btn:hover { background: var(--bg-hover); }

  .new-chat-btn {
    margin: 12px 16px;
    padding: 10px;
    background: var(--accent);
    color: white;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    font-size: 0.9rem;
    font-weight: 500;
  }
  .new-chat-btn:hover { opacity: 0.9; }

  .conversation-list {
    flex: 1;
    overflow-y: auto;
    padding: 0 8px;
  }

  .conv-item {
    width: 100%;
    padding: 10px 12px;
    background: none;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    text-align: left;
    display: flex;
    align-items: center;
    justify-content: space-between;
    color: var(--text-primary);
    font-size: 0.85rem;
    margin-bottom: 2px;
  }
  .conv-item:hover { background: var(--bg-hover); }
  .conv-item.active { background: var(--bg-active); }

  .conv-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }

  .archive-btn {
    background: none;
    border: none;
    color: var(--text-secondary);
    cursor: pointer;
    opacity: 0;
    padding: 2px 6px;
    font-size: 1.1rem;
    border-radius: 4px;
  }
  .conv-item:hover .archive-btn { opacity: 1; }
  .archive-btn:hover { background: var(--bg-hover); }

  .main {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .app-bar {
    height: 52px;
    display: flex;
    align-items: center;
    padding: 0 16px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-surface);
    flex-shrink: 0;
  }

  .menu-btn {
    display: none;
    background: none;
    border: none;
    font-size: 1.3rem;
    cursor: pointer;
    color: var(--text-primary);
    padding: 4px 8px;
    margin-right: 8px;
  }

  .app-bar-title {
    font-size: 0.95rem;
    font-weight: 500;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .empty-state {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 16px;
    color: var(--text-secondary);
  }

  .overlay { display: none; }

  @media (max-width: 768px) {
    .sidebar {
      position: fixed;
      left: 0; top: 0; bottom: 0;
      z-index: 100;
      transform: translateX(-100%);
    }
    .sidebar.open { transform: translateX(0); }
    .menu-btn { display: block; }
    .overlay {
      display: block;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.4);
      z-index: 99;
    }
  }
</style>
