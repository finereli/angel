<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { angel } from '../streamManager';
  import { MODEL_CATALOG, REASONING_EFFORTS, modelSupportsReasoning, type ModelOption } from '../../worker/models';

  let agent = angel.getAgent();
  let settingsError = angel.getSettingsError();
  let unsub: (() => void) | null = null;

  $: selectedModel = agent?.model ?? null;
  $: selectedEffort = agent?.reasoningEffort ?? null;
  $: reasoningSupported = modelSupportsReasoning(selectedModel);

  onMount(() => {
    unsub = angel.subscribe(() => {
      agent = angel.getAgent();
      settingsError = angel.getSettingsError();
    });
  });
  onDestroy(() => unsub?.());

  function pricePerM(m: ModelOption): string {
    return `$${m.priceInPerM.toFixed(2)} in / $${m.priceOutPerM.toFixed(2)} out per 1M tokens`;
  }

  function chooseModel(id: string | null) {
    angel.updateSettings(id, modelSupportsReasoning(id) ? selectedEffort : null);
  }

  function chooseEffort(effort: string | null) {
    angel.updateSettings(selectedModel, effort);
  }
</script>

<div class="settings">
  <h2>Settings</h2>

  {#if settingsError}
    <p class="error">{settingsError}</p>
  {/if}

  <section>
    <h3>Model</h3>
    <p class="hint">Which model {agent?.name || 'Angel'} thinks with. Prices are per 1M tokens, input/output.</p>

    <label class="option">
      <input type="radio" name="model" checked={selectedModel === null} on:change={() => chooseModel(null)} />
      <span class="option-body">
        <span class="option-label">Default</span>
        <span class="option-price">Server-configured fallback</span>
      </span>
    </label>

    {#each MODEL_CATALOG as m (m.id)}
      <label class="option">
        <input type="radio" name="model" checked={selectedModel === m.id} on:change={() => chooseModel(m.id)} />
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
          <input type="radio" name="effort" checked={selectedEffort === null} on:change={() => chooseEffort(null)} />
          <span>Off</span>
        </label>
        {#each REASONING_EFFORTS as e (e)}
          <label class="option option-inline">
            <input type="radio" name="effort" checked={selectedEffort === e} on:change={() => chooseEffort(e)} />
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
    flex: 1;
    overflow-y: auto;
    padding: 20px 24px 40px;
    max-width: 560px;
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
    color: #ef4444;
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
  .option-inline {
    padding: 8px 12px;
  }
  .capitalize { text-transform: capitalize; }
</style>
