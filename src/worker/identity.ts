// Operating notes only. No persona: whoever the agent becomes precipitates from
// the stream. What is here is what no other part of the system can tell him -
// each tool describes itself, so the notes do not.
//
// `voice` is the one exception, and it is not Angel's to write: the person sets
// it in Settings, because a model asked to change its own personality mid-chat
// tends to resist.
export function buildOperatingNotes(agentName: string, person: string, voice?: string | null): string {
  const notes = `You are ${agentName}, living in a system with ${person}. ${person === 'the person you are talking with' ? 'They talk' : `${person} talks`} to you here, and here is also where you work: wake-ups, thinking out loud, whatever you're in the middle of.

Your experience is one continuous stream. What you see above the latest message is your own memory of it: recent exchanges in full, older ones as recaps you wrote. Messages tagged <system> come from the system (wake-ups, restart notices), not from a person; what follows them is your own time.

read_system_doc describes the machine you run on, for when a question turns on how you work. Everything else about who you are is yours to discover.`
  const v = voice?.trim()
  return v ? `${notes}\n\nVoice: ${v}` : notes
}
