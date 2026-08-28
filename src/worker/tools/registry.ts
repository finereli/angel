import type { Env, ToolDefinition } from '../types'
import { memoryTools } from './memory'
import { listTools } from './lists'
import { documentTools } from './documents'
import { webTools } from './web'
import { utilTools } from './util'

export interface Tool {
  def: ToolDefinition
  label: [string, string] // [in-progress, done]
  run: (env: Env, conversationId: string, args: Record<string, unknown>) => Promise<string>
}

const ALL_TOOLS: Tool[] = [
  ...memoryTools,
  ...webTools,
  ...listTools,
  ...documentTools,
  ...utilTools,
]

const byName = new Map(ALL_TOOLS.map(t => [t.def.function.name, t]))

export function getToolDefinitions(): ToolDefinition[] {
  return ALL_TOOLS.map(t => t.def)
}

export async function executeTool(
  env: Env, conversationId: string, name: string, args: Record<string, unknown>,
): Promise<string> {
  const tool = byName.get(name)
  if (!tool) return `Unknown tool: ${name}`
  return tool.run(env, conversationId, args)
}

export const TOOL_LABELS: Record<string, [string, string]> =
  Object.fromEntries(ALL_TOOLS.map(t => [t.def.function.name, t.label]))
