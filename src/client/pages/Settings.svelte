<script lang="ts">
  import { angel } from '../lib/streamManager.svelte'
  import ResetButton from '$shared/ui/ResetButton.svelte'
  import { MODEL_CATALOG, REASONING_EFFORTS, modelSupportsReasoning, resolveModel } from '../../worker/models'

  const selectedModel = $derived(resolveModel(angel.agent?.model))
  const selectedEffort = $derived(angel.agent?.reasoningEffort ?? null)
  const reasoningSupported = $derived(modelSupportsReasoning(selectedModel))

  const price = (n: number) => `$${n.toFixed(2)}`

  function chooseModel(id: string) {
    angel.updateSettings(id, modelSupportsReasoning(id) ? selectedEffort : null)
  }

  function chooseEffort(effort: string | null) {
    angel.updateSettings(selectedModel, effort)
  }

  // Two taps, so wiping everything is never one stray press.
  let confirmingReset = $state(false)
  let resetting = $state(false)
  function resetAccount() {
    resetting = true
    angel.resetAccount()
  }
</script>

<div class="settings">
  <h2>Settings</h2>

  {#if angel.settingsError}
    <p class="error">{angel.settingsError}</p>
  {/if}

  <section>
    <h3>Model</h3>
    <p class="hint">Which model {angel.agent?.name || 'Angel'} thinks with. Prices are per 1M tokens, input / output.</p>
    <select
      class="select"
      aria-label="Model"
      value={selectedModel}
      onchange={(e) => chooseModel(e.currentTarget.value)}
    >
      {#each MODEL_CATALOG as m (m.id)}
        <option value={m.id}>{m.label} - {price(m.priceInPerM)} / {price(m.priceOutPerM)}</option>
      {/each}
    </select>
  </section>

  <section>
    <h3>Thinking effort</h3>
    {#if reasoningSupported}
      <p class="hint">How hard the model reasons before answering. Higher costs more and answers slower.</p>
      <div class="effort-row">
        <label class="option option-inline">
          <input type="radio" name="effort" checked={selectedEffort === null} onchange={() => chooseEffort(null)} />
          <span>Off</span>
        </label>
        {#each REASONING_EFFORTS as e (e)}
          <label class="option option-inline">
            <input type="radio" name="effort" checked={selectedEffort === e} onchange={() => chooseEffort(e)} />
            <span class="capitalize">{e}</span>
          </label>
        {/each}
      </div>
    {:else}
      <p class="hint">The selected model doesn't support a reasoning effort setting.</p>
    {/if}
  </section>

  <section>
    <h3>Account</h3>
    <p class="hint">
      {#if angel.user}Signed in as {angel.user.name ? `${angel.user.name} (${angel.user.email})` : angel.user.email}.{:else}Local development session.{/if}
    </p>
    <button class="quiet-btn neutral" onclick={() => angel.signOut()}>Sign out</button>
  </section>

  <section>
    <h3>Your data</h3>
    <p class="hint">Everything {angel.agent?.name || 'Angel'} remembers about you - the conversation, memory, lists, documents and wake-ups - is stored under your account. Deleting it can't be undone.</p>
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
</div>

<style>
  .settings {
    max-width: 42rem;
    margin: 0 auto;
    padding: 20px 24px calc(40px + var(--safe-bottom));
  }
  h2 {
    margin: 0 0 20px;
    font-size: 1.2rem;
    color: var(--text-primary);
  }
  section {
    margin-bottom: 28px;
  }
  h3 {
    margin: 0 0 4px;
    font-size: 0.95rem;
    color: var(--text-primary);
  }
  .hint {
    margin: 0 0 12px;
    font-size: 0.82rem;
    color: var(--text-secondary);
  }
  .error {
    margin: 0 0 16px;
    padding: 8px 12px;
    border-radius: 8px;
    background: var(--bg-message);
    color: var(--danger);
    font-size: 0.85rem;
  }
  .option {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    border-radius: 8px;
    cursor: pointer;
  }
  .option:hover { background: var(--bg-hover); }
  .option input { flex-shrink: 0; accent-color: var(--accent); }
  .select {
    width: 100%;
    padding: 10px 12px;
    border-radius: 8px;
    border: 1px solid var(--border, rgba(127, 127, 127, 0.3));
    background: var(--bg-input);
    color: var(--text-primary);
    font: inherit;
    font-size: 0.9rem;
  }
  .select:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .hint.warn { color: var(--danger); }
  .confirm-row { display: flex; flex-wrap: wrap; gap: 8px; }
  .danger-btn, .quiet-btn {
    padding: 9px 16px;
    border-radius: 999px;
    border: 1px solid var(--danger);
    color: var(--danger);
    font-size: 0.85rem;
  }
  .danger-btn:hover { background: #ef444422; }
  .danger-btn.solid { background: var(--danger); color: #fff; }
  .danger-btn:disabled, .quiet-btn:disabled { opacity: 0.6; }
  .quiet-btn { border-color: var(--text-secondary); color: var(--text-secondary); }
  .quiet-btn:hover { background: var(--bg-hover); }
  .quiet-btn.neutral { border-color: var(--border); color: var(--text-primary); }
  .about { display: flex; align-items: center; gap: 8px; font-size: 0.82rem; color: var(--text-secondary); }
  .effort-row {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .option-inline { padding: 8px 12px; }
  .capitalize { text-transform: capitalize; }
</style>