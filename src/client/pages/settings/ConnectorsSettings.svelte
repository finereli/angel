<script lang="ts">
  import SettingsPage from './SettingsPage.svelte'
  import Chevron from './Chevron.svelte'
  import { angel, connectorLabel, type ConnectorInfo } from '../../lib/streamManager.svelte'

  const name = $derived(angel.agent?.name || 'Angel')

  let url = $state('')
  let token = $state('')
  let withToken = $state(false)
  const canAdd = $derived(url.trim().length > 3 && !angel.addingConnector)

  function add(e: SubmitEvent) {
    e.preventDefault()
    if (!canAdd) return
    angel.addConnector(url.trim(), withToken ? token.trim() : undefined, (id) => {
      if (!id) return // the error shows above the form
      url = ''
      token = ''
      withToken = false
      location.hash = `/settings/connectors/${id}`
    })
  }

  function subline(c: ConnectorInfo): string {
    if (c.status === 'needs_auth') return 'Needs a sign-in'
    if (c.status === 'error') return c.error || 'Not answering'
    return c.description || `${c.tools.length} tools`
  }

  const formError = $derived(angel.connectorError && !angel.connectorError.id ? angel.connectorError.message : null)
</script>

<SettingsPage title="Connectors" back="/settings">
  <p class="hint">
    Services {name} can use, through MCP servers: a workspace, a calendar, a tracker. {name} sees a one-line list of them and
    loads a connector's tools only when a task needs them. {name} can add and remove connectors too, but only you can sign in.
  </p>

  {#if angel.connectorsLoaded && angel.connectors.length}
    <section>
      <ul class="rows">
        {#each angel.connectors as c (c.id)}
          <li>
            <a href={`#/settings/connectors/${c.id}`}>
              <span class="dot {c.status}" aria-hidden="true"></span>
              <span class="row-text">
                <span class="row-title">{connectorLabel(c)}</span>
                <span class="row-sub">{subline(c)}</span>
              </span>
              <Chevron />
            </a>
          </li>
        {/each}
      </ul>
    </section>
  {:else if !angel.connectorsLoaded}
    <p class="hint">Loading...</p>
  {/if}

  <section>
    <h3>Add a connector</h3>
    <p class="hint">The server's URL, usually ending in /mcp. If it needs a sign-in, you'll get a button for it next.</p>
    {#if formError}<p class="error">{formError}</p>{/if}
    <form onsubmit={add}>
      <input
        class="field"
        type="text"
        inputmode="url"
        enterkeyhint="go"
        autocapitalize="off"
        autocomplete="off"
        spellcheck="false"
        placeholder="https://mcp.example.com/mcp"
        aria-label="Server URL"
        bind:value={url}
      />
      {#if withToken}
        <input
          class="field token"
          type="password"
          autocomplete="off"
          placeholder="API token"
          aria-label="API token"
          bind:value={token}
        />
      {/if}
      <div class="confirm-row actions">
        <button class="apply-btn" type="submit" disabled={!canAdd}>{angel.addingConnector ? 'Connecting...' : 'Add'}</button>
        {#if !withToken}
          <button class="quiet-btn neutral" type="button" onclick={() => (withToken = true)}>Use an API token</button>
        {/if}
      </div>
    </form>
  </section>
</SettingsPage>

<style>
  .token { margin-top: 8px; }
  .actions { margin-top: 10px; }
</style>
