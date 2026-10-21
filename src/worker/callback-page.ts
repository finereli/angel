// The page a connector sign-in lands on. Plain HTML from the worker (the app's
// service worker skips /api/), styled to match, closing itself when it can.
const esc = (s: string) => s.replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`)

export function callbackPage(ok: boolean, message: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Angel - ${ok ? 'Connected' : 'Sign-in failed'}</title>
<style>
  :root { color-scheme: light dark; --bg: #f7f7fb; --fg: #1e1e2e; --muted: #5c5f77; --accent: #4f46e5; --bad: #d20f39; }
  @media (prefers-color-scheme: dark) { :root { --bg: #1e1e2e; --fg: #cdd6f4; --muted: #a6adc8; --accent: #a5b4fc; --bad: #f38ba8; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg);
    font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 16px; box-sizing: border-box; }
  main { max-width: 26rem; text-align: center; }
  h1 { font-size: 1.2rem; margin: 0 0 8px; color: ${ok ? 'var(--accent)' : 'var(--bad)'}; }
  p { margin: 0 0 20px; color: var(--muted); }
  a { color: var(--accent); }
</style></head>
<body><main>
  <h1>${ok ? 'Connected' : "That didn't work"}</h1>
  <p>${esc(message)}</p>
  <a href="/#/settings/connectors">Back to Angel</a>
</main>
${ok ? '<script>setTimeout(() => { if (window.opener) window.close() }, 1200)</script>' : ''}
</body></html>`
}
