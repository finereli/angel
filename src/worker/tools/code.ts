import type { Tool } from './registry'
import {
  newQuickJSAsyncWASMModuleFromVariant,
  newVariant,
} from 'quickjs-emscripten-core'
import asyncBaseVariant from '@jitl/quickjs-wasmfile-release-asyncify'
import type { QuickJSAsyncWASMModule, QuickJSAsyncContext } from 'quickjs-emscripten-core'
// Wrangler imports .wasm files as WebAssembly.Module
import wasmModule from '../quickjs.wasm'

const EXEC_TIMEOUT_MS = 10_000
const MAX_OUTPUT = 50_000
const MAX_FETCH_BODY = 50_000
const MEMORY_LIMIT = 10 * 1024 * 1024

const variant = newVariant(asyncBaseVariant, { wasmModule })

let modulePromise: Promise<QuickJSAsyncWASMModule> | null = null

function getModule(): Promise<QuickJSAsyncWASMModule> {
  if (!modulePromise) modulePromise = newQuickJSAsyncWASMModuleFromVariant(variant)
  return modulePromise
}

function setupConsole(vm: QuickJSAsyncContext, logs: string[]) {
  const fmt = (a: unknown) => typeof a === 'string' ? a : JSON.stringify(a)
  const logFn = vm.newFunction('log', (...args) => {
    logs.push(args.map(a => fmt(vm.dump(a))).join(' '))
  })
  const errorFn = vm.newFunction('error', (...args) => {
    logs.push('[error] ' + args.map(a => fmt(vm.dump(a))).join(' '))
  })
  const warnFn = vm.newFunction('warn', (...args) => {
    logs.push('[warn] ' + args.map(a => fmt(vm.dump(a))).join(' '))
  })
  const consoleObj = vm.newObject()
  vm.setProp(consoleObj, 'log', logFn)
  vm.setProp(consoleObj, 'error', errorFn)
  vm.setProp(consoleObj, 'warn', warnFn)
  vm.setProp(vm.global, 'console', consoleObj)
  consoleObj.dispose()
  logFn.dispose()
  errorFn.dispose()
  warnFn.dispose()
}

function setupFetch(vm: QuickJSAsyncContext) {
  const fetchFn = vm.newAsyncifiedFunction('__fetch', async (urlHandle, optsHandle) => {
    const url = vm.dump(urlHandle) as string
    const opts = optsHandle ? vm.dump(optsHandle) as Record<string, unknown> : {}
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), EXEC_TIMEOUT_MS)
      const res = await fetch(url, {
        method: (opts.method as string) || 'GET',
        headers: (opts.headers as Record<string, string>) || {},
        body: opts.body ? String(opts.body) : undefined,
        signal: controller.signal,
      })
      clearTimeout(timeout)
      const text = await res.text()
      const body = text.length > MAX_FETCH_BODY ? text.slice(0, MAX_FETCH_BODY) + '...(truncated)' : text
      const resultObj = vm.newObject()
      const statusNum = vm.newNumber(res.status)
      vm.setProp(resultObj, 'status', statusNum)
      statusNum.dispose()
      const okVal = res.ok ? vm.true : vm.false
      vm.setProp(resultObj, 'ok', okVal)
      const bodyStr = vm.newString(body)
      vm.setProp(resultObj, 'body', bodyStr)
      bodyStr.dispose()
      const headersObj = vm.newObject()
      const ct = res.headers.get('content-type') || ''
      const ctStr = vm.newString(ct)
      vm.setProp(headersObj, 'content-type', ctStr)
      ctStr.dispose()
      vm.setProp(resultObj, 'headers', headersObj)
      headersObj.dispose()
      return resultObj
    } catch (e) {
      const errObj = vm.newObject()
      const okVal = vm.false
      vm.setProp(errObj, 'ok', okVal)
      const statusNum = vm.newNumber(0)
      vm.setProp(errObj, 'status', statusNum)
      statusNum.dispose()
      const bodyStr = vm.newString('Error: ' + (e instanceof Error ? e.message : String(e)))
      vm.setProp(errObj, 'body', bodyStr)
      bodyStr.dispose()
      return errObj
    }
  })
  vm.setProp(vm.global, '__fetch', fetchFn)
  fetchFn.dispose()
}

function setupHelpers(vm: QuickJSAsyncContext) {
  const parseIntFn = vm.newFunction('__parseInt', (sHandle, radixHandle) => {
    const s = vm.dump(sHandle)
    const radix = radixHandle ? vm.dump(radixHandle) : undefined
    return vm.newNumber(parseInt(String(s), radix as number | undefined))
  })
  vm.setProp(vm.global, 'parseInt', parseIntFn)
  parseIntFn.dispose()

  const parseFloatFn = vm.newFunction('__parseFloat', (sHandle) => {
    return vm.newNumber(parseFloat(String(vm.dump(sHandle))))
  })
  vm.setProp(vm.global, 'parseFloat', parseFloatFn)
  parseFloatFn.dispose()
}

async function executeCode(code: string): Promise<string> {
  const module = await getModule()
  const runtime = module.newRuntime()
  runtime.setMemoryLimit(MEMORY_LIMIT)
  runtime.setMaxStackSize(1024 * 1024)

  let interrupted = false
  const deadline = Date.now() + EXEC_TIMEOUT_MS
  runtime.setInterruptHandler(() => {
    if (Date.now() > deadline) { interrupted = true; return true }
    return false
  })

  const vm = runtime.newContext()
  const logs: string[] = []

  try {
    setupConsole(vm, logs)
    setupFetch(vm)
    setupHelpers(vm)

    const result = await vm.evalCodeAsync(code)
    const output = logs.join('\n')
    if (result.error) {
      const err = vm.dump(result.error)
      result.error.dispose()
      const errMsg = typeof err === 'object' && err?.message ? err.message : String(err)
      console.error(`[run_code] error: ${errMsg}\n--- code ---\n${code.slice(0, 500)}\n---`)
      const text = (output ? output + '\n' : '') + 'Error: ' + errMsg
      return text.slice(0, MAX_OUTPUT)
    }
    const val = vm.dump(result.value)
    result.value.dispose()

    if (interrupted) {
      return ((output ? output + '\n' : '') + 'Error: Execution timed out (10s)').slice(0, MAX_OUTPUT)
    }
    if (val !== undefined) {
      const valStr = typeof val === 'string' ? val : JSON.stringify(val, null, 2)
      return (output + (output ? '\n' : '') + '→ ' + valStr).slice(0, MAX_OUTPUT)
    }
    return (output || '(no output)').slice(0, MAX_OUTPUT)
  } finally {
    vm.dispose()
    try { runtime.dispose() } catch {}
  }
}

export const codeTools: Tool[] = [
  {
    def: {
      type: 'function',
      function: {
        name: 'run_code',
        description: 'Run JavaScript code in a QuickJS sandbox (ES2020). Network access via __fetch(url, opts) — this is SYNCHRONOUS, do NOT use await or async. Call it directly: var res = __fetch("https://example.com/api", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({key: "value"})}); console.log(res.status, res.body); — res has {ok, status, body, headers}. No top-level await. No import/export. Use console.log() for output. 10s timeout, 10MB memory limit.',
        parameters: {
          type: 'object',
          properties: {
            code: { type: 'string', description: 'JavaScript code to execute' },
          },
          required: ['code'],
        },
      },
    },
    label: ['Running code', 'Ran code'],
    run: async (_ctx, args) => {
      const code = (args.code as string || '').trim()
      if (!code) return 'No code provided.'
      return executeCode(code)
    },
  },
  {
    def: {
      type: 'function',
      function: {
        name: 'save_script',
        description: 'Save a named script for later reuse. Overwrites if the name already exists.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Script name (unique per agent)' },
            code: { type: 'string', description: 'JavaScript code' },
            description: { type: 'string', description: 'What this script does' },
          },
          required: ['name', 'code'],
        },
      },
    },
    label: ['Saving script', 'Saved script'],
    run: async (ctx, args) => {
      const name = (args.name as string || '').trim()
      const code = (args.code as string || '').trim()
      const description = (args.description as string || '').trim() || null
      if (!name || !code) return 'Name and code are required.'
      await ctx.env.DB.prepare(
        `INSERT INTO agent_scripts (agent_id, name, description, code)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(agent_id, name) DO UPDATE SET code = excluded.code, description = excluded.description, updated_at = datetime('now')`
      ).bind(ctx.agentId, name, description, code).run()
      return `Script "${name}" saved.`
    },
  },
  {
    def: {
      type: 'function',
      function: {
        name: 'run_script',
        description: 'Run a previously saved script by name.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Script name to run' },
          },
          required: ['name'],
        },
      },
    },
    label: ['Running script', 'Ran script'],
    run: async (ctx, args) => {
      const name = (args.name as string || '').trim()
      if (!name) return 'Script name is required.'
      const row = await ctx.env.DB.prepare(
        `SELECT code FROM agent_scripts WHERE agent_id = ? AND name = ?`
      ).bind(ctx.agentId, name).first<{ code: string }>()
      if (!row) return `No script named "${name}". Use list_scripts to see your saved scripts.`
      return executeCode(row.code)
    },
  },
  {
    def: {
      type: 'function',
      function: {
        name: 'list_scripts',
        description: 'List your saved scripts.',
        parameters: { type: 'object', properties: {} },
      },
    },
    label: ['Listing scripts', 'Listed scripts'],
    run: async (ctx) => {
      const rows = await ctx.env.DB.prepare(
        `SELECT name, description, updated_at FROM agent_scripts WHERE agent_id = ? ORDER BY name`
      ).bind(ctx.agentId).all<{ name: string; description: string | null; updated_at: string }>()
      const scripts = rows.results || []
      if (scripts.length === 0) return 'No saved scripts. Use save_script to create one.'
      return scripts.map(s => {
        const desc = s.description ? ` — ${s.description}` : ''
        return `• ${s.name}${desc} (updated ${s.updated_at})`
      }).join('\n')
    },
  },
  {
    def: {
      type: 'function',
      function: {
        name: 'delete_script',
        description: 'Delete a saved script by name.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Script name to delete' },
          },
          required: ['name'],
        },
      },
    },
    label: ['Deleting script', 'Deleted script'],
    run: async (ctx, args) => {
      const name = (args.name as string || '').trim()
      if (!name) return 'Script name is required.'
      const result = await ctx.env.DB.prepare(
        `DELETE FROM agent_scripts WHERE agent_id = ? AND name = ?`
      ).bind(ctx.agentId, name).run()
      return result.meta.changes ? `Script "${name}" deleted.` : `No script named "${name}".`
    },
  },
]
