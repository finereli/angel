<script lang="ts">
  import SettingsPage from './SettingsPage.svelte'
  import { angel } from '../../lib/streamManager.svelte'
  import { DEFAULT_VOICE, effectiveVoice } from '../../../worker/voice'
  import { MODEL_CATALOG, REASONING_EFFORTS, modelSupportsReasoning, resolveModel, modelLabel } from '../../../worker/models'

  const selectedModel = $derived(resolveModel(angel.agent?.model))
  const selectedEffort = $derived(angel.agent?.reasoningEffort ?? null)
  const reasoningSupported = $derived(modelSupportsReasoning(selectedModel))
  const loaded = $derived(angel.agentLoaded)

  // Sub-cent prices (GLM's input) keep a third digit instead of rounding to $0.01.
  const price = (n: number) => `$${n.toFixed(n < 0.01 ? 3 : 2)}`

  function chooseModel(id: string) {
    angel.updateSettings(id, modelSupportsReasoning(id) ? selectedEffort : null)
  }

  // Changing the model on a setup that already has a history changes how Angel
  // thinks and sounds, so it is staged: pick, read what it means, then apply. An
  // empty setup has nothing to disturb and applies at once.
  const hasHistory = $derived(
    angel.agent?.hasHistory || Object.values(angel.convStates).some(c => c.messages.length > 0),
  )
  let pendingModel = $state<string | null>(null)
  function pickModel(id: string) {
    if (id === selectedModel) { pendingModel = null; return }
    if (!hasHistory) { chooseModel(id); return }
    pendingModel = id
  }
  function applyModel() {
    if (pendingModel) chooseModel(pendingModel)
    pendingModel = null
  }

  // Voice: how Angel sounds. Set here, never in chat, because a model asked to
  // change its own personality mid-conversation tends to resist.
  // Saved null is "the default", an empty box is a deliberate "no voice".
  const savedVoice = $derived(effectiveVoice(angel.agent?.voice))
  let voiceDraft = $state<string | null>(null) // null = untouched
  const voiceText = $derived(voiceDraft ?? savedVoice)
  const voiceDirty = $derived(voiceDraft !== null && voiceDraft.trim() !== savedVoice)
  const isDefaultVoice = $derived(angel.agent?.voice === null)
  function saveVoice() {
    angel.setVoice(voiceText.trim())
    voiceDraft = null
  }
  function resetVoice() {
    angel.setVoice(null)
    voiceDraft = null
  }

  function chooseEffort(effort: string | null) {
    angel.updateSettings(selectedModel, effort)
  }
</script>

<SettingsPage title={angel.agent?.name || 'Angel'} back="/settings">

  {#if angel.settingsError}
    <p class="error">{angel.settingsError}</p>
  {/if}

  <section>
    <h3>Model</h3>
    <p class="hint">Which model {angel.agent?.name || 'Angel'} thinks with. Prices are per 1M tokens, input / output.</p>
    <!-- Until the server says which model is saved, the box stays empty and
         disabled rather than showing the default and then jumping. -->
    <select
      class="field"
      aria-label="Model"
      disabled={!angel.agentLoaded}
      value={angel.agentLoaded ? (pendingModel ?? selectedModel) : ''}
      onchange={(e) => pickModel(e.currentTarget.value)}
    >
      {#if !angel.agentLoaded}<option value="">Loading...</option>{/if}
      {#each MODEL_CATALOG as m (m.id)}
        <option value={m.id}>{m.label} - {price(m.priceInPerM)} / {price(m.priceOutPerM)}</option>
      {/each}
    </select>
    {#if pendingModel}
      <div class="stage" role="alertdialog" aria-label="Confirm model change">
        <p>
          Switching to {modelLabel(pendingModel)} changes how {angel.agent?.name || 'Angel'} thinks and sounds.
          The memory carries over, but expect them to feel different for a while.
        </p>
        <div class="confirm-row">
          <button class="apply-btn" onclick={applyModel}>Switch to {modelLabel(pendingModel)}</button>
          <button class="quiet-btn neutral" onclick={() => (pendingModel = null)}>Keep {modelLabel(selectedModel)}</button>
        </div>
      </div>
    {/if}
  </section>

  <section>
    <h3>Voice</h3>
    <p class="hint">
      How {angel.agent?.name || 'Angel'} sounds, in a sentence. It's set here and not in the chat, because models tend to
      resist when asked to change their own personality. It applies from the next message. Empty means no voice at all.
    </p>
    <textarea
      class="field voice"
      rows="3"
      maxlength="400"
      aria-label="Voice"
      placeholder="Leave empty for no voice"
      disabled={!angel.agentLoaded}
      value={voiceText}
      oninput={(e) => (voiceDraft = e.currentTarget.value)}
    ></textarea>
    <div class="confirm-row">
      <button class="apply-btn" disabled={!voiceDirty} onclick={saveVoice}>Save voice</button>
      {#if !isDefaultVoice || (voiceDraft !== null && voiceDraft.trim() !== DEFAULT_VOICE)}
        <button class="quiet-btn neutral" onclick={resetVoice}>Back to the default</button>
      {/if}
    </div>
  </section>

  <section>
    <h3>Thinking effort</h3>
    {#if !loaded}
      <p class="hint">Loading...</p>
    {:else if reasoningSupported}
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
</SettingsPage>

<style>
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
  .stage {
    margin-top: 10px;
    padding: 12px 14px;
    border-radius: 10px;
    background: var(--bg-message);
    font-size: 0.85rem;
    line-height: 1.5;
    color: var(--text-primary);
  }
  .stage p { margin: 0 0 10px; }
  .voice {
    margin-bottom: 10px;
    line-height: 1.45;
    resize: vertical;
  }
  .effort-row { display: flex; flex-wrap: wrap; gap: 4px; }
  .option-inline { padding: 8px 12px; }
  .capitalize { text-transform: capitalize; }
</style>
