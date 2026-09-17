<!-- pwa-kit: shell/src/App.svelte v6 -->
<script lang="ts">
  // Shell: login gate, top bar, one scrolling body, drawer, toasts. Views are
  // Angel's own (the one conversation, settings).
  import TopBar from '$shared/ui/TopBar.svelte'
  import Drawer from '$shared/ui/Drawer.svelte'
  import Toast from '$shared/ui/Toast.svelte'
  import ResetButton from '$shared/ui/ResetButton.svelte'
  import InstallBanner from '$shared/ui/InstallBanner.svelte'
  import PinLogin from '$shared/ui/PinLogin.svelte'
  import Chat from './pages/Chat.svelte'
  import Settings from './pages/Settings.svelte'
  import { angel } from './lib/streamManager.svelte'
  import { router } from './lib/router.svelte'
  import { isDark, setDarkMode } from '$shared/lib/theme'

  router.start()

  let menuOpen = $state(false)
  // Closing the drawer on navigation matters for the back button too, not just
  // for taps inside it.
  router.onChange(() => (menuOpen = false))

  const view = $derived(router.route.view)
  const agentName = $derived(angel.agent?.name || 'Angel')
  const title = $derived(view === 'settings' ? 'Settings' : agentName)
  const entries = $derived([
    { label: agentName, hash: '/chat', current: view === 'chat' },
    { label: 'Settings', hash: '/settings', current: view === 'settings' },
  ])

  let dark = $state(isDark())
  function toggleDark() {
    dark = !dark
    setDarkMode(dark)
  }

  // Install nudge only after demonstrated engagement: the first reply has landed.
  let engaged = $state(false)
  $effect(() => {
    if (Object.values(angel.convStates).some(c => c.messages.length > 0)) engaged = true
  })
</script>

{#if !angel.signedIn}
  <PinLogin auth={angel} />
{:else}
  <div class="shell">
    <TopBar leading="menu" {title} onleading={() => (menuOpen = true)} />

    <div class="body" class:chat={view === 'chat'}>
      {#if view === 'settings'}
        <Settings />
      {:else}
        <Chat />
      {/if}
    </div>

    <InstallBanner when={engaged} />
  </div>

  <Drawer open={menuOpen} onclose={() => (menuOpen = false)} {entries}>
    {#snippet brand()}
      <div class="brand">
        <strong>{agentName}</strong>
        {#if angel.connState === 'connected'}
          <span class="status-dot connected" title="Connected"></span>
        {:else}
          <span class="status-dot reconnecting" title="Connecting..."></span>
        {/if}
      </div>
    {/snippet}
    {#snippet footer()}
      <button class="footer-btn" onclick={toggleDark}>
        <span class="footer-icon">{dark ? '\u2600' : '\u263A'}</span>
        <span>{dark ? 'Light mode' : 'Dark mode'}</span>
      </button>
      <button class="footer-btn" onclick={() => angel.signOut()}>
        <span class="footer-icon">&#9099;</span>
        <span>Sign out</span>
      </button>
      <p class="build">
        <span>Version {__BUILD__}</span>
        <ResetButton tabindex={menuOpen ? 0 : -1} />
      </p>
    {/snippet}
  </Drawer>
{/if}

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

  .brand { display: flex; align-items: center; gap: 8px; }
  .status-dot { width: 8px; height: 8px; border-radius: 50%; }
  .status-dot.connected { background: var(--ok); }
  .status-dot.reconnecting { background: #f59e0b; animation: pulse 1.5s infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

  .footer-btn {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 0;
    font-size: 0.85rem;
    color: var(--text-primary);
    text-align: left;
  }
  .footer-btn:hover { color: var(--accent); }
  .footer-icon { width: 1.2em; text-align: center; }

  .build {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.65rem;
    color: var(--text-secondary);
    margin-top: 8px;
  }
  .build span { opacity: 0.6; }
</style>