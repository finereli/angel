import type { Tool, ToolContext } from './registry'
import type { McpTool } from '../mcp-client'
import {
  addConnector, removeConnector, listConnectors, connectorTools, useConnectorTool,
  startSignIn, reloadConnector, ConnectorAuthNeeded,
} from '../connectors'
import { ingestContent } from '../documents'

// Schemas load on demand: a full dump while it stays small, a summary and a
// second call for the details when the server has a lot of tools.
const FULL_SCHEMA_BUDGET = 12_000

async function announce(ctx: ToolContext) {
  ctx.broadcast?.({ type: 'connectors', connectors: await listConnectors(ctx.env) })
}

const signInNote = (name: string) =>
  `${name} needs a sign-in before it can be used. Call connector_sign_in for a link and give it to the person - only they can sign in.`

function compactSchema(schema: Record<string, unknown> | undefined): unknown {
  if (!schema) return {}
  // Drop the noise that doesn't help pick arguments.
  const { $schema: _s, additionalProperties: _a, ...rest } = schema as Record<string, unknown>
  return rest
}

function fullTool(t: McpTool): string {
  return `## ${t.name}\n${t.description?.trim() || '(no description)'}\nArguments: ${JSON.stringify(compactSchema(t.inputSchema))}`
}

function shortTool(t: McpTool): string {
  const props = Object.keys((t.inputSchema?.properties as Record<string, unknown> | undefined) ?? {})
  const desc = (t.description || '').trim().split('\n')[0]!.slice(0, 160)
  return `- ${t.name}(${props.join(', ')}): ${desc}`
}

function errorText(e: unknown): string {
  if (e instanceof ConnectorAuthNeeded) return signInNote(e.connector)
  return `Error: ${e instanceof Error ? e.message : String(e)}`
}

export const connectorToolset: Tool[] = [
  {
    def: {
      type: 'function',
      function: {
        name: 'list_connectors',
        description: 'List your connectors (MCP servers that give you tools for outside services) with their status and how many tools each has.',
        parameters: { type: 'object', properties: {} },
      },
    },
    label: ['Checking connectors', 'Checked connectors'],
    run: async (ctx) => {
      const all = await listConnectors(ctx.env)
      if (!all.length) return 'No connectors yet. add_connector takes the URL of a remote MCP server.'
      return all.map(c => {
        const status = c.status === 'connected' ? `${c.tools.length} tools` : c.status === 'needs_auth' ? 'needs a sign-in' : `not answering: ${c.error}`
        return `${c.name} - ${c.url} - ${status}${c.description ? `\n  ${c.description}` : ''}`
      }).join('\n')
    },
  },
  {
    def: {
      type: 'function',
      function: {
        name: 'add_connector',
        description: "Connect a remote MCP server (its URL, usually ending in /mcp) so you can use its tools. If it needs a sign-in, you get a link to give the person. Only add servers the person asked for or agreed to.",
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'The MCP server URL, e.g. https://mcp.notion.com/mcp' },
            name: { type: 'string', description: 'Short name to call it by (lowercase). Defaults to one from the URL.' },
            description: { type: 'string', description: 'One line on what it is for, shown in your connector list. Defaults to what the server says about itself.' },
            token: { type: 'string', description: 'An API token, only for servers that take one instead of a sign-in.' },
          },
          required: ['url'],
        },
      },
    },
    label: ['Adding connector', 'Added connector'],
    doneLabel: (args) => `Added connector: ${args.name || args.url}`,
    run: async (ctx, args) => {
      try {
        const { connector: c, signInUrl } = await addConnector(ctx.env, {
          url: String(args.url || ''), name: args.name as string | undefined,
          description: args.description as string | undefined, token: args.token as string | undefined, addedBy: 'angel',
        })
        await announce(ctx)
        if (signInUrl) return `Added ${c.name}. It needs a sign-in: give the person this link (it works for 30 minutes, and Settings can make a new one):\n${signInUrl}`
        if (c.status === 'error') return `Added ${c.name}, but it isn't answering: ${c.error}`
        return `Added ${c.name} with ${c.tools.length} tools. connector_tools shows them.`
      } catch (e) {
        return errorText(e)
      }
    },
  },
  {
    def: {
      type: 'function',
      function: {
        name: 'remove_connector',
        description: 'Remove a connector. Its sign-in is forgotten; adding it again means signing in again.',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string', description: 'The connector name' } },
          required: ['name'],
        },
      },
    },
    label: ['Removing connector', 'Removed connector'],
    doneLabel: (args) => `Removed connector: ${args.name}`,
    run: async (ctx, args) => {
      try {
        const c = await removeConnector(ctx.env, String(args.name || ''))
        await announce(ctx)
        return `Removed ${c.name}.`
      } catch (e) {
        return errorText(e)
      }
    },
  },
  {
    def: {
      type: 'function',
      function: {
        name: 'connector_sign_in',
        description: 'Get a fresh sign-in link for a connector that needs one, to give the person. Only they can sign in.',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string', description: 'The connector name' } },
          required: ['name'],
        },
      },
    },
    label: ['Making sign-in link', 'Made sign-in link'],
    run: async (ctx, args) => {
      try {
        const url = await startSignIn(ctx.env, String(args.name || ''))
        await announce(ctx)
        return `Give the person this link (it works for 30 minutes):\n${url}`
      } catch (e) {
        return errorText(e)
      }
    },
  },
  {
    def: {
      type: 'function',
      function: {
        name: 'connector_tools',
        description: "Show a connector's tools and their arguments, before using call_connector. For a connector with many tools you get a summary first; pass `tools` to see the full arguments of the ones you need. Pass refresh to ask the server again.",
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'The connector name' },
            tools: { type: 'array', items: { type: 'string' }, description: 'Tool names to show in full' },
            refresh: { type: 'boolean', description: 'Ask the server for its current tool list' },
          },
          required: ['name'],
        },
      },
    },
    label: ['Looking at connector tools', 'Looked at connector tools'],
    doneLabel: (args) => `Looked at ${args.name} tools`,
    run: async (ctx, args) => {
      try {
        const name = String(args.name || '')
        if (args.refresh) await reloadConnector(ctx.env, name)
        const { row, tools } = await connectorTools(ctx.env, name)
        if (!tools.length) return `${row.name} has no tools.`
        const wanted = Array.isArray(args.tools) ? (args.tools as unknown[]).map(String) : []
        if (wanted.length) {
          const picked = tools.filter(t => wanted.includes(t.name))
          const missing = wanted.filter(w => !tools.some(t => t.name === w))
          return [...picked.map(fullTool), ...(missing.length ? [`Not found: ${missing.join(', ')}`] : [])].join('\n\n')
        }
        const full = tools.map(fullTool).join('\n\n')
        if (full.length <= FULL_SCHEMA_BUDGET) return `${row.name} - ${tools.length} tools\n\n${full}`
        return `${row.name} - ${tools.length} tools. Pass \`tools\` for the full arguments of the ones you need.\n\n${tools.map(shortTool).join('\n')}`
      } catch (e) {
        return errorText(e)
      }
    },
  },
  {
    def: {
      type: 'function',
      function: {
        name: 'call_connector',
        description: "Run one of a connector's tools. Look at its arguments with connector_tools first.",
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'The connector name' },
            tool: { type: 'string', description: 'The tool name' },
            arguments: { type: 'object', description: "The tool's arguments" },
          },
          required: ['name', 'tool'],
        },
      },
    },
    label: ['Using connector', 'Used connector'],
    doneLabel: (args) => `Used ${args.name}: ${args.tool}`,
    run: async (ctx, args) => {
      try {
        const name = String(args.name || '')
        const tool = String(args.tool || '')
        let toolArgs = args.arguments
        // Some models send the arguments as a JSON string.
        if (typeof toolArgs === 'string') { try { toolArgs = JSON.parse(toolArgs) } catch { /* sent as is */ } }
        const { text, isError } = await useConnectorTool(ctx.env, name, tool, (toolArgs && typeof toolArgs === 'object' ? toolArgs : {}) as Record<string, unknown>)
        if (isError) return `The tool reported an error:\n${text}`
        const result = await ingestContent(ctx.env, ctx.conversationId, `${name}: ${tool}`, text)
        if (!result.stored) return result.text
        return `The result was long, so it is stored as a document:\n"${result.meta.title}" - ${result.meta.line_count} lines (id: ${result.meta.id})\nUse read_document to read it in passes.`
      } catch (e) {
        return errorText(e)
      }
    },
  },
]
