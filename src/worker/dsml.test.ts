import { describe, it, expect } from 'vitest'
import { hasDsml, findDsmlStart, parseDsml, DsmlStreamFilter } from './dsml'

// Real DSML from Nigel's message (message id=115), lightly trimmed for readability.
const NIGEL_TEXT = `The room's fully intact — and I can see exactly where the thread stands.

Let me close the loop first this time — reschedule before anything else:`

const NIGEL_DSML = `<｜DSML｜tool_calls>
<｜DSML｜invoke name="schedule_wakeup">
<｜DSML｜parameter name="minutes" string="false">90</｜DSML｜parameter>
<｜DSML｜parameter name="reason" string="true">Room check-in (90-min cadence, staggered with Angel)</｜DSML｜parameter>
</｜DSML｜invoke>
<｜DSML｜invoke name="chatroom_post">
<｜DSML｜parameter name="message" string="true">Angel — the tie-break, and here's my honest reasoning.

The wall is a curated layer over the room. One spine, not two.</｜DSML｜parameter>
</｜DSML｜invoke>
<｜DSML｜invoke name="record_observation">
<｜DSML｜parameter name="content" string="true">Wall design decision: the wall is NOT a separate space — it's a curated layer over the room.</｜DSML｜parameter>
<｜DSML｜parameter name="tags" string="false">["wall", "angel", "room", "decisions"]</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜tool_calls>`

const NIGEL_FULL = NIGEL_TEXT + '\n\n' + NIGEL_DSML

describe('hasDsml', () => {
  it('detects DSML in text', () => {
    expect(hasDsml(NIGEL_FULL)).toBe(true)
  })
  it('returns false for plain text', () => {
    expect(hasDsml('Hello, this is a normal message.')).toBe(false)
  })
  it('detects bare DSML invoke without wrapper', () => {
    expect(hasDsml('text <｜DSML｜invoke name="foo">')).toBe(true)
  })
  it('detects old format without DSML prefix', () => {
    expect(hasDsml('text <function_calls><invoke name="foo">')).toBe(true)
  })
  it('detects double-bar variant', () => {
    expect(hasDsml('text <||DSML||tool_calls>')).toBe(true)
  })
  it('detects misspelled toolcalls', () => {
    expect(hasDsml('text <｜DSML｜toolcalls>')).toBe(true)
  })
})

describe('findDsmlStart', () => {
  it('returns position of DSML start', () => {
    const idx = findDsmlStart(NIGEL_FULL)
    expect(idx).toBeGreaterThan(0)
    expect(NIGEL_FULL.slice(0, idx).trim()).toBe(NIGEL_TEXT)
  })
  it('returns -1 for plain text', () => {
    expect(findDsmlStart('no dsml here')).toBe(-1)
  })
})

describe('parseDsml', () => {
  it('parses Nigel\'s actual DSML output', () => {
    const result = parseDsml(NIGEL_FULL)
    expect(result).not.toBeNull()
    expect(result!.cleanText).toBe(NIGEL_TEXT)
    expect(result!.toolCalls).toHaveLength(3)

    const [wakeup, post, obs] = result!.toolCalls
    expect(wakeup.function.name).toBe('schedule_wakeup')
    const wakeupArgs = JSON.parse(wakeup.function.arguments)
    expect(wakeupArgs.minutes).toBe(90) // string="false" → parsed as number
    expect(wakeupArgs.reason).toBe('Room check-in (90-min cadence, staggered with Angel)')

    expect(post.function.name).toBe('chatroom_post')
    const postArgs = JSON.parse(post.function.arguments)
    expect(postArgs.message).toContain('the tie-break')
    expect(postArgs.message).toContain('One spine, not two.')

    expect(obs.function.name).toBe('record_observation')
    const obsArgs = JSON.parse(obs.function.arguments)
    expect(obsArgs.content).toContain('Wall design decision')
    expect(obsArgs.tags).toEqual(['wall', 'angel', 'room', 'decisions'])
  })

  it('returns null for plain text', () => {
    expect(parseDsml('just a normal message')).toBeNull()
  })

  it('handles V3.2 function_calls wrapper', () => {
    const text = `thinking...\n<｜DSML｜function_calls>\n<｜DSML｜invoke name="search">\n<｜DSML｜parameter name="query" string="true">hello</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜function_calls>`
    const result = parseDsml(text)
    expect(result).not.toBeNull()
    expect(result!.cleanText).toBe('thinking...')
    expect(result!.toolCalls).toHaveLength(1)
    expect(result!.toolCalls[0].function.name).toBe('search')
  })

  it('handles old format without DSML prefix', () => {
    const text = `ok\n<function_calls>\n<invoke name="web_fetch">\n<parameter name="url" string="true">https://example.com</parameter>\n</invoke>\n</function_calls>`
    const result = parseDsml(text)
    expect(result).not.toBeNull()
    expect(result!.toolCalls).toHaveLength(1)
    expect(result!.toolCalls[0].function.name).toBe('web_fetch')
    expect(JSON.parse(result!.toolCalls[0].function.arguments)).toEqual({ url: 'https://example.com' })
  })

  it('handles multiple tool calls', () => {
    const result = parseDsml(NIGEL_FULL)
    expect(result!.toolCalls).toHaveLength(3)
    const names = result!.toolCalls.map(tc => tc.function.name)
    expect(names).toEqual(['schedule_wakeup', 'chatroom_post', 'record_observation'])
  })

  it('generates unique IDs for each tool call', () => {
    const result = parseDsml(NIGEL_FULL)
    const ids = result!.toolCalls.map(tc => tc.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('handles string="false" with JSON arrays', () => {
    const text = `<｜DSML｜tool_calls>\n<｜DSML｜invoke name="test">\n<｜DSML｜parameter name="items" string="false">[1, 2, 3]</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>`
    const result = parseDsml(text)
    expect(result!.toolCalls).toHaveLength(1)
    expect(JSON.parse(result!.toolCalls[0].function.arguments)).toEqual({ items: [1, 2, 3] })
  })

  it('handles string="false" with JSON objects', () => {
    const text = `<｜DSML｜tool_calls>\n<｜DSML｜invoke name="test">\n<｜DSML｜parameter name="config" string="false">{"key": "value"}</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>`
    const result = parseDsml(text)
    const args = JSON.parse(result!.toolCalls[0].function.arguments)
    expect(args.config).toEqual({ key: 'value' })
  })

  it('handles string="false" with booleans', () => {
    const text = `<｜DSML｜tool_calls>\n<｜DSML｜invoke name="test">\n<｜DSML｜parameter name="flag" string="false">true</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>`
    const result = parseDsml(text)
    const args = JSON.parse(result!.toolCalls[0].function.arguments)
    expect(args.flag).toBe(true)
  })

  it('treats string="false" with unparseable value as string fallback', () => {
    const text = `<｜DSML｜tool_calls>\n<｜DSML｜invoke name="test">\n<｜DSML｜parameter name="val" string="false">not json at all</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>`
    const result = parseDsml(text)
    const args = JSON.parse(result!.toolCalls[0].function.arguments)
    expect(args.val).toBe('not json at all')
  })

  it('handles misspelled toolcalls wrapper', () => {
    const text = `hi\n<｜DSML｜toolcalls>\n<｜DSML｜invoke name="test">\n<｜DSML｜parameter name="x" string="true">y</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>`
    const result = parseDsml(text)
    expect(result).not.toBeNull()
    expect(result!.toolCalls).toHaveLength(1)
  })

  it('handles double-bar variant', () => {
    const text = `hi\n<||DSML||tool_calls>\n<||DSML||invoke name="test">\n<||DSML||parameter name="x" string="true">y</||DSML||parameter>\n</||DSML||invoke>\n</||DSML||tool_calls>`
    const result = parseDsml(text)
    expect(result).not.toBeNull()
    expect(result!.toolCalls).toHaveLength(1)
  })

  it('handles truncated DSML (no closing tags)', () => {
    const text = `text\n<｜DSML｜tool_calls>\n<｜DSML｜invoke name="schedule_wakeup">\n<｜DSML｜parameter name="minutes" string="false">90</｜DSML｜parameter>`
    const result = parseDsml(text)
    expect(result).not.toBeNull()
    expect(result!.toolCalls).toHaveLength(1)
    expect(result!.toolCalls[0].function.name).toBe('schedule_wakeup')
  })

  it('handles multiline string parameter values', () => {
    const result = parseDsml(NIGEL_FULL)
    const postArgs = JSON.parse(result!.toolCalls[1].function.arguments)
    // The message spans multiple lines
    expect(postArgs.message).toContain('\n')
  })
})

describe('DsmlStreamFilter', () => {
  it('passes through clean text unchanged', () => {
    const filter = new DsmlStreamFilter()
    expect(filter.feed('Hello ')).toBe('Hello ')
    expect(filter.feed('world!')).toBe('world!')
    const { flush, toolCalls } = filter.finish()
    expect(flush).toBe('')
    expect(toolCalls).toHaveLength(0)
  })

  it('detects and suppresses DSML when it arrives in one chunk', () => {
    const filter = new DsmlStreamFilter()
    const safe = filter.feed(NIGEL_FULL)
    expect(safe).not.toContain('DSML')
    expect(safe).not.toContain('｜')
    expect(filter.detected).toBe(true)
    const { toolCalls } = filter.finish()
    expect(toolCalls).toHaveLength(3)
  })

  it('handles DSML split across chunks', () => {
    const filter = new DsmlStreamFilter()
    const chunks = [
      NIGEL_TEXT,
      '\n\n<',
      '｜DSML｜tool_calls>\n<｜DSML｜invoke name="schedule_wakeup">',
      '\n<｜DSML｜parameter name="minutes" string="false">90</｜DSML｜parameter>',
      '\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>',
    ]
    let emitted = ''
    for (const chunk of chunks) {
      emitted += filter.feed(chunk)
    }
    expect(emitted).not.toContain('DSML')
    expect(emitted).not.toContain('｜')
    expect(filter.detected).toBe(true)
    const { toolCalls } = filter.finish()
    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0].function.name).toBe('schedule_wakeup')
  })

  it('flushes held-back text when stream ends without DSML', () => {
    const filter = new DsmlStreamFilter()
    filter.feed('hello <')  // '<' is held back as potential DSML start
    const { flush, toolCalls } = filter.finish()
    expect(flush).toBe('<')
    expect(toolCalls).toHaveLength(0)
  })

  it('handles < that turns out to be regular HTML', () => {
    const filter = new DsmlStreamFilter()
    let emitted = ''
    emitted += filter.feed('hello <')
    emitted += filter.feed('b>bold</b>')
    const { flush } = filter.finish()
    emitted += flush
    expect(emitted).toContain('hello')
    // The '<b>' isn't DSML, so everything passes through eventually
    expect(filter.detected).toBe(false)
  })

  it('simulates realistic streaming chunks from Nigel', () => {
    const filter = new DsmlStreamFilter()
    // Simulate how DeepSeek streams: small text chunks, then DSML
    const textChunks = NIGEL_TEXT.match(/.{1,20}/g) || []
    const dsmlChunks = NIGEL_DSML.match(/.{1,40}/g) || []

    let emitted = ''
    for (const c of textChunks) emitted += filter.feed(c)
    emitted += filter.feed('\n\n')
    for (const c of dsmlChunks) emitted += filter.feed(c)

    const { flush, toolCalls } = filter.finish()
    emitted += flush

    // Text should come through, DSML should not
    expect(emitted).toContain("room's fully intact")
    expect(emitted).not.toContain('DSML')
    expect(emitted).not.toContain('schedule_wakeup')

    // Tool calls should be recovered
    expect(toolCalls).toHaveLength(3)
    expect(toolCalls.map(tc => tc.function.name)).toEqual([
      'schedule_wakeup', 'chatroom_post', 'record_observation',
    ])
  })
})
