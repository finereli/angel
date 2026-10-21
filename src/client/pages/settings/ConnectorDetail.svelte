<script lang="ts">
  import SettingsPage from './SettingsPage.svelte'
  import { angel, connectorLabel } from '../../lib/streamManager.svelte'

  let { id }: { id: string } = $props()

  const c = $derived(angel.connectors.find(x => x.id === id))
  const name = $derived(angel.agent?.name || 'Angel')
  const link = $derived(angel.signInLink?.id === id ? angel.signInLink.url : null)
  const error = $derived(angel.connectorError?.id === id ? angel.connectorError.message : null)

  const STATUS = { connected: 'Connected', needs_auth: 'Needs a sign-in', error: 'Not answering' } as const

  let confirmingRemove = $state(false)
  function remove() {
    angel.removeConnector(id)
    location.hash = '/settings/connectors'
  }
</script>

<SettingsPage title={c ? connectorLabel(c) : 'Connector'} back="/settings/connectors" backLabel="Connectors">
  {#if !c}
    <p class="hint">{angel.connectorsLoaded ? 'This connector is gone.' : 'Loading...'}</p>
  {:else}
    <section>
      <p class="status"><span class="dot {c.status}" aria-hidden="true"></span>{STATUS[c.status]}</p>
      {#if c.description}<p class="hint">{c.description}</p>{/if}
      <dl class="facts">
        <dt>Name</dt><dd>{c.name}</dd>
        <dt>URL</dt><dd class="url">{c.url}</dd>
        <dt>Sign-in</dt><dd>{c.auth === 'oauth' ? 'Account sign-in' : c.auth === 'token' ? 'API token' : 'None needed'}</dd>
        <dt>Added by</dt><dd>{c.addedBy === 'angel' ? name : 'You'}</dd>
      </dl>
    </section>

    {#if error}<p class="error">{error}</p>{/if}
    {#if c.status === 'error' && c.error}<p class="error">{c.error}</p>{/if}

    <section>
      <div class="confirm-row">
        {#if c.status === 'needs_auth'}
          {#if link}
            <a class="apply-btn" href={link} target="_blank" rel="opener">Sign in</a>
          {:else}
            <button class="apply-btn" onclick={() => angel.signInConnector(c.id)}>Sign in</button>
          {/if}
        {:else if c.status === 'error'}
          <button class="apply-btn" onclick={() => angel.reloadConnector(c.id)}>Try again</button>
        {:else}
          <button class="quiet-btn neutral" onclick={() => angel.reloadConnector(c.id)}>Refresh</button>
          {#if c.auth === 'oauth'}
            <button class="quiet-btn neutral" onclick={() => angel.signInConnector(c.id)}>Sign in again</button>
          {/if}
        {/if}
      </div>
      {#if c.status === 'needs_auth'}
        <p class="hint after">Opens {connectorLabel(c)}'s sign-in page. Come back here when it says you're connected.</p>
      {/if}
    </section>

    <section>
      <h3>Remove</h3>
      <p class="hint">{name} stops seeing it, and the sign-in is forgotten.</p>
      {#if !confirmingRemove}
        <button class="danger-btn" onclick={() => (confirmingRemove = true)}>Remove connector</button>
      {:else}
        <div class="confirm-row">
          <button class="danger-btn solid" onclick={remove}>Yes, remove it</button>
          <button class="quiet-btn" onclick={() => (confirmingRemove = false)}>Cancel</button>
        </div>
      {/if}
    </section>
  {/if}
</SettingsPage>

<style>
  .status { display: flex; align-items: center; gap: 8px; margin: 0 0 8px; font-size: 0.9rem; color: var(--text-primary); }
  .facts {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 6px 16px;
    margin: 0;
    font-size: 0.85rem;
  }
  .facts dt { color: var(--text-secondary); }
  .facts dd { margin: 0; color: var(--text-primary); min-width: 0; }
  .url { overflow-wrap: anywhere; }
  .after { margin-top: 10px; }
</style>
