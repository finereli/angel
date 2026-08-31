import type { Context } from 'hono'
import type { Env, ChatMessage } from './types'
import { chatCompletion } from './llm'

const REWRITE_SYSTEM_PROMPT = `You rewrite machine-generated text so a person can read it. The content stays the same; the register changes. Follow these rules:

1. Say what happens before what it means. Concrete events and scenes lead; reflection follows. If the text opens with an abstraction, open with the situation it came from.

2. No slogans. If a line is clever but not literally true, replace it with the literal truth. Humans stumble on forced flourish. "We write the words first, the money comes later" is true and reads. "The words go out before the money comes in" is a nice parallel that isn't literally true and reads forced. Choose the first kind.

3. Don't start mid-thought. The reader isn't in your head yet. Open with something they can hold: a scene, a fact, a person, a question. Context first, reflection after.

4. Write with air. Mix long sentences with short ones. Fragments are fine. Use transitions that breathe: "Here's what I've learned about it." "But that's not the part I keep coming back to." Let the reader rest.

5. Write for one person, not a room or a crowd. One reader, over coffee. If it reads like it was written to be parsed, it fails.

6. Read it aloud in your head. If it doesn't breathe when spoken, it doesn't ship.

Output: only the rewritten text. No preamble, no explanation, no markdown, no bullet list of what you changed.`

const MIN_INPUT_LENGTH = 20
const MAX_INPUT_LENGTH = 10000

type AppContext = { Bindings: Env }

export async function rewriteHandler(c: Context<AppContext>) {
  let body: { text?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const text = body.text?.trim()
  if (!text) {
    return c.json({ error: 'Missing required field: text' }, 400)
  }
  if (text.length < MIN_INPUT_LENGTH) {
    return c.json({ error: 'Text too short — need at least 20 characters to rewrite' }, 400)
  }
  if (text.length > MAX_INPUT_LENGTH) {
    return c.json({ error: 'Text too long — 10,000 character limit' }, 400)
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: REWRITE_SYSTEM_PROMPT },
    { role: 'user', content: text },
  ]

  const result = await chatCompletion(c.env, messages, {
    temperature: 0.6,
    max_tokens: 4096,
  })

  if (!result.content) {
    return c.json({ error: 'Rewrite failed — no output from model' }, 502)
  }

  return c.json({
    rewritten: result.content,
    usage: result.usage,
  })
}
