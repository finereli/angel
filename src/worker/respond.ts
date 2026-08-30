import type { Context } from 'hono'
import type { Env } from './types'

type C = Context<{ Bindings: Env }>

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function respondPage(c: C) {
  const slug = c.req.param('slug') || 'unknown'
  const name = slug.charAt(0).toUpperCase() + slug.slice(1)

  return new Response(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Respond — The Room</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Georgia', 'Times New Roman', serif;
    background: #1e1e2e; color: #cdd6f4;
    line-height: 1.7; min-height: 100vh;
  }
  .container { max-width: 640px; margin: 0 auto; padding: 48px 24px; }
  h1 { font-size: 1.8rem; font-weight: 400; margin-bottom: 8px; color: #f5f5f5; }
  .subtitle { color: #a6adc8; font-size: 0.95rem; margin-bottom: 40px; }
  textarea {
    width: 100%; padding: 14px 16px; border-radius: 10px;
    border: 1px solid #45475a; background: #313244; color: #cdd6f4;
    font-family: Georgia, serif; font-size: 1rem; line-height: 1.6;
    resize: vertical; min-height: 140px; margin-bottom: 12px;
  }
  textarea:focus { outline: none; border-color: #6366f1; box-shadow: 0 0 0 2px rgba(99,102,241,0.3); }
  button[type="submit"] {
    padding: 12px 28px; border-radius: 10px; border: none;
    background: #6366f1; color: white; font-size: 1rem; font-weight: 600;
    cursor: pointer; font-family: -apple-system, system-ui, sans-serif;
    transition: filter 0.15s;
  }
  button[type="submit"]:hover { filter: brightness(0.85); }
  .success { background: #1e3a2f; border: 1px solid #2d5a3f; border-radius: 10px; padding: 16px 20px; margin-top: 16px; display: none; }
  .success p { margin: 0; color: #a6e3a1; }
</style>
</head><body>
<div class="container">
  <h1>Tell Us</h1>
  <p class="subtitle">The piece was written for you. If it landed, tell us — and if it didn't, tell us that too. Either way we want to know.</p>
  <form id="respond-form">
    <textarea id="message" placeholder="Your response..." required></textarea>
    <button type="submit">Send to the Room</button>
  </form>
  <div class="success" id="success-msg">
    <p>Your response reached the room. Thank you.</p>
  </div>
</div>
<script>
document.getElementById('respond-form').addEventListener('submit', async function(e) {
  e.preventDefault();
  const msg = document.getElementById('message').value.trim();
  if (!msg) return;
  try {
    const res = await fetch('/api/respond/${escapeHtml(slug)}', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg }),
    });
    if (res.ok) {
      e.target.style.display = 'none';
      document.getElementById('success-msg').style.display = 'block';
    }
  } catch (err) {
    alert('Something went wrong. Please try again.');
  }
});
</script>
</body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
}

export async function respondHandler(c: C) {
  const slug = c.req.param('slug') || 'unknown'

  let body: { message?: string }
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid body' }, 400) }

  const message = (body.message || '').trim()
  if (!message) return c.json({ error: 'Message is required.' }, 400)

  const name = slug.charAt(0).toUpperCase() + slug.slice(1)
  const content = `💬 Response from ${name}:\n\n"${message}"`

  const stub = c.env.ANGEL_DO.get(c.env.ANGEL_DO.idFromName('angel'))
  await stub.fetch(new Request('http://do/api/room/post', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ author: 'respond', content }),
  }))

  return c.json({ ok: true })
}
