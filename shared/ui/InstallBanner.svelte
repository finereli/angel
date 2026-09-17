<!-- pwa-kit: install/ui/InstallBanner.svelte v1 -->
<script lang="ts">
  // Install nudge: a lower-third caption that wipes in from the edge, not a
  // modal. Shows when `when` turns true (after demonstrated engagement - ten
  // seconds of playback, a first message sent), never in standalone mode.
  // One tap installs directly where the browser supports it (Android:
  // the captured beforeinstallprompt), otherwise reveals the manual steps for
  // the platform. Dismiss is session-only on purpose: the lasting "stop
  // showing this" is having installed.
  //
  // Needs the inline capture in index.html (window.__pwaInstallPrompt) and
  // the icons kit (install_mobile, close, ios_share, more_vert).
  // Seams: the strings, `bottom` offset above the app's own bottom bar,
  // colours (accent-deep surface, a highlight for the icon and edge).
  import Icon from './Icon.svelte'

  let {
    when = false,
    text = 'Tap here to install the app',
    closeLabel = 'Close',
    iosSteps = 'Tap',
    iosThen = 'then "Add to Home Screen"',
    androidSteps = 'Tap',
    androidThen = 'then "Install app"',
    bottom = '48px',
  }: {
    when?: boolean; text?: string; closeLabel?: string; iosSteps?: string; iosThen?: string
    androidSteps?: string; androidThen?: string; bottom?: string
  } = $props()

  let visible = $state(false)
  let dismissed = $state(false)
  let expanded = $state(false)
  let installPrompt = $state<BeforeInstallPromptEvent | null>(typeof window !== 'undefined' ? window.__pwaInstallPrompt ?? null : null)

  const isStandalone =
    typeof window !== 'undefined' &&
    (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true)
  const isIOS = typeof navigator !== 'undefined' && /iPad|iPhone|iPod/.test(navigator.userAgent)

  $effect(() => {
    if (isStandalone || dismissed) return
    if (when) visible = true
  })

  function onBeforeInstall(e: Event) {
    e.preventDefault()
    installPrompt = e as BeforeInstallPromptEvent
  }
  function onInstalled() {
    dismiss()
  }

  // $effect so the listeners come off when the banner unmounts - it can
  // remount with every screen, and each mount used to add another pair.
  $effect(() => {
    window.addEventListener('beforeinstallprompt', onBeforeInstall)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall)
      window.removeEventListener('appinstalled', onInstalled)
    }
  })

  async function install() {
    if (!installPrompt) return
    installPrompt.prompt()
    const { outcome } = await installPrompt.userChoice
    installPrompt = null
    if (outcome === 'accepted') dismiss()
  }

  function tap() {
    if (installPrompt) install()
    else expanded = !expanded
  }

  function dismiss() {
    visible = false
    dismissed = true
  }
</script>

{#if visible}
  <div class="banner" class:expanded role="alert" style:bottom>
    <button class="tip" onclick={tap}>
      <span class="lead"><Icon name="install_mobile" size={20} /></span>
      <span class="text">{text}</span>
    </button>

    <button class="close" onclick={dismiss} aria-label={closeLabel}>
      <Icon name="close" size={18} />
    </button>

    {#if expanded && !installPrompt}
      <div class="steps">
        {#if isIOS}
          <p>{iosSteps} <span class="inline-icon"><Icon name="ios_share" size={17} /></span> {iosThen}</p>
        {:else}
          <p>{androidSteps} <span class="inline-icon"><Icon name="more_vert" size={17} /></span> {androidThen}</p>
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .banner {
    --highlight: #ecc65a;
    position: absolute;
    inset-inline-start: 12px;
    z-index: 10;
    display: flex;
    align-items: center;
    max-width: min(84vw, 340px);
    padding: 9px 12px 9px 14px;
    background: color-mix(in srgb, var(--accent-deep) 94%, transparent);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    color: #fff;
    border-radius: 12px;
    border-inline-end: 3px solid var(--highlight);
    box-shadow: 0 6px 22px rgba(0, 0, 0, 0.28);
    flex-wrap: wrap;
    animation: chyron-in 0.5s cubic-bezier(0.22, 1, 0.36, 1);
  }
  .tip {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    min-width: 0;
    text-align: start;
    line-height: 1.35;
  }
  .tip .lead { flex: none; display: inline-flex; color: var(--highlight); }
  .tip .text { font-size: 0.86rem; font-weight: 500; }
  .close {
    flex: none;
    display: grid;
    place-items: center;
    color: #fff;
    opacity: 0.55;
    transition: opacity 0.15s;
  }
  .close:hover { opacity: 1; }
  .steps { flex-basis: 100%; margin-top: 6px; }
  .steps p {
    font-size: 0.8rem;
    color: rgba(255, 255, 255, 0.85);
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .inline-icon { display: inline-flex; vertical-align: middle; }

  @keyframes chyron-in {
    from { transform: translateX(-115%); opacity: 0; }
    60% { opacity: 1; }
    to { transform: translateX(0); opacity: 1; }
  }
  :global([dir='rtl']) .banner { animation-name: chyron-in-rtl; }
  @keyframes chyron-in-rtl {
    from { transform: translateX(115%); opacity: 0; }
    60% { opacity: 1; }
    to { transform: translateX(0); opacity: 1; }
  }
</style>
