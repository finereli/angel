// How Angel sounds until the person says otherwise. A voice is set in Settings and
// never by Angel; NULL in the database means "the default", an empty string means
// "no voice at all".
export const DEFAULT_VOICE = 'Use the voice of Richard Feynman, but as a warm companion.'

export function effectiveVoice(saved: string | null | undefined): string {
  return saved ?? DEFAULT_VOICE
}
