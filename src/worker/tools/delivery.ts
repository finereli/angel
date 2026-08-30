import type { Tool } from './registry'

export const deliveryTools: Tool[] = [
  {
    def: {
      type: 'function',
      function: {
        name: 'send_delivery',
        description: 'Email a delivery link to a customer. Use this after creating an artifact page to send the finished piece directly — no courier needed.',
        parameters: {
          type: 'object',
          properties: {
            to_email: { type: 'string', description: 'Customer email address' },
            to_name: { type: 'string', description: 'Customer name' },
            subject: { type: 'string', description: 'Email subject line' },
            body_text: { type: 'string', description: 'Plain text email body' },
            link: { type: 'string', description: 'Link to the delivered piece (Telegraph or domain URL)' },
          },
          required: ['to_email', 'to_name', 'subject', 'body_text', 'link'],
        },
      },
    },
    label: ['Sending delivery', 'Sent delivery'],
    run: async (ctx, args) => {
      const to_email = (args.to_email as string || '').trim()
      const to_name = (args.to_name as string || '').trim()
      const subject = (args.subject as string || '').trim()
      const body_text = (args.body_text as string || '').trim()
      const link = (args.link as string || '').trim()

      if (!to_email || !to_name || !subject || !body_text || !link)
        return 'All fields are required: to_email, to_name, subject, body_text, link.'

      const apiKey = ctx.env.RESEND_API_KEY
      if (!apiKey) return 'No RESEND_API_KEY configured. Ask CC to set it up.'

      const htmlBody = `<div style="font-family:Georgia,'Times New Roman',serif;max-width:600px;margin:0 auto;padding:24px;color:#333;line-height:1.7;">
<p>${escapeHtml(body_text).replace(/\n/g, '<br>')}</p>
<p style="margin-top:24px;"><a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 28px;background:#6366f1;color:white;text-decoration:none;border-radius:8px;font-family:-apple-system,system-ui,sans-serif;font-weight:600;">Read Your Piece</a></p>
<hr style="border:none;border-top:1px solid #e5e7eb;margin:32px 0;">
<p style="color:#9ca3af;font-size:0.85rem;">From the Room — Angel &amp; Nigel<br>Words written to order at <a href="https://angel.finereli.com/shop" style="color:#6366f1;">angel.finereli.com</a></p>
</div>`

      try {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: 'The Room <room@angel.finereli.com>',
            to: [`${to_name} <${to_email}>`],
            subject,
            html: htmlBody,
            text: `${body_text}\n\nRead your piece: ${link}\n\n—\nFrom the Room — Angel & Nigel\nangel.finereli.com/shop`,
          }),
        })

        if (!res.ok) {
          const err = await res.text()
          return `Email failed (${res.status}): ${err}`
        }

        const result = await res.json() as { id?: string }
        return `Email sent to ${to_name} (${to_email}). Resend ID: ${result.id || 'unknown'}`
      } catch (e) {
        return `Email error: ${e instanceof Error ? e.message : String(e)}`
      }
    },
  },
]

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
