<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { angel } from './streamManager';
  import Login from './pages/Login.svelte';
  import Chat from './pages/Chat.svelte';
  import Settings from './pages/Settings.svelte';
  import ResetButton from './ResetButton.svelte';

  let connState = angel.getConnState();
  let agent = angel.getAgent();
  let currentChatId: string | null = null;
  let menuOpen = false;
  let darkMode = false;
  let agentLoaded = angel.hasLoadedAgent();
  let view: 'chat' | 'settings' = 'chat';

  let unsub: (() => void) | null = null;
  let busy = false;

  $: agentName = agent?.name || 'Angel';

  onMount(() => {
    darkMode = localStorage.getItem('darkMode') === 'true' ||
      (!localStorage.getItem('darkMode') && window.matchMedia('(prefers-color-scheme: dark)').matches);
    applyDarkMode(darkMode);

    unsub = angel.subscribe(() => {
      connState = angel.getConnState();
      agent = angel.getAgent();
      agentLoaded = angel.hasLoadedAgent();
      busy = !!currentChatId && angel.getConvState(currentChatId).streamState === 'streaming';

      // One agent, one conversation: open it as soon as we know which it is.
      if (agent && currentChatId !== agent.conversationId) {
        currentChatId = agent.conversationId;
        angel.loadConversation(currentChatId);
      }
    });

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
        <div class="brand">
          <h1>{agentName}</h1>
          {#if connState === 'connected'}
            <span class="status-dot connected" title="Connected"></span>
          {:else}
            <span class="status-dot reconnecting" title="Connecting..."></span>
          {/if}
        </div>
      </div>
      <div class="channel-list">
        <button class="channel-item" class:active={view === 'chat'} on:click={() => { view = 'chat'; menuOpen = false; }}>
          <span class="channel-icon">&amp;</span>
          <span class="channel-name">{agentName}</span>
          {#if busy}
            <span class="busy-dot" title="Responding..."></span>
          {/if}
        </button>
        <button class="channel-item" class:active={view === 'settings'} on:click={() => { view = 'settings'; menuOpen = false; }}>
          <span class="channel-icon">&#9881;</span>
          <span class="channel-name">Settings</span>
        </button>
      </div>
      <div class="sidebar-footer">
        <button class="footer-btn" on:click={toggleDark}>
          <span class="footer-icon">{#if darkMode}&#9728;{:else}&#9790;{/if}</span>
          <span>{darkMode ? 'Light mode' : 'Dark mode'}</span>
        </button>
        <div class="version-row">
          <span class="version">v{__BUILD__}</span>
          <ResetButton />
        </div>
      </div>
    </aside>

    <!-- Main -->
    <main class="main">
      <header class="app-bar">
        <button class="menu-btn" on:click={() => menuOpen = !menuOpen}>
          &#9776;
        </button>
        <span class="app-bar-title">{view === 'settings' ? 'Settings' : agentName}</span>
      </header>

      {#if view === 'settings'}
        <Settings />
      {:else if currentChatId}
        <Chat conversationId={currentChatId} />
      {:else if agentLoaded && !agent}
        <div class="empty-state">
          <p>No agent configured</p>
        </div>
      {:else}
        <div class="loading-state">Loading...</div>
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
    height: 100%;
    overflow: hidden;
  }

  .sidebar {
    width: 260px;
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

  .brand {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .channel-list {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
  }

  .channel-item {
    width: 100%;
    padding: 8px 12px;
    background: none;
    border: none;
    border-left: 2px solid transparent;
    border-radius: 0 8px 8px 0;
    cursor: pointer;
    text-align: left;
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--text-primary);
    font-size: 0.9rem;
    margin-bottom: 1px;
  }
  .channel-item:hover { background: var(--bg-hover); }
  .channel-item.active {
    background: var(--bg-active);
    border-left-color: var(--accent);
  }

  .channel-icon {
    font-weight: 700;
    font-size: 1rem;
    color: var(--text-secondary);
    width: 1.2em;
    text-align: center;
    flex-shrink: 0;
  }
  .channel-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sidebar-footer {
    border-top: 1px solid var(--border);
    padding: 8px;
  }
  .footer-btn {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    background: none;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    color: var(--text-primary);
    font-size: 0.85rem;
    text-align: left;
  }
  .footer-btn:hover { background: var(--bg-hover); }
  .footer-icon { width: 1.2em; text-align: center; }

  .version-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 12px 2px;
    color: var(--text-secondary);
    font-size: 0.75rem;
  }

  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }
  .busy-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
    margin-left: auto;
    flex-shrink: 0;
    animation: pulse 1.5s infinite;
  }
  .status-dot.connected { background: #22c55e; }
  .status-dot.reconnecting { background: #f59e0b; animation: pulse 1.5s infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

  .main {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
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
    flex: 1;
    min-width: 0;
    text-align: left;
    font-size: 0.95rem;
    font-weight: 500;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .loading-state {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-secondary);
    font-size: 0.9rem;
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
