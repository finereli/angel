<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { angel } from './streamManager';
  import Login from './pages/Login.svelte';
  import Chat from './pages/Chat.svelte';
  import Chatroom from './pages/Chatroom.svelte';

  let connState = angel.getConnState();
  let conversations = angel.getConversations();
  let currentChatId: string | null = null;
  let menuOpen = false;
  let darkMode = false;
  let showArchived = false;
  let editingId: string | null = null;
  let editingText = '';
  let appMenuOpen = false;
  let convsLoaded = angel.hasLoadedConversations();
  type View = 'chat' | 'room';
  let view: View = 'chat';

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
      convsLoaded = angel.hasLoadedConversations();

      // Land on the last conversation, or the most recent one if there's no memory of it.
      if (conversations.length > 0 && !currentChatId) {
        const last = localStorage.getItem('lastConversationId');
        const pick = (last && conversations.some(c => c.id === last))
          ? last
          : conversations.find(c => !c.archived)?.id;
        if (pick) {
          currentChatId = pick;
          angel.loadConversation(pick);
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
    const before = new Set(angel.getConversations().map(c => c.id));
    angel.createConversation();
    const off = angel.subscribe(() => {
      const fresh = angel.getConversations().find(c => !before.has(c.id));
      if (fresh) {
        currentChatId = fresh.id;
        angel.loadConversation(fresh.id);
        menuOpen = false;
        off();
      }
    });
  }

  function selectConversation(id: string) {
    currentChatId = id;
    editingId = null;
    angel.loadConversation(id);
    menuOpen = false;
  }

  function archiveConversation(id: string) {
    angel.archiveConversation(id);
    if (currentChatId === id) currentChatId = null;
  }

  function unarchiveConversation(id: string) {
    angel.unarchiveConversation(id);
  }

  // Rename the open conversation by clicking its title in the top bar.
  function startTitleEdit() {
    if (!currentChatId) return;
    const c = conversations.find(x => x.id === currentChatId);
    editingId = currentChatId;
    editingText = c?.title || '';
  }

  function submitRename() {
    const t = editingText.trim();
    if (editingId && t) angel.renameConversation(editingId, t);
    editingId = null;
  }

  function cancelRename() { editingId = null; }

  function renameKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); submitRename(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
  }

  function focusInput(node: HTMLInputElement) { node.focus(); node.select(); }

  function toggleDark() {
    darkMode = !darkMode;
    applyDarkMode(darkMode);
  }

  // Nuke the service-worker cache and reload - for glitches and version updates.
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

  function relativeTime(ts: string): string {
    const diff = Date.now() - new Date(ts).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'now';
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    const days = Math.floor(hrs / 24);
    return `${days}d`;
  }

  $: activeConvs = conversations.filter(c => !c.archived);
  $: archivedConvs = conversations.filter(c => c.archived);

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
            <span class="status-dot reconnecting" title="Connecting…"></span>
          {/if}
        </div>
        <button class="icon-btn new" on:click={newConversation} title="New conversation">+</button>
      </div>
      <div class="view-tabs">
        <button class="view-tab" class:active={view === 'chat'} on:click={() => view = 'chat'}>Threads</button>
        <button class="view-tab" class:active={view === 'room'} on:click={() => { view = 'room'; menuOpen = false; }}>Chatroom</button>
      </div>
      <div class="conversation-list" class:hidden={view !== 'chat'}>
        {#each activeConvs as conv (conv.id)}
          <button
            class="conv-item"
            class:active={currentChatId === conv.id}
            on:click={() => selectConversation(conv.id)}
          >
            <div class="conv-info">
              <span class="conv-title">{conv.title || 'New conversation'}</span>
              <span class="conv-time">{relativeTime(conv.updated_at)}</span>
            </div>
            <button
              class="row-icon archive-btn"
              on:click|stopPropagation={() => archiveConversation(conv.id)}
              title="Archive"
            >
              <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M20.54 5.23l-1.39-1.68C18.88 3.21 18.47 3 18 3H6c-.47 0-.88.21-1.16.55L3.46 5.23C3.17 5.57 3 6.02 3 6.5V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6.5c0-.48-.17-.93-.46-1.27zM12 17.5L6.5 12H10v-2h4v2h3.5L12 17.5zM5.12 5l.81-1h12l.94 1H5.12z"/></svg>
            </button>
          </button>
        {/each}

        {#if archivedConvs.length}
          <button class="section-toggle" on:click={() => showArchived = !showArchived}>
            <span class="caret" class:open={showArchived}>▸</span>
            Archived ({archivedConvs.length})
          </button>
          {#if showArchived}
            {#each archivedConvs as conv (conv.id)}
              <button
                class="conv-item archived"
                class:active={currentChatId === conv.id}
                on:click={() => selectConversation(conv.id)}
              >
                <div class="conv-info">
                  <span class="conv-title">{conv.title || 'New conversation'}</span>
                  <span class="conv-time">{relativeTime(conv.updated_at)}</span>
                </div>
                <button
                  class="row-icon archive-btn"
                  on:click|stopPropagation={() => unarchiveConversation(conv.id)}
                  title="Unarchive"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M20.55 5.22l-1.39-1.68C18.88 3.21 18.47 3 18 3H6c-.47 0-.88.21-1.15.55L3.46 5.22C3.17 5.57 3 6.02 3 6.5V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6.5c0-.48-.17-.93-.45-1.28zM12 9.5l5.5 5.5H14v2h-4v-2H6.5L12 9.5zM5.12 5l.82-1h12l.93 1H5.12z"/></svg>
                </button>
              </button>
            {/each}
          {/if}
        {/if}
      </div>
      <div class="sidebar-footer">
        <button class="footer-btn" on:click={toggleDark}>
          <span class="footer-icon">{#if darkMode}☀{:else}☾{/if}</span>
          <span>{darkMode ? 'Light mode' : 'Dark mode'}</span>
        </button>
      </div>
    </aside>

    <!-- Main -->
    <main class="main">
      <header class="app-bar">
        <button class="menu-btn" on:click={() => menuOpen = !menuOpen}>
          ☰
        </button>
        {#if editingId && editingId === currentChatId}
          <input
            class="title-input"
            bind:value={editingText}
            on:keydown={renameKeydown}
            on:blur={cancelRename}
            use:focusInput
          />
          <button class="icon-btn" on:mousedown|preventDefault={submitRename} title="Save">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><polyline points="20 6 9 17 4 12"/></svg>
          </button>
        {:else}
          <button class="app-bar-title" class:editable={view === 'chat' && !!currentChatId} on:click={startTitleEdit} title={currentChatId && view === 'chat' ? 'Rename' : ''}>
            {#if view === 'room'}
              Chatroom
            {:else if currentChatId}
              {conversations.find(c => c.id === currentChatId)?.title || 'New conversation'}
            {:else}
              Angel
            {/if}
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
        <Chatroom />
      {:else if currentChatId}
        <Chat conversationId={currentChatId} />
      {:else if convsLoaded && conversations.length === 0}
        <div class="empty-state">
          <p>Start a new conversation</p>
          <button class="new-chat-btn" on:click={newConversation}>New conversation</button>
        </div>
      {:else}
        <div class="loading-state">Loading…</div>
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

  .brand {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .icon-btn.new {
    font-size: 1.5rem;
    line-height: 1;
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .view-tabs {
    display: flex;
    border-bottom: 1px solid var(--border);
  }
  .view-tab {
    flex: 1;
    padding: 8px 0;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    cursor: pointer;
    font-size: 0.8rem;
    font-weight: 500;
    color: var(--text-secondary);
    transition: color 0.15s, border-color 0.15s;
  }
  .view-tab:hover { color: var(--text-primary); }
  .view-tab.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }

  .hidden { display: none; }

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
    padding: 8px;
  }

  .conv-item {
    width: 100%;
    padding: 10px 12px;
    background: none;
    border: none;
    border-left: 2px solid transparent;
    border-radius: 0 8px 8px 0;
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
  .conv-item.active {
    background: var(--bg-active);
    border-left-color: var(--accent);
  }

  .conv-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .conv-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .conv-time {
    font-size: 0.72rem;
    color: var(--text-secondary);
  }

  .row-icon {
    background: none;
    border: none;
    color: var(--text-secondary);
    cursor: pointer;
    padding: 4px;
    border-radius: 4px;
    display: flex;
    align-items: center;
    flex-shrink: 0;
  }
  .row-icon:hover { background: var(--bg-hover); color: var(--text-primary); }

  /* Archive reveals on hover with a pointer; on touch there's no hover, so show it. */
  .archive-btn { opacity: 0; }
  .conv-item:hover .archive-btn { opacity: 1; }
  @media (hover: none) {
    .archive-btn { opacity: 1; }
  }

  .conv-item.archived .conv-title { color: var(--text-secondary); }

  .section-toggle {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 6px;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-secondary);
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 12px 12px 6px;
    text-align: left;
  }
  .section-toggle:hover { color: var(--text-primary); }
  .caret { display: inline-block; transition: transform 0.15s; }
  .caret.open { transform: rotate(90deg); }

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
    flex: 1;
    min-width: 0;
    text-align: left;
    background: none;
    border: none;
    padding: 0;
    font-size: 0.95rem;
    font-weight: 500;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: default;
  }
  .app-bar-title.editable { cursor: pointer; }
  .app-bar-title.editable:hover { color: var(--accent); }

  .title-input {
    flex: 1;
    min-width: 0;
    background: var(--bg-input);
    border: 1px solid var(--accent);
    border-radius: 8px;
    padding: 6px 10px;
    color: var(--text-primary);
    font-size: 0.95rem;
    font-family: inherit;
  }
  .title-input:focus { outline: none; }

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
