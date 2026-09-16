<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  export let failed = false;

  const dispatch = createEventDispatcher<{ login: string }>();
  let pin = '';

  function handleSubmit() {
    if (pin.length > 0) {
      dispatch('login', pin);
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      handleSubmit();
    }
  }
</script>

<div class="login">
  <div class="login-card">
    <h1>Angel</h1>
    {#if failed}
      <p class="error">Connection failed. Check your PIN.</p>
    {/if}
    <input
      type="password"
      bind:value={pin}
      on:keydown={handleKeydown}
      placeholder="PIN"
      autofocus
    />
    <button on:click={handleSubmit} disabled={!pin}>Connect</button>
  </div>
</div>

<style>
  .login {
    height: 100dvh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg-surface);
  }

  .login-card {
    text-align: center;
    padding: 40px;
  }

  h1 {
    font-size: 2rem;
    font-weight: 300;
    color: var(--text-primary);
    margin-bottom: 24px;
  }

  .error {
    color: #ef4444;
    font-size: 0.85rem;
    margin-bottom: 16px;
  }

  input {
    display: block;
    width: 200px;
    margin: 0 auto 16px;
    padding: 12px 16px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--bg-input);
    color: var(--text-primary);
    font-size: 1.2rem;
    text-align: center;
    letter-spacing: 4px;
  }
  input:focus {
    outline: none;
    border-color: var(--accent);
  }

  button {
    padding: 10px 32px;
    background: var(--accent);
    color: white;
    border: none;
    border-radius: 8px;
    font-size: 0.95rem;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.4;
  }
</style>
