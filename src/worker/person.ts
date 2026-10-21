// How prompts refer to the person Angel lives with. The name comes from their
// sign-in (first name only) and is kept in the user's Durable Object; with no
// name, prompts fall back to plain words rather than assuming anyone.
import type { Env } from './types'

export const personName = (env: Env): string => env.USER_NAME || 'the person you are talking with'

// Transcript speaker label for the person's side of an exchange.
export const speakerLabel = (env: Env): string => env.USER_NAME || 'Them'

// "Eli Finer" -> "Eli". Anything blank is no name.
export function firstName(full: string | null | undefined): string | undefined {
  return full?.trim().split(/\s+/)[0] || undefined
}

// Only a real IANA zone survives; anything else would throw later.
export function validTimeZone(tz: unknown): string | undefined {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return undefined
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz } catch { return undefined }
}
