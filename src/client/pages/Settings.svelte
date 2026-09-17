<script lang="ts">
  import { angel } from '../lib/streamManager.svelte'
  import { MODEL_CATALOG, REASONING_EFFORTS, modelSupportsReasoning, type ModelOption } from '../../worker/models'

  const selectedModel = $derived(angel.agent?.model ?? null)
  const selectedEffort = $derived(angel.agent?.reasoningEffort ?? null)
  const reasoningSupported = $derived(modelSupportsReasoning(selectedModel))

  function pricePerM(m: ModelOption): string {
    return `$${m.priceInPerM.toFixed(2)} in / $${m.priceOutPerM.toFixed(2)} out per 1M tokens`
  }

  function chooseModel(id: string | null) {
    angel.updateSettings(id, modelSupportsReasoning(id) ? selectedEffort : null)
  }

  function chooseEffort(effort: string | null) {
    angel.updateSettings(selectedModel, effort)
  }
</script>

<div class="settings">
  <h2>Settings</h2>

  {#if angel.settingsError}
    <p class="error">{angel.settingsError}</p>
  {/if}

  <section>
    <h3>Model</h3>
    <p class="hint">Which model {angel.agent?.name || 'Angel'} thinks with. Prices are per 1M tokens, input/output.</p>

    <label class="option">
      <input type="radio" name="model" checked={selectedModel === null} onchange={() => chooseModel(null)} />
      <span class="option-body">
        <span class="option-label">Default</span>
        <span class="option-price">Server-configured fallback</span>
      </span>
    </label>

    {#each MODEL_CATALOG as m (m.id)}
      <label class="option">
        <input type="radio" name="model" checked={selectedModel === m.id} onchange={() => chooseModel(m.id)} />
        <span class="option-body">
          <span class="option-label">{m.label} <span class="tier">{m.tier}</span></span>
          <span class="option-price">{pricePerM(m)}</span>
        </span>
      </label>
    {/each}
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
  .option-body {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .option-label {
    font-size: 0.9rem;
    color: var(--text-primary);
  }
  .tier {
    font-size: 0.72rem;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.03em;
    margin-left: 6px;
  }
  .option-price {
    font-size: 0.78rem;
    color: var(--text-secondary);
  }
  .effort-row {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .option-inline { padding: 8px 12px; }
  .capitalize { text-transform: capitalize; }
</style>