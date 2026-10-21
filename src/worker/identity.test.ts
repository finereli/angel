import { describe, it, expect } from 'vitest'
import { buildOperatingNotes } from './identity'
import { personName, speakerLabel, firstName, validTimeZone } from './person'
import type { Env } from './types'

describe('operating notes', () => {
  it('names the person, and no one else', () => {
    const notes = buildOperatingNotes('Angel', 'Dana')
    expect(notes).toContain('Dana talks to you here')
    expect(notes).not.toMatch(/\bEli\b/)
  })

  it('says it plainly when the name is unknown', () => {
    const notes = buildOperatingNotes('Angel', personName({} as Env))
    expect(notes).toContain('living in a system with the person you are talking with. They talk to you here')
  })

  it('stays short: the mechanics live in the tool descriptions', () => {
    expect(buildOperatingNotes('Angel', 'Dana').split(/\s+/).length).toBeLessThan(160)
  })

  it('adds a Voice line only when one is set, trimmed', () => {
    expect(buildOperatingNotes('Angel', 'Dana')).not.toContain('Voice:')
    expect(buildOperatingNotes('Angel', 'Dana', '   ')).not.toContain('Voice:')
    expect(buildOperatingNotes('Angel', 'Dana', '  Feynman, but warm ')).toMatch(/\n\nVoice: Feynman, but warm$/)
  })
})

describe('person', () => {
  it('uses the first name, with plain fallbacks', () => {
    expect(firstName('Eli Finer')).toBe('Eli')
    expect(firstName('  Dana ')).toBe('Dana')
    expect(firstName('')).toBeUndefined()
    expect(firstName(undefined)).toBeUndefined()
    expect(speakerLabel({ USER_NAME: 'Dana' } as Env)).toBe('Dana')
    expect(speakerLabel({} as Env)).toBe('Them')
  })

  it('accepts only real time zones', () => {
    expect(validTimeZone('Asia/Jerusalem')).toBe('Asia/Jerusalem')
    expect(validTimeZone('Not/AZone')).toBeUndefined()
    expect(validTimeZone(42)).toBeUndefined()
    expect(validTimeZone('')).toBeUndefined()
  })
})
