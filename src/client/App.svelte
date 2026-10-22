<!-- pwa-kit: shell/src/App.svelte v6 -->
<script lang="ts">
  // Shell: login gate, top bar, one scrolling body, drawer, toasts. Views are
  // Angel's own (the one conversation, settings).
  import TopBar from '$shared/ui/TopBar.svelte'
  import Drawer from '$shared/ui/Drawer.svelte'
  import Toast from '$shared/ui/Toast.svelte'
  import Icon from '$shared/ui/Icon.svelte'
  import LoginScreen from '$shared/ui/LoginScreen.svelte'
  import Chat from './pages/Chat.svelte'
  import SettingsIndex from './pages/settings/SettingsIndex.svelte'
  import AngelSettings from './pages/settings/AngelSettings.svelte'
  import ConnectorsSettings from './pages/settings/ConnectorsSettings.svelte'
  import ConnectorDetail from './pages/settings/ConnectorDetail.svelte'
  import AccountSettings from './pages/settings/AccountSettings.svelte'
  import ThemeSettings from './pages/settings/ThemeSettings.svelte'
  import { angel, connectorLabel } from './lib/streamManager.svelte'
  import { router, parentOf } from './lib/router.svelte'
  import ResetButton from '$shared/ui/ResetButton.svelte'
  import { appearance } from './lib/appearance.svelte'
  import { setAccent, storedAccent } from './lib/accent'

  router.start()

  let menuOpen = $state(false)
  // Closing the drawer on navigation matters for the back button too, not just
  // for taps inside it.
  router.onChange(() => (menuOpen = false))

  const route = $derived(router.route)
  const agentName = $derived(angel.agent?.name || 'Angel')
  const isChat = $derived(route.view === 'chat' || route.view === 'side')
  const sides = $derived(angel.conversations.filter(c => c.parentId))
  const sideTitle = $derived(route.view === 'side' ? (angel.conversations.find(c => c.id === route.id)?.title || 'New chat') : null)
  const isSettings = $derived(route.view === 'settings' || route.view === 'connector')
  const connectorTitle = $derived.by(() => {
    if (route.view !== 'connector') return null
    const c = angel.connectors.find(x => x.id === route.id)
    return c ? connectorLabel(c) : 'Connector'
  })
  const title = $derived(
    route.view === 'settings'
      ? (route.section === 'angel' ? agentName : route.section === 'connectors' ? 'Connectors' : route.section === 'account' ? 'Account' : route.section === 'theme' ? 'Theme' : 'Settings')
      : route.view === 'connector' ? connectorTitle!
      : route.view === 'side' ? sideTitle || 'New chat' : agentName,
  )
  // Settings sub-pages go back up a level; everything else opens the menu.
  const back = $derived(parentOf(route))
  const activeConvId = $derived(route.view === 'side' ? route.id : route.view === 'chat' ? (angel.mainConversationId ?? '') : '')
  function go(hash: string) {
    menuOpen = false
    location.hash = hash
  }

  const who = $derived(angel.user?.name || angel.user?.email || (angel.devSession ? 'Dev session' : ''))
  const initial = $derived((who[0] || '?').toUpperCase())
  // The account menu: opens up from the name in the sidebar footer.
  let accountOpen = $state(false)
  let accountEl = $state<HTMLElement>()
  $effect(() => {
    if (!accountOpen) return
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !accountEl?.contains(e.target as Node)) accountOpen = false
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', close)
    }
  })

  async function newSideChat() {
    menuOpen = false
    const id = await angel.createSideConversation('')
    if (id) location.hash = `/side/${id}`
  }

  // Per-row menu for side chats: rename in place, delete with a second tap.
  let menuFor = $state<string | null>(null)
  let renaming = $state<string | null>(null)
  let confirmingDelete = $state<string | null>(null)
  let draft = $state('')

  function startRename(id: string, current: string) {
    menuFor = null
    renaming = id
    draft = current
  }
  function commitRename() {
    if (renaming === null) return
    const id = renaming
    renaming = null
    const clean = draft.trim()
    const existing = angel.conversations.find(c => c.id === id)?.title ?? ''
    if (clean && clean !== existing) angel.renameConversation(id, clean)
  }
  function focusSelect(node: HTMLInputElement) {
    node.focus()
    node.select()
  }
  function confirmDelete(id: string) {
    angel.deleteConversation(id)
    confirmingDelete = null
  }

  appearance.accent = () => angel.agent?.accent ?? storedAccent()
  const dark = $derived(appearance.dark)
  // The saved accent follows the person across devices; this device caches it.
  $effect(() => {
    if (angel.agentLoaded) setAccent(angel.agent?.accent ?? null)
  })

</script>

{#if !angel.signedIn || angel.denied !== null}
  <LoginScreen
    auth={angel}
    title="Angel"
    subtitle="A COMPANION WITH A MEMORY"
    icon="/icon-192.png"
    denied={angel.denied !== null}
    deniedText={`${angel.denied || 'This account'} isn't on the list. Angel is invite-only for now.`}
    deniedLink={{ href: 'https://x.com/finereli', label: 'Say hi on X: @finereli' }}
  />
{:else}
  <div class="shell">
    <TopBar leading={back ? 'back' : 'menu'} {title} onleading={() => (back ? go(back) : (menuOpen = true))} trailing={isSettings ? undefined : newChatIcon} trailingLabel="New side chat" ontrailing={newSideChat}>
      {#snippet titleAfter()}
        {#if isChat}
          <span class="status-dot" class:connected={angel.connState === 'connected'} class:reconnecting={angel.connState !== 'connected'} title={angel.connState === 'connected' ? 'Connected' : 'Connecting...'}></span>
        {/if}
      {/snippet}
    </TopBar>

    <div class="body" class:chat={isChat}>
      {#if route.view === 'settings'}
        {#if route.section === 'angel'}<AngelSettings />
        {:else if route.section === 'connectors'}<ConnectorsSettings />
        {:else if route.section === 'theme'}<ThemeSettings />
        {:else if route.section === 'account'}<AccountSettings />
        {:else}<SettingsIndex />{/if}
      {:else if route.view === 'connector'}
        {#key route.id}<ConnectorDetail id={route.id} />{/key}
      {:else if activeConvId}
        <Chat conversationId={activeConvId} />
      {:else}
        <div class="loading-state">Loading...</div>
      {/if}
    </div>
  </div>

  <Drawer open={menuOpen} onclose={() => (menuOpen = false)}>
    {#snippet brand()}
      <div class="brand-link">
        <strong>{agentName}</strong>
        <span class="status-dot" class:connected={angel.connState === 'connected'} class:reconnecting={angel.connState !== 'connected'} title={angel.connState === 'connected' ? 'Connected' : 'Connecting...'}></span>
      </div>
    {/snippet}

    {#snippet list()}
      <div class="row main-row" class:current={route.view === 'chat'}>
        <button class="row-main" onclick={() => go('/chat')} tabindex={menuOpen ? 0 : -1}>Main chat</button>
      </div>

      <div class="side-head">
        <span class="side-label">Side chats</span>
        <button class="icon-btn small" onclick={newSideChat} aria-label="New side chat" title="New side chat" tabindex={menuOpen ? 0 : -1}>
          <Icon name="add" size={18} />
        </button>
      </div>

      {#each sides as s (s.id)}
        {@const label = s.title || 'New chat'}
        {@const current = route.view === 'side' && route.id === s.id}
        <div class="row" class:current>
          {#if renaming === s.id}
            <input
              class="rename"
              bind:value={draft}
              maxlength="80"
              aria-label="Chat name"
              use:focusSelect
              onblur={commitRename}
              onkeydown={(e) => { if (e.key === 'Enter') commitRename(); else if (e.key === 'Escape') { renaming = null } }}
            />
          {:else if confirmingDelete === s.id}
            <span class="confirm-text">Delete this chat?</span>
            <button class="pill danger" onclick={() => confirmDelete(s.id)}>Delete</button>
            <button class="pill" onclick={() => (confirmingDelete = null)}>Keep</button>
          {:else}
            <button class="row-main" onclick={() => go(`/side/${s.id}`)} tabindex={menuOpen ? 0 : -1}>{label}</button>
            <button
              class="icon-btn small more"
              aria-label="Chat options"
              aria-expanded={menuFor === s.id}
              onclick={(e) => { e.stopPropagation(); menuFor = menuFor === s.id ? null : s.id }}
              tabindex={menuOpen ? 0 : -1}
            >
              <Icon name="more_horiz" size={18} />
            </button>
          {/if}

          {#if menuFor === s.id}
            <div class="menu" role="menu">
              <button role="menuitem" onclick={() => startRename(s.id, s.title || '')}><Icon name="edit" size={16} /> Rename</button>
              <button role="menuitem" class="danger" onclick={() => { menuFor = null; confirmingDelete = s.id }}><Icon name="delete" size={16} /> Delete</button>
            </div>
          {/if}
        </div>
      {:else}
        {#if angel.conversationsLoaded}
          <p class="empty">Nothing here yet. Side chats are for thinking out loud without touching the main thread.</p>
        {/if}
      {/each}
    {/snippet}

    {#snippet footer()}
      <div class="account">
        <div class="who-wrap" bind:this={accountEl}>
          <button class="who" onclick={() => (accountOpen = !accountOpen)} aria-haspopup="menu" aria-expanded={accountOpen} tabindex={menuOpen ? 0 : -1}>
            {#if angel.user?.picture}
              <img class="avatar" src={angel.user.picture} alt="" referrerpolicy="no-referrer" />
            {:else}
              <span class="avatar initial" aria-hidden="true">{initial}</span>
            {/if}
            <span class="who-name">{who}</span>
          </button>
          {#if accountOpen}
            <div class="account-menu" role="menu">
              <button role="menuitem" onclick={() => { accountOpen = false; angel.signOut() }}>
                <Icon name="logout" size={18} /> Sign out
              </button>
            </div>
          {/if}
        </div>
        <ResetButton tabindex={menuOpen ? 0 : -1} />
        <button class="icon-btn" onclick={() => appearance.toggle()} aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'} title={dark ? 'Light mode' : 'Dark mode'} tabindex={menuOpen ? 0 : -1}>
          <Icon name={dark ? 'light_mode' : 'dark_mode'} size={20} />
        </button>
        <button class="icon-btn" class:current={isSettings} onclick={() => go('/settings')} aria-label="Settings" title="Settings" tabindex={menuOpen ? 0 : -1}>
          <Icon name="settings" size={20} />
        </button>
      </div>
    {/snippet}
  </Drawer>
{/if}

{#snippet newChatIcon()}<Icon name="add" size={22} />{/snippet}

<!-- Any click outside a row's menu closes it. -->
<svelte:window onclick={() => (menuFor = null)} />

<Toast />

<style>
  .shell { display: flex; flex-direction: column; height: 100%; }
  .body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior-y: contain;
  }
  /* The chat owns its own layout and scrolls inside itself. */
  .body.chat {
    display: flex;
    flex-direction: column;
    overflow: hidden;
    overscroll-behavior-y: none;
  }
  @media (min-width: 768px) {
    .shell { margin-inline-start: min(78vw, 300px); }
  }

  .loading-state {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-secondary);
    font-size: 0.9rem;
  }
  .status-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .status-dot.connected { background: var(--ok); }
  .status-dot.reconnecting { background: #f59e0b; animation: pulse 1.5s infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

  /* One left edge for everything in the drawer: --gutter (22px) is the text
     edge; rows and pills sit 10px outside it so their text still lines up. */
  .brand-link {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    height: 100%;
    color: var(--text-primary);
    font-size: 1.05rem;
  }

  .side-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 10px 4px var(--gutter);
  }
  .side-label {
    font-size: 0.7rem;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-secondary);
  }
  .row {
    position: relative;
    display: flex;
    align-items: center;
    gap: 4px;
    margin: 0 10px;
    padding-inline-end: 4px;
    border-radius: 10px;
  }
  .row:hover, .row.current { background: var(--bg-hover); }
  /* After .row, whose `margin: 0 10px` would otherwise zero this out. */
  .row.main-row { margin-bottom: 20px; }
  .row-main {
    flex: 1;
    min-width: 0;
    padding: 10px 12px;
    text-align: start;
    font-size: 0.92rem;
    color: var(--text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .row.current .row-main { color: var(--accent-text); font-weight: 500; }
  .row:hover .row-main { color: var(--text-primary); }
  .row.current:hover .row-main { color: var(--accent-text); }
  /* The options button stays out of the way until the row is hovered, focused
     or open - except on touch screens, which have no hover. */
  .more { opacity: 0; }
  .row:hover .more, .row:focus-within .more, .more[aria-expanded='true'] { opacity: 1; }
  @media (hover: none) { .more { opacity: 1; } }

  .menu {
    position: absolute;
    inset-inline-end: 4px;
    top: calc(100% - 2px);
    z-index: 5;
    min-width: 150px;
    padding: 4px;
    border-radius: 10px;
    background: var(--bg-raised);
    border: 1px solid var(--border);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
  }
  .menu button {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 10px;
    border-radius: 7px;
    font-size: 0.88rem;
    color: var(--text-primary);
    text-align: start;
  }
  .menu button:hover { background: var(--bg-hover); }
  .menu .danger { color: var(--danger); }

  .rename {
    flex: 1;
    min-width: 0;
    margin: 4px 0;
    padding: 6px 10px;
    border-radius: 8px;
    border: 1px solid var(--accent);
    background: var(--bg-input);
    color: var(--text-primary);
    font: inherit;
    font-size: 0.92rem;
  }
  .confirm-text { flex: 1; padding: 10px 12px; font-size: 0.85rem; color: var(--text-secondary); }
  .pill {
    padding: 4px 10px;
    border-radius: 999px;
    border: 1px solid var(--border);
    font-size: 0.78rem;
    color: var(--text-secondary);
  }
  .pill:hover { background: var(--bg-hover); }
  .pill.danger { border-color: var(--danger); color: var(--danger); }
  .empty {
    padding: 8px var(--gutter);
    font-size: 0.82rem;
    line-height: 1.45;
    color: var(--text-secondary);
  }

  .account {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .who-wrap { position: relative; flex: 1; min-width: 0; }
  .who {
    display: flex; align-items: center; gap: 10px;
    max-width: 100%; padding: 4px 8px 4px 4px; margin-left: -4px;
    border: none; border-radius: var(--radius); background: none;
    color: var(--text-primary); font: inherit; cursor: pointer; text-align: left;
  }
  .who:hover, .who[aria-expanded='true'] { background: var(--bg-hover); }
  .avatar { width: 32px; height: 32px; flex-shrink: 0; border-radius: 50%; object-fit: cover; }
  .avatar.initial {
    display: grid; place-items: center;
    background: var(--accent-deep); color: #fff; font-size: 0.85rem; font-weight: 500;
  }
  .who-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.85rem; }
  .account-menu {
    position: absolute; bottom: calc(100% + 6px); left: -4px; z-index: 10;
    min-width: 160px; padding: 4px;
    border: 1px solid var(--border); border-radius: var(--radius);
    background: var(--bg-raised); box-shadow: var(--shadow);
  }
  .account-menu button {
    display: flex; align-items: center; gap: 10px; width: 100%;
    padding: 8px 10px; border: none; border-radius: 6px; background: none;
    color: var(--text-primary); font: inherit; font-size: 0.85rem; cursor: pointer; text-align: left;
  }
  .account-menu button:hover { background: var(--bg-hover); }
  .icon-btn {
    width: 36px;
    height: 36px;
    flex-shrink: 0;
    display: grid;
    place-items: center;
    border-radius: 50%;
    color: var(--text-secondary);
  }
  .icon-btn.small { width: 30px; height: 30px; }
  .icon-btn:hover { background: var(--bg-active); color: var(--text-primary); }
  .icon-btn.current { color: var(--accent-text); }
</style>
