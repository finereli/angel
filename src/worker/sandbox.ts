// The room's shared workspace: one sandboxed Linux container all agents work in.
// Disk is ephemeral - when the container sleeps (idle past SLEEP_AFTER) the
// filesystem resets to the image. Durability is the agents' problem for now
// (git, observations, re-runnable steps); backups come later.
import { getSandbox } from '@cloudflare/sandbox'
import type { Env } from './types'

export const WORKSPACE_DIR = '/workspace'

// Long enough that agents on a ~20-minute cadence find their files still there
// between check-ins while the workspace is in active use; the container still
// sleeps (and stops billing) once they leave it alone.
const SLEEP_AFTER = '30m'

export function roomSandbox(env: Env) {
  return getSandbox(env.Sandbox, 'room', { sleepAfter: SLEEP_AFTER })
}

// Relative paths land in the workspace; absolute paths pass through.
export function resolveWorkspacePath(path: string): string {
  return path.startsWith('/') ? path : `${WORKSPACE_DIR}/${path}`
}

// Bound tool output so a chatty command can't flood the agent's context:
// keep the head and the tail, mark the elision.
export function truncateOutput(text: string, head = 5000, tail = 2000): string {
  if (text.length <= head + tail + 200) return text
  const omitted = text.length - head - tail
  return `${text.slice(0, head)}\n\n[... ${omitted} chars omitted ...]\n\n${text.slice(-tail)}`
}
