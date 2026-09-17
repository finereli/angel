// pwa-kit: toast/lib/toast.svelte.ts v1
// Transient error toasts for optimistic updates (reference/behavior.md,
// "Optimistic updates"): apply the change locally first, fire the write,
// and on failure revert local state and call toast.error(). The toast is
// the error channel for one-shot mutations (toggle, add, remove, delete);
// autosaved text fields use SaveTracker + SaveStatus instead, which carry
// their own inline retry.
//
// One module-level store; mount <Toast /> (ui/Toast.svelte) once at the
// app root to render it.

export type ToastItem = { id: number; text: string }

class Toasts {
  items = $state<ToastItem[]>([])
  #id = 0
  #timers = new Map<number, ReturnType<typeof setTimeout>>()

  error(text: string, ms = 4000) {
    // A repeat of a message already on screen extends it instead of
    // stacking an identical pill.
    const existing = this.items.find(t => t.text === text)
    if (existing) {
      clearTimeout(this.#timers.get(existing.id))
      this.#timers.set(existing.id, setTimeout(() => this.dismiss(existing.id), ms))
      return
    }
    const id = ++this.#id
    this.items = [...this.items, { id, text }]
    this.#timers.set(id, setTimeout(() => this.dismiss(id), ms))
  }

  dismiss(id: number) {
    clearTimeout(this.#timers.get(id))
    this.#timers.delete(id)
    this.items = this.items.filter(t => t.id !== id)
  }
}

export const toasts = new Toasts()
