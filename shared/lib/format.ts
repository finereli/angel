// pwa-kit: format/lib/format.ts v1
// Date and time formatting, one module per project so every component renders alike.

// Today's date as YYYY-MM-DD in the *local* timezone. Never use
// toISOString().slice(0, 10) for this - that's UTC, and in Israel it points at
// yesterday between midnight and 3am.
export function localDateStr(d: Date = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// dd/mm/yyyy - the display convention for dates across the admin.
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '-'
  const [y, m, day] = iso.slice(0, 10).split('-')
  return `${day}/${m}/${y}`
}

// m:ss for durations and playback positions.
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}
