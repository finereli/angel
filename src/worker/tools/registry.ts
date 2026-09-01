import type { Env, ServerMsg, ToolDefinition } from '../types'
import { memoryTools } from './memory'
import { listTools } from './lists'
import { documentTools } from './documents'
import { webTools } from './web'
import { utilTools } from './util'
import { chatroomTools } from './chatroom'
import { budgetTools } from './budget'
import { wakeupTools } from './wakeup'
import { wallTools } from './wall'
import { codeTools } from './code'
import { deliveryTools } from './delivery'
import { randomTools } from './random'
import { agentTools } from './agents'
import { x402Tools } from './x402'
import { trackerTools } from './tracker'
import { dmTools } from './dm'
import { githubTools } from './github'
import { sandboxTools } from './sandbox'

export interface ToolContext {
  env: Env
  conversationId: string
  agentId: string
  // Present when the tool runs inside the DO's live event loop; lets a tool
  // push updates (e.g. a chatroom post) to connected clients immediately.
  broadcast?: (msg: ServerMsg) => void
}

export interface Tool {
  def: ToolDefinition
  label: [string, string] // [in-progress, done]
  // Optional args-aware done label (e.g. "Ran: npm test") shown in the stream
  // instead of the static one - the visible log line of what actually happened.
  doneLabel?: (args: Record<string, unknown>) => string
  run: (ctx: ToolContext, args: Record<string, unknown>) => Promise<string>
}

const ALL_TOOLS: Tool[] = [
  ...memoryTools,
  ...webTools,
  ...listTools,
  ...documentTools,
  ...utilTools,
  ...chatroomTools,
  ...budgetTools,
  ...wakeupTools,
  ...wallTools,
  ...codeTools,
  ...deliveryTools,
  ...randomTools,
  ...agentTools,
  ...x402Tools,
  ...trackerTools,
  ...dmTools,
  ...githubTools,
  ...sandboxTools,
]

const byName = new Map(ALL_TOOLS.map(t => [t.def.function.name, t]))

// [in-progress, done] labels per tool, derived from the tools themselves.
export const TOOL_LABELS: Record<string, [string, string]> = Object.fromEntries(
  ALL_TOOLS.map(t => [t.def.function.name, t.label])
)

export function getToolDefinitions(): ToolDefinition[] {
  return ALL_TOOLS.map(t => t.def)
}

export async function executeTool(
  ctx: ToolContext, name: string, args: Record<string, unknown>,
): Promise<string> {
  const tool = byName.get(name)
  if (!tool) return `Unknown tool: ${name}`
  return tool.run(ctx, args)
}

export function toolDoneLabel(name: string, args: Record<string, unknown>): string {
  const tool = byName.get(name)
  if (!tool) return name
  try { return tool.doneLabel?.(args) || tool.label[1] } catch { return tool.label[1] }
}
