<script lang="ts">
  import { angel } from '../lib/streamManager.svelte'
  import ResetButton from '$shared/ui/ResetButton.svelte'
  import { MODEL_CATALOG, REASONING_EFFORTS, modelSupportsReasoning, resolveModel, modelLabel } from '../../worker/models'

  const selectedModel = $derived(resolveModel(angel.agent?.model))
  const selectedEffort = $derived(angel.agent?.reasoningEffort ?? null)
  const reasoningSupported = $derived(modelSupportsReasoning(selectedModel))
  const loaded = $derived(angel.agentLoaded)

  const price = (n: number) => `$${n.toFixed(2)}`

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
  const savedVoice = $derived(angel.agent?.voice ?? '')
  let voiceDraft = $state<string | null>(null) // null = untouched
  const voiceText = $derived(voiceDraft ?? savedVoice)
  const voiceDirty = $derived(voiceDraft !== null && voiceDraft.trim() !== savedVoice)
  function saveVoice() {
    angel.setVoice(voiceText.trim() || null)
    voiceDraft = null
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
    <!-- Until the server says which model is saved, the box stays empty and
         disabled rather than showing the default and then jumping. -->
    <select
      class="select"
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
      resist when asked to change their own personality. It applies from the next message.
    </p>
    <textarea
      class="voice"
      rows="3"
      maxlength="400"
      aria-label="Voice"
      placeholder="Use the voice of Richard Feynman, but as a warm companion"
      disabled={!angel.agentLoaded}
      value={voiceText}
      oninput={(e) => (voiceDraft = e.currentTarget.value)}
    ></textarea>
    <div class="confirm-row">
      <button class="apply-btn" disabled={!voiceDirty} onclick={saveVoice}>Save voice</button>
      {#if savedVoice && voiceDraft === null}
        <button class="quiet-btn neutral" onclick={() => { voiceDraft = ''; saveVoice() }}>Clear</button>
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
  .apply-btn {
    padding: 9px 16px;
    border-radius: 999px;
    background: var(--accent-deep);
    color: #fff;
    font-size: 0.85rem;
  }
  .apply-btn:hover:not(:disabled) { background: var(--accent); }
  .apply-btn:disabled { opacity: 0.45; }
  .voice {
    width: 100%;
    margin-bottom: 10px;
    padding: 10px 12px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--bg-input);
    color: var(--text-primary);
    font: inherit;
    font-size: 0.9rem;
    line-height: 1.45;
    resize: vertical;
  }
  .voice:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
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