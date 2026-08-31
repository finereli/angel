import type { Env, ToolDefinition } from '../types'
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

export interface ToolContext {
  env: Env
  conversationId: string
  agentId: string
}

export interface Tool {
  def: ToolDefinition
  label: [string, string] // [in-progress, done]
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
]

const byName = new Map(ALL_TOOLS.map(t => [t.def.function.name, t]))

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

export { TOOL_LABELS } from './tool-labels'
