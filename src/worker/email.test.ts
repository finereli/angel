import { describe, it, expect } from 'vitest'
import { normalizeEmail } from './email'
import { effectiveVoice, DEFAULT_VOICE } from './voice'

describe('normalizeEmail', () => {
  it('folds every Gmail spelling of an inbox into one', () => {
    const same = ['eli.finer@gmail.com', 'elifiner@gmail.com', 'E.L.I.Finer@Gmail.com', 'elifiner+angel@gmail.com', 'eli.finer@googlemail.com', ' elifiner@gmail.com ']
    for (const e of same) expect(normalizeEmail(e)).toBe('elifiner@gmail.com')
  })

  it('only lowercases the rest: other providers care about dots and plus tags', () => {
    expect(normalizeEmail('First.Last@Example.com')).toBe('first.last@example.com')
    expect(normalizeEmail('a+b@example.com')).toBe('a+b@example.com')
    expect(normalizeEmail('x@gmail.com.evil.com')).toBe('x@gmail.com.evil.com')
  })

  it('leaves non-addresses alone', () => {
    expect(normalizeEmail('')).toBe('')
    expect(normalizeEmail('nonsense')).toBe('nonsense')
  })
})

describe('voice', () => {
  it('uses the default until one is saved, and an empty string means none', () => {
    expect(effectiveVoice(null)).toBe(DEFAULT_VOICE)
    expect(effectiveVoice(undefined)).toBe(DEFAULT_VOICE)
    expect(effectiveVoice('')).toBe('')
    expect(effectiveVoice('Be brief')).toBe('Be brief')
    expect(DEFAULT_VOICE).toMatch(/Feynman/)
  })
})
