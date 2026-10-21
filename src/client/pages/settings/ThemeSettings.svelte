<script lang="ts">
  import SettingsPage from './SettingsPage.svelte'
  import { angel } from '../../lib/streamManager.svelte'
  import { appearance, type Mode } from '../../lib/appearance.svelte'
  import { ACCENTS, DEFAULT_ACCENT, setAccent as previewAccent } from '../../lib/accent'

  const currentAccent = $derived((angel.agent?.accent ?? DEFAULT_ACCENT).toLowerCase())
  const isCustomAccent = $derived(!ACCENTS.some(a => a.hex === currentAccent))

  const MODES: { id: Mode; label: string }[] = [
    { id: 'light', label: 'Light' },
    { id: 'dark', label: 'Dark' },
    { id: 'device', label: 'Match device' },
  ]
</script>

<SettingsPage title="Theme" back="/settings">
  <section>
    <h3>Appearance</h3>
    <p class="hint">Light or dark, or whatever this device is set to. It's remembered per device.</p>
    <div class="modes" role="radiogroup" aria-label="Appearance">
      {#each MODES as m (m.id)}
        <button
          class="mode"
          class:on={appearance.mode === m.id}
          role="radio"
          aria-checked={appearance.mode === m.id}
          onclick={() => appearance.set(m.id)}
        >{m.label}</button>
      {/each}
    </div>
  </section>

  <section>
    <h3>Color</h3>
    <p class="hint">Tints the app and its icon. The rainbow circle takes any color.</p>
    <div class="swatches" role="radiogroup" aria-label="Accent color">
      {#each ACCENTS as a (a.hex)}
        <button
          class="swatch"
          class:on={(angel.agent?.accent ?? DEFAULT_ACCENT) === a.hex}
          style="background: {a.hex}"
          role="radio"
          aria-checked={(angel.agent?.accent ?? DEFAULT_ACCENT) === a.hex}
          aria-label={a.name}
          title={a.name}
          disabled={!angel.agentLoaded}
          onclick={() => angel.setAccent(a.hex === DEFAULT_ACCENT ? null : a.hex)}
        ></button>
      {/each}
      <!-- Any colour: previews while dragging, saves when the picker closes. -->
      <label class="swatch custom" class:on={isCustomAccent} title="Pick any color" style={isCustomAccent ? `--picked: ${currentAccent}` : ''}>
        <input
          type="color"
          aria-label="Custom color"
          value={currentAccent}
          disabled={!angel.agentLoaded}
          oninput={(e) => previewAccent(e.currentTarget.value)}
          onchange={(e) => angel.setAccent(e.currentTarget.value)}
        />
      </label>
    </div>
  </section>
</SettingsPage>

<style>
  .modes {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 3px;
    border-radius: 999px;
    background: var(--bg-message);
  }
  .mode {
    padding: 7px 14px;
    border-radius: 999px;
    font-size: 0.85rem;
    color: var(--text-secondary);
  }
  .mode:hover { color: var(--text-primary); }
  .mode.on { background: var(--bg-surface); color: var(--text-primary); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12); }
  .mode:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .swatches { display: flex; flex-wrap: wrap; gap: 12px; padding: 4px 4px 2px; }
  .swatch { width: 32px; height: 32px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; padding: 0; }
  /* clip-path, not just border-radius: the native colour input paints its own
     square swatch, and overflow clipping does not always round it. */
  .swatch.custom {
    position: relative; display: block; border: 0; outline: none;
    clip-path: circle(50%);
    background: conic-gradient(red, yellow, lime, cyan, blue, magenta, red);
  }
  .swatch.custom.on { box-shadow: inset 0 0 0 5px var(--picked), inset 0 0 0 7px var(--bg-surface); }
  .swatch.custom:focus-within { box-shadow: inset 0 0 0 2px var(--bg-surface), inset 0 0 0 4px var(--text-primary); }
  .swatch.custom input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; padding: 0; border: 0; opacity: 0; cursor: pointer; }
  .swatch.on:not(.custom) { outline: 2px solid var(--text-primary); outline-offset: 2px; }
  .swatch:focus-visible { outline: 2px solid var(--text-primary); outline-offset: 2px; }
  .swatch:disabled { opacity: 0.5; cursor: default; }
</style>
