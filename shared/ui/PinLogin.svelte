<!-- pwa-kit: pin-auth/ui/PinLogin.svelte v2 -->
<script lang="ts">
  // Numeric keypad lock screen. Auto-submits at LENGTH digits; a wrong PIN
  // shakes the dots and clears. Desktop can type the PIN (digit rows, numpad,
  // Backspace). The PIN is verified against the server, never hardcoded here.
  // The store comes in as a prop (kit convention - no app-instance import).
  interface PinAuth {
    submit(pin: string): Promise<boolean>
  }
  let { auth }: { auth: PinAuth } = $props()

  const LENGTH = 4 // seam: match the PIN you set as the Pages secret

  let entered = $state('')
  let checking = $state(false)
  let wrong = $state(false)

  async function press(d: string) {
    if (checking || entered.length >= LENGTH) return
    wrong = false
    entered += d
    if (entered.length === LENGTH) {
      checking = true
      const ok = await auth.submit(entered).catch(() => false)
      checking = false
      if (!ok) {
        wrong = true
        setTimeout(() => {
          entered = ''
          wrong = false
        }, 450)
      }
    }
  }

  function backspace() {
    if (checking) return
    entered = entered.slice(0, -1)
  }

  // Desktop: type the PIN. Digit rows and numpad both land here; Backspace
  // deletes. No focus management needed - the listener is on the window.
  function onkeydown(e: KeyboardEvent) {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (/^[0-9]$/.test(e.key)) {
      e.preventDefault()
      press(e.key)
    } else if (e.key === 'Backspace') {
      e.preventDefault()
      backspace()
    }
  }

  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9']
</script>

<svelte:window {onkeydown} />

<div class="lock">
  <!-- seam: brand. Replace the mark and the name with the app's own. -->
  <div class="head">
    <div class="mark" aria-hidden="true">
      <span class="bar b1"></span><span class="bar b2"></span><span class="bar b3"></span>
    </div>
    <h1>Angel</h1>
  </div>

  <div class="dots" class:wrong class:checking>
    {#each Array(LENGTH) as _, i}
      <span class="dot" class:filled={i < entered.length}></span>
    {/each}
  </div>

  <div class="pad">
    {#each keys as k}
      <button class="key num" onclick={() => press(k)}>{k}</button>
    {/each}
    <span></span>
    <button class="key num" onclick={() => press('0')}>0</button>
    <button class="key del" onclick={backspace} aria-label="Delete">
      <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 4H8l-7 8 7 8h13a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1z"/><path d="m18 9-6 6M12 9l6 6"/></svg>
    </button>
  </div>
</div>

<style>
  .lock {
    height: 100dvh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 34px;
    padding: calc(var(--safe-top) + 20px) 20px calc(var(--safe-bottom) + 20px);
    background: var(--bg-surface);
  }

  .head { display: flex; flex-direction: column; align-items: center; gap: 14px; }
  h1 { font-size: 1.15rem; font-weight: 500; color: var(--text-primary); letter-spacing: 0.02em; }

  /* seam: brand mark. These bars are a placeholder identity - draw the
     app's own 52x52 rounded tile here. */
  .mark {
    width: 52px;
    height: 52px;
    border-radius: 14px;
    background: var(--accent-deep);
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    justify-content: center;
    gap: 6px;
    padding-inline-start: 12px;
  }
  .bar { height: 4px; border-radius: 2px; background: #fff; opacity: 0.95; }
  .b1 { width: 28px; }
  .b2 { width: 20px; }
  .b3 { width: 24px; opacity: 0.6; }

  .dots { display: flex; gap: 16px; }
  .dot {
    width: 13px;
    height: 13px;
    border-radius: 50%;
    border: 1.5px solid var(--accent);
    transition: background 0.12s;
  }
  .dot.filled { background: var(--accent); }
  .checking .dot { border-color: var(--accent-light); }
  .wrong { animation: shake 0.4s; }
  .wrong .dot.filled { background: var(--danger); border-color: var(--danger); }
  @keyframes shake {
    0%, 100% { transform: translateX(0); }
    25% { transform: translateX(-8px); }
    50% { transform: translateX(8px); }
    75% { transform: translateX(-5px); }
  }

  .pad {
    display: grid;
    grid-template-columns: repeat(3, 76px);
    gap: 14px;
    justify-items: center;
  }
  .key {
    width: 76px;
    height: 76px;
    border-radius: 50%;
    font-size: 1.6rem;
    font-weight: 400;
    color: var(--text-primary);
    background: var(--bg-raised);
    border: 1px solid var(--border);
    display: grid;
    place-items: center;
    transition: background 0.1s, transform 0.06s;
  }
  .key:active { background: var(--accent-soft); transform: scale(0.96); }
  .del { border: none; background: none; color: var(--text-secondary); }
  .del:active { background: none; }
</style>
