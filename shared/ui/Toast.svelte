<!-- pwa-kit: toast/ui/Toast.svelte v1 -->
<script lang="ts">
  // Renders the toasts store as pills fixed above the bottom safe area.
  // Mount once at the app root. Tap dismisses; they also auto-dismiss
  // (see lib/toast.svelte.ts). Centered, so RTL needs nothing special.
  import { fly } from 'svelte/transition'
  import { toasts } from '../lib/toast.svelte'
</script>

<div class="toasts" aria-live="assertive">
  {#each toasts.items as t (t.id)}
    <button
      class="toast"
      transition:fly={{ y: 12, duration: 200 }}
      onclick={() => toasts.dismiss(t.id)}
    >
      {t.text}
    </button>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    inset-inline: 0;
    bottom: calc(var(--safe-bottom, 0px) + 20px);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    z-index: 100;
    pointer-events: none;
  }

  .toast {
    pointer-events: auto;
    max-width: min(90vw, 480px);
    padding: 10px 18px;
    border-radius: 999px;
    background: var(--danger, #dc2626);
    color: #fff;
    font-size: 0.85rem;
    line-height: 1.4;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
    text-align: center;
    cursor: pointer;
  }
</style>
