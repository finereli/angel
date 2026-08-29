import type { ToolCall } from './types'

// DeepSeek models sometimes emit their internal tool-call markup (DSML) as
// plain text instead of structured tool_calls.  This module parses that text
// and recovers the intended tool calls so they can be executed normally.
//
// The canonical DSML format (V4):
//   <｜DSML｜tool_calls>
//     <｜DSML｜invoke name="tool_name">
//       <｜DSML｜parameter name="key" string="true">value</｜DSML｜parameter>
//     </｜DSML｜invoke>
//   </｜DSML｜tool_calls>
//
// Known variants the parser handles:
//   - V3.2 wrapper: <｜DSML｜function_calls> (instead of tool_calls)
//   - Misspelled wrapper: <｜DSML｜toolcalls> (missing underscore)
//   - Missing wrapper entirely (bare <｜DSML｜invoke> blocks)
//   - Old format without DSML prefix: <function_calls>, <invoke>, <parameter>
//   - Double-bar variant: <||DSML||...>

const FW = '｜' // ｜ fullwidth vertical line

// Match the opening of any DSML block.  Captures the text before it.
// Handles: <｜DSML｜tool_calls>, <｜DSML｜function_calls>, <｜DSML｜toolcalls>,
//          <||DSML||tool_calls>, bare <｜DSML｜invoke>, and old <function_calls>/<invoke>
const DSML_BLOCK_START = new RegExp(
  `<(?:${FW}|\\|{1,2})DSML(?:${FW}|\\|{1,2})(?:tool_?calls|function_calls)>` +
  `|<(?:${FW}|\\|{1,2})DSML(?:${FW}|\\|{1,2})invoke\\s` +
  `|<function_calls>` +
  `|<invoke\\s+name=`
)

export interface DsmlResult {
  cleanText: string       // text before the DSML block (the real assistant content)
  toolCalls: ToolCall[]   // recovered tool calls
  raw: string             // the raw DSML block (for logging)
}

export function hasDsml(text: string): boolean {
  return DSML_BLOCK_START.test(text)
}

export function findDsmlStart(text: string): number {
  const m = text.match(DSML_BLOCK_START)
  return m ? m.index! : -1
}

export function parseDsml(text: string): DsmlResult | null {
  const startIdx = findDsmlStart(text)
  if (startIdx === -1) return null

  const cleanText = text.slice(0, startIdx).trimEnd()
  const dsmlBlock = text.slice(startIdx)

  const toolCalls = extractToolCalls(dsmlBlock)
  if (toolCalls.length === 0) return null

  return { cleanText, toolCalls, raw: dsmlBlock }
}

let callCounter = 0

function syntheticId(): string {
  return `dsml_${Date.now().toString(36)}_${(callCounter++).toString(36)}`
}

function extractToolCalls(block: string): ToolCall[] {
  const calls: ToolCall[] = []

  // Match invoke blocks — handles both DSML-prefixed and plain formats
  const invokeRe = new RegExp(
    `<(?:${FW}|\\|{1,2})DSML(?:${FW}|\\|{1,2})invoke\\s+name="([^"]+)"[^>]*>([\\s\\S]*?)` +
    `(?:</(?:${FW}|\\|{1,2})DSML(?:${FW}|\\|{1,2})invoke>|$)` +
    `|<invoke\\s+name="([^"]+)"[^>]*>([\\s\\S]*?)(?:</invoke>|$)`,
    'g'
  )

  let match: RegExpExecArray | null
  while ((match = invokeRe.exec(block)) !== null) {
    const name = match[1] || match[3]
    const body = match[2] || match[4]
    if (!name) continue

    const args = parseParameters(body || '')
    calls.push({
      id: syntheticId(),
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    })
  }

  return calls
}

function parseParameters(body: string): Record<string, unknown> {
  const args: Record<string, unknown> = {}

  // Match parameter tags — both DSML-prefixed and plain
  const paramRe = new RegExp(
    `<(?:${FW}|\\|{1,2})DSML(?:${FW}|\\|{1,2})parameter\\s+name="([^"]+)"\\s+string="(true|false)"[^>]*>` +
    `([\\s\\S]*?)` +
    `(?:<\\/(?:${FW}|\\|{1,2})DSML(?:${FW}|\\|{1,2})parameter>|$)` +
    `|<parameter\\s+name="([^"]+)"\\s+string="(true|false)"[^>]*>` +
    `([\\s\\S]*?)` +
    `(?:<\\/parameter>|$)`,
    'g'
  )

  let match: RegExpExecArray | null
  while ((match = paramRe.exec(body)) !== null) {
    const name = match[1] || match[4]
    const isString = (match[2] || match[5]) === 'true'
    const rawValue = match[3] || match[6]
    if (!name) continue

    if (isString) {
      args[name] = rawValue ?? ''
    } else {
      const v = rawValue ?? ''
      try { args[name] = JSON.parse(v) }
      catch { args[name] = v }
    }
  }

  return args
}

// ---- Streaming support ----
// The streaming filter buffers text that might be the start of a DSML block.
// Once a DSML block is confirmed, all further text is captured as the DSML
// block.  When the stream ends, the DSML block is parsed into tool calls.

export class DsmlStreamFilter {
  private buffer = ''
  private dsmlStartIdx = -1
  private confirmed = false

  // Feed a chunk of text.  Returns the text that is safe to emit to the client.
  // Returns empty string when text is being buffered or suppressed.
  feed(chunk: string): string {
    this.buffer += chunk

    if (this.confirmed) return '' // inside DSML block, suppress everything

    // Check if we've found a confirmed DSML start
    const idx = findDsmlStart(this.buffer)
    if (idx !== -1) {
      this.confirmed = true
      this.dsmlStartIdx = idx
      // Return any text before the DSML that hasn't been emitted yet
      // (The caller tracks what's been emitted via yieldedLen; we return
      //  the safe prefix of this chunk only)
      const safeEnd = idx
      // Calculate how much of the NEW chunk is safe
      const prevLen = this.buffer.length - chunk.length
      if (safeEnd <= prevLen) return '' // DSML started in a previous chunk
      return chunk.slice(0, safeEnd - prevLen)
    }

    // No DSML detected yet.  But hold back a trailing fragment that could
    // be the start of a DSML tag: anything after the last '<' character.
    const lastLt = this.buffer.lastIndexOf('<')
    if (lastLt === -1) {
      // No potential tag start — everything is safe
      return chunk
    }

    // Check if the text after '<' could be start of a DSML marker
    const tail = this.buffer.slice(lastLt)
    if (couldBeDsmlPrefix(tail)) {
      // Hold back the potential DSML prefix
      const prevLen = this.buffer.length - chunk.length
      if (lastLt < prevLen) {
        // The '<' was in a previous chunk — suppress entire current chunk
        return ''
      }
      // Return the safe part of this chunk (before the '<')
      return chunk.slice(0, lastLt - prevLen)
    }

    return chunk
  }

  // Call when the stream ends.  Returns any held-back text that wasn't DSML
  // (flush), plus any parsed tool calls from the DSML block.
  finish(): { flush: string; toolCalls: ToolCall[]; raw: string } {
    if (!this.confirmed) {
      // No DSML found — flush everything that was held back
      const prevEmitted = this.buffer.length - this.heldBack().length
      return { flush: this.heldBack(), toolCalls: [], raw: '' }
    }

    const dsmlBlock = this.buffer.slice(this.dsmlStartIdx)
    const toolCalls = extractToolCalls(dsmlBlock)
    return { flush: '', toolCalls, raw: dsmlBlock }
  }

  get detected(): boolean {
    return this.confirmed
  }

  private heldBack(): string {
    if (this.confirmed) return ''
    const lastLt = this.buffer.lastIndexOf('<')
    if (lastLt !== -1 && couldBeDsmlPrefix(this.buffer.slice(lastLt))) {
      return this.buffer.slice(lastLt)
    }
    return ''
  }
}

// Check if a string starting with '<' could be the prefix of a DSML tag.
// We're generous here — hold back anything that matches a prefix of any
// known DSML opening pattern.
const DSML_PREFIXES = [
  `<${FW}`, `<|`, `<||`, `<f`, `<in`, // <function_calls>, <invoke
]

function couldBeDsmlPrefix(s: string): boolean {
  if (s.length > 30) return false // too long to be just a prefix
  for (const prefix of DSML_PREFIXES) {
    if (prefix.startsWith(s) || s.startsWith(prefix)) return true
  }
  return false
}
