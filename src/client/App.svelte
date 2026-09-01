<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { angel } from './streamManager';
  import Login from './pages/Login.svelte';
  import Chat from './pages/Chat.svelte';
  import Chatroom from './pages/Chatroom.svelte';
  import DM from './pages/DM.svelte';

  let connState = angel.getConnState();
  let agents = angel.getAgents();
  let currentChatId: string | null = null;
  let menuOpen = false;
  let darkMode = false;
  let appMenuOpen = false;
  let agentsLoaded = angel.hasLoadedAgents();
  type View = 'chat' | 'room' | 'dm';
  let view: View = (localStorage.getItem('lastView') as View) || 'chat';
  let showWall = false;
  let dmAgentId: string | null = localStorage.getItem('lastDmAgentId');
  let channelsOpen = false;

  let unsub: (() => void) | null = null;

  $: if (currentChatId) {
    localStorage.setItem('lastConversationId', currentChatId);
  }

  $: localStorage.setItem('lastView', view);

  $: currentAgentName = agents.find(a => a.conversationId === currentChatId)?.name || '';
  $: dmAgentName = agents.find(a => a.id === dmAgentId)?.name || '';
  $: if (dmAgentId) localStorage.setItem('lastDmAgentId', dmAgentId);

  onMount(() => {
    darkMode = localStorage.getItem('darkMode') === 'true' ||
      (!localStorage.getItem('darkMode') && window.matchMedia('(prefers-color-scheme: dark)').matches);
    applyDarkMode(darkMode);

    unsub = angel.subscribe(() => {
      connState = angel.getConnState();
      agents = angel.getAgents();
      agentsLoaded = angel.hasLoadedAgents();

      if (agents.length > 0 && !currentChatId) {
        const last = localStorage.getItem('lastConversationId');
        const pick = (last && agents.some(a => a.conversationId === last))
          ? last
          : agents[0]?.conversationId;
        if (pick) {
          currentChatId = pick;
          angel.loadConversation(pick);
        }
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

  function selectAgent(conversationId: string) {
    currentChatId = conversationId;
    view = 'chat';
    angel.loadConversation(conversationId);
    menuOpen = false;
  }

  function selectRoom() {
    view = 'room';
    menuOpen = false;
  }

  function selectDm(agentId: string) {
    dmAgentId = agentId;
    view = 'dm';
    menuOpen = false;
  }

  function toggleDark() {
    darkMode = !darkMode;
    applyDarkMode(darkMode);
  }

  async function hardReload() {
    appMenuOpen = false;
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(r => r.unregister()));
      }
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      }
    } catch {}
    location.reload();
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
          <h1>Angel</h1>
          {#if connState === 'connected'}
            <span class="status-dot connected" title="Connected"></span>
          {:else}
            <span class="status-dot reconnecting" title="Connecting..."></span>
          {/if}
        </div>
      </div>
      <div class="channel-list">
        <div class="section-label">Direct messages</div>

        {#each agents as agent (agent.id)}
          <button
            class="channel-item"
            class:active={view === 'dm' && dmAgentId === agent.id}
            on:click={() => selectDm(agent.id)}
          >
            <span class="channel-icon dm">@</span>
            <span class="channel-name">{agent.name}</span>
          </button>
        {/each}

        <button class="section-label toggle" on:click={() => channelsOpen = !channelsOpen}>
          <span class="toggle-arrow" class:open={channelsOpen}>{channelsOpen ? '▾' : '▸'}</span>
          Channels
        </button>

        {#if channelsOpen}
          <button
            class="channel-item room"
            class:active={view === 'room'}
            on:click={selectRoom}
          >
            <span class="channel-icon">&amp;</span>
            <span class="channel-name">chatroom</span>
          </button>

          {#each agents as agent (agent.id)}
            <button
              class="channel-item"
              class:active={view === 'chat' && currentChatId === agent.conversationId}
              on:click={() => selectAgent(agent.conversationId)}
            >
              <span class="channel-icon">&amp;</span>
              <span class="channel-name">{agent.name}</span>
            </button>
          {/each}
        {/if}
      </div>
      <div class="sidebar-footer">
        <button class="footer-btn" on:click={toggleDark}>
          <span class="footer-icon">{#if darkMode}&#9728;{:else}&#9790;{/if}</span>
          <span>{darkMode ? 'Light mode' : 'Dark mode'}</span>
        </button>
      </div>
    </aside>

    <!-- Main -->
    <main class="main">
      <header class="app-bar">
        <button class="menu-btn" on:click={() => menuOpen = !menuOpen}>
          &#9776;
        </button>
        <span class="app-bar-title">
          {#if view === 'room'}
            &amp; chatroom
          {:else if view === 'dm' && dmAgentName}
            @ {dmAgentName}
          {:else if view === 'chat' && currentAgentName}
            &amp; {currentAgentName}
          {:else}
            Angel
          {/if}
        </span>
        {#if view === 'room'}
          <button class="icon-btn wall-btn" class:active={showWall} on:click={() => showWall = !showWall} title="Wall">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20"><path d="M12 2 L12 8 M12 8 L8 4 M12 8 L16 4 M12 8 L12 15 M4 15 L20 15 L20 22 L4 22 Z"/></svg>
          </button>
        {/if}
        <div class="app-menu">
          <button class="icon-btn kebab" on:click={() => appMenuOpen = !appMenuOpen} title="Menu">
            <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
          </button>
          {#if appMenuOpen}
            <div class="app-menu-dropdown">
              <button class="app-menu-item" on:click={hardReload}>Reload</button>
            </div>
          {/if}
        </div>
      </header>
      {#if appMenuOpen}
        <button class="menu-scrim" on:click={() => appMenuOpen = false} aria-label="Close menu"></button>
      {/if}

      {#if view === 'room'}
        <Chatroom bind:showWall />
      {:else if view === 'dm' && dmAgentId}
        <DM agentId={dmAgentId} agentName={dmAgentName} />
      {:else if view === 'chat' && currentChatId}
        <Chat conversationId={currentChatId} />
      {:else if agentsLoaded && agents.length === 0}
        <div class="empty-state">
          <p>No agents configured</p>
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

  .section-label {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-secondary);
    padding: 16px 12px 4px;
    font-weight: 600;
  }
  .section-label.toggle {
    width: 100%;
    background: none;
    border: none;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 4px;
    text-align: left;
  }
  .section-label.toggle:hover { color: var(--text-primary); }
  .toggle-arrow {
    font-size: 0.6rem;
    width: 0.8em;
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
  .channel-icon.dm {
    font-size: 0.85rem;
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
  .wall-btn.active { color: var(--accent); }

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

  .app-menu { position: relative; flex-shrink: 0; }
  .kebab { display: flex; align-items: center; justify-content: center; }
  .app-menu-dropdown {
    position: absolute;
    top: 100%;
    right: 0;
    margin-top: 4px;
    min-width: 140px;
    padding: 4px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
    z-index: 200;
  }
  .app-menu-item {
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    color: var(--text-primary);
    padding: 8px 12px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.9rem;
  }
  .app-menu-item:hover { background: var(--bg-hover); }
  .menu-scrim {
    position: fixed;
    inset: 0;
    z-index: 150;
    background: transparent;
    border: none;
    cursor: default;
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
