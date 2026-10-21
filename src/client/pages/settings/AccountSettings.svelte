<script lang="ts">
  import SettingsPage from './SettingsPage.svelte'
  import ResetButton from '$shared/ui/ResetButton.svelte'
  import { angel } from '../../lib/streamManager.svelte'

  // Two taps, so wiping everything is never one stray press.
  let confirmingReset = $state(false)
  let resetting = $state(false)
  function resetAccount() {
    resetting = true
    angel.resetAccount()
  }
</script>

<SettingsPage title="Account" back="/settings">
  <section>
    <h3>Signed in</h3>
    <p class="hint">
      {#if angel.user}{angel.user.name ? `${angel.user.name} (${angel.user.email})` : angel.user.email}{:else}Local development session.{/if}
    </p>
    <button class="quiet-btn neutral" onclick={() => angel.signOut()}>Sign out</button>
  </section>

  <section>
    <h3>Your data</h3>
    <p class="hint">Everything {angel.agent?.name || 'Angel'} remembers about you - the conversation, memory, lists, documents, connectors and wake-ups - is stored under your account. Deleting it can't be undone.</p>
    {#if !confirmingReset}
      <button class="danger-btn" onclick={() => (confirmingReset = true)}>Delete all my data</button>
    {:else}
      <p class="hint warn">This erases the whole conversation and everything remembered. Sure?</p>
      <div class="confirm-row">
        <button class="danger-btn solid" disabled={resetting} onclick={resetAccount}>{resetting ? 'Deleting...' : 'Yes, delete everything'}</button>
        <button class="quiet-btn" disabled={resetting} onclick={() => (confirmingReset = false)}>Cancel</button>
      </div>
    {/if}
  </section>

  <section>
    <h3>About</h3>
    <p class="about">
      <span>Version {__BUILD__}</span>
      <ResetButton />
    </p>
  </section>
</SettingsPage>

<style>
  .about { display: flex; align-items: center; gap: 8px; font-size: 0.82rem; color: var(--text-secondary); }
</style>
