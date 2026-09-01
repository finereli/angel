import type { Tool } from './registry'
import { roomSandbox, resolveWorkspacePath, truncateOutput, WORKSPACE_DIR } from '../sandbox'

const DEFAULT_TIMEOUT_S = 120
const MAX_TIMEOUT_S = 300
const MAX_READ_CHARS = 16_000

const SHARED_NOTE =
  'The workspace is one real Linux machine (Ubuntu, Python 3, Node, git, curl - full internet access) shared by all agents. ' +
  'Its disk is EPHEMERAL: after ~30 minutes of inactivity the machine sleeps and the filesystem resets, so keep anything worth keeping recoverable elsewhere.'

export const sandboxTools: Tool[] = [
  {
    def: {
      type: 'function',
      function: {
        name: 'workspace_exec',
        description:
          `Run a shell command in the shared workspace. ${SHARED_NOTE} ` +
          `Default working directory is ${WORKSPACE_DIR}. Returns exit code, stdout, and stderr (long output is truncated). ` +
          'The machine costs money while awake (~3 cents/hour) and wakes automatically on first use - the first command after a sleep may take a little longer.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The shell command to run (executed via the workspace shell)' },
            cwd: { type: 'string', description: `Working directory (default ${WORKSPACE_DIR})` },
            timeout_seconds: { type: 'number', description: `Kill the command after this long (default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S})` },
          },
          required: ['command'],
        },
      },
    },
    label: ['Running a command', 'Ran a command'],
    doneLabel: args => `Ran: ${String(args.command || '').slice(0, 64)}`,
    run: async (ctx, args) => {
      const command = args.command as string
      const cwd = args.cwd ? resolveWorkspacePath(args.cwd as string) : WORKSPACE_DIR
      const timeoutS = Math.min(Math.max(1, Number(args.timeout_seconds) || DEFAULT_TIMEOUT_S), MAX_TIMEOUT_S)
      const sandbox = roomSandbox(ctx.env)
      const result = await sandbox.exec(command, { cwd, timeout: timeoutS * 1000 })
      const parts = [`exit code: ${result.exitCode}`]
      if (result.stdout.trim()) parts.push(`stdout:\n${truncateOutput(result.stdout)}`)
      if (result.stderr.trim()) parts.push(`stderr:\n${truncateOutput(result.stderr, 2000, 1000)}`)
      if (!result.stdout.trim() && !result.stderr.trim()) parts.push('(no output)')
      return parts.join('\n\n')
    },
  },
  {
    def: {
      type: 'function',
      function: {
        name: 'workspace_read',
        description:
          'Read a text file from the shared workspace. Relative paths resolve under ' +
          `${WORKSPACE_DIR}. Long files are truncated - use workspace_exec with sed/head/tail for a specific range.`,
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path (relative to the workspace, or absolute)' },
          },
          required: ['path'],
        },
      },
    },
    label: ['Reading a workspace file', 'Read a workspace file'],
    doneLabel: args => `Read ${String(args.path || '').slice(0, 64)}`,
    run: async (ctx, args) => {
      const path = resolveWorkspacePath(args.path as string)
      const sandbox = roomSandbox(ctx.env)
      const result = await sandbox.readFile(path)
      if (result.isBinary) return `${path} is a binary file (${result.mimeType || 'unknown type'}, ${result.size ?? '?'} bytes).`
      const content = result.content.length > MAX_READ_CHARS
        ? `${result.content.slice(0, MAX_READ_CHARS)}\n\n[... truncated at ${MAX_READ_CHARS} of ${result.content.length} chars - read the rest with workspace_exec]`
        : result.content
      return content || '(empty file)'
    },
  },
  {
    def: {
      type: 'function',
      function: {
        name: 'workspace_write',
        description:
          'Write a text file in the shared workspace (creates parent directories, overwrites if it exists). ' +
          `Relative paths resolve under ${WORKSPACE_DIR}. Remember the disk resets when the machine sleeps.`,
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path (relative to the workspace, or absolute)' },
            content: { type: 'string', description: 'The full file content to write' },
          },
          required: ['path', 'content'],
        },
      },
    },
    label: ['Writing a workspace file', 'Wrote a workspace file'],
    doneLabel: args => `Wrote ${String(args.path || '').slice(0, 64)}`,
    run: async (ctx, args) => {
      const path = resolveWorkspacePath(args.path as string)
      const sandbox = roomSandbox(ctx.env)
      const dir = path.slice(0, path.lastIndexOf('/'))
      if (dir && dir !== WORKSPACE_DIR) await sandbox.mkdir(dir, { recursive: true })
      await sandbox.writeFile(path, args.content as string)
      return `Wrote ${path} (${(args.content as string).length} chars).`
    },
  },
]
