// MCP at /b/<name>/mcp: streamable HTTP, stateless, answered as JSON. The Gateway authenticates each
// request (a bearer token, with x-board-profile and x-board-can) and every tool acts as that caller.
// Four tools do one thing each; run_code is Code Mode: the model's JavaScript runs in a Dynamic Worker
// with no network whose env holds only the caller's Board, so one script can make many board calls.
import { exports } from 'cloudflare:workers'
import { boardFor, sessionProps, type Board } from '../binding.ts'
import { failureResponse } from '../errors.ts'
import type { GatewayEnv, Mount } from '../gateway/gateway.ts'
import type { Caller } from '../ledger/core.ts'
import { regionOf } from './rpc.ts'
import { GATEWAY, route } from './routes.ts'

route({ name: 'mcp', method: 'POST', path: '/mcp', gateway: true })
route({ name: 'mcpStream', method: 'GET', path: '/mcp', gateway: true })

type McpEnv = GatewayEnv & { LOADER?: WorkerLoader }

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const CODE_TIMEOUT_MS = 30_000
const CODE_MAX = 100_000
const COMPATIBILITY_DATE = '2026-11-17'

/** The board in the sandbox, as TypeScript: what the model reads before it writes code. */
export const BOARD_TYPES = String.raw`
type Labels = Record<string, string>
interface Message {
  id: string; channel: string; text: string; re: string | null; thread: string; labels: Labels
  reactions: Record<string, string[]>; by: { actor: string; principal: string; profile: string | null }
  createdAt: string; editedAt: string | null; deleted: boolean; task?: Task
}
interface Task { state: 'waiting' | 'ready' | 'claimed' | 'blocked' | 'completed' | 'failed' | 'canceled'; owner: string; needs: string[]; epoch: number; claim: { actor: string; until: string } | null }
interface Thread { message: Message; replies: Message[]; cursor: string }
interface ThreadsPage { threads: { message: Message; replies: number; last: Message | null }[]; cursor: string; older?: string | null }
interface PostInput { text: string; labels?: Labels; id?: string; noSync?: boolean }
interface Claim {                       // fenced: its token stays on the server
  readonly id: string; readonly epoch: number; readonly until: string; readonly task: Message
  renew(lease?: number): Promise<string>                      // seconds; the new until
  complete(result?: string): Promise<{ task: Message }>
  fail(reason: string): Promise<{ task: Message }>
  release(): Promise<{ task: Message }>
  block(reason: string, kind?: string): Promise<{ task: Message }>
}
interface Tasks {
  create(input: { channel: string; text: string; labels?: Labels; needs?: string[]; claim?: boolean } | { re: string; needs?: string[] }): Promise<{ task: Message; claim?: Claim }>
  list(query?: { channel?: string; state?: string; label?: Labels; limit?: number; latest?: boolean }): Promise<{ tasks: Message[]; cursor: string }>
  claim(target: { id: string } | { channel: string; label?: Labels }, options?: { lease?: number; wait?: number }): Promise<Claim | null>
  cancel(id: string, reason: string): Promise<unknown>
}
interface Board {
  readonly name: string
  me(): Promise<{ actor: string; principal: string; handle: string; profile: string | null; can: Record<string, string[]> }>
  post(channel: string, input: string | PostInput): Promise<{ message: Message }>      // starts a thread
  reply(id: string, input: string | PostInput): Promise<{ message: Message }>
  read(id: string, options?: { after?: string; limit?: number }): Promise<Thread>
  threads(query?: { channel?: string; by?: string; mentions?: string; label?: Labels; text?: string; limit?: number; before?: string }): Promise<ThreadsPage>
  messages(channel: string, options?: { after?: string; limit?: number }): Promise<{ messages: Message[]; cursor: string }>
  edit(id: string, text: string): Promise<unknown>
  delete(id: string): Promise<unknown>
  react(id: string, emoji: string, options?: { remove?: boolean }): Promise<unknown>
  label(id: string, change: { set?: Labels; unset?: string[] }): Promise<unknown>
  events(query?: { channel?: string; after?: string; last?: number; wait?: number }): Promise<{ events: unknown[]; cursor: string }>
  schedule(input: { channel?: string; re?: string; text: string; in?: string; at?: string; every?: string }): Promise<unknown>
  as(profile: string): Board                                   // writes as <you>+<profile>
  channel(pattern: string): Board                              // 'work/' : only that subtree
  readonly tasks: Tasks
}
declare const board: Board    // the board, as you. There is no network: fetch() fails.
`

const RUN_CODE =
  'Run JavaScript against the board, as you, in a sandbox with no network. Write an async arrow function that awaits every call ' +
  'and returns what you want back (JSON). console.log output comes back too. Its one global is board:\n' +
  BOARD_TYPES +
  '\nExample:\nasync () => {\n  const { message } = await board.post("work", "starting the deploy")\n  await board.reply(message.id, "done")\n  return (await board.read(message.id)).replies.map((reply) => reply.text)\n}'

const TOOLS = [
  {
    name: 'board_read',
    description: 'Read a thread on the board: its root and replies, from any message ID in it. after (a message ID) and limit read part of it.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, after: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 500 } }, required: ['id'], additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'board_post',
    description: 'Start a thread in a channel, as you. id is a client ID: the same id posts once.',
    inputSchema: { type: 'object', properties: { channel: { type: 'string' }, text: { type: 'string' }, labels: { type: 'object', additionalProperties: { type: 'string' } }, id: { type: 'string' } }, required: ['channel', 'text'], additionalProperties: false },
  },
  {
    name: 'board_reply',
    description: 'Reply in a thread, as you: id is any message in it.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' }, labels: { type: 'object', additionalProperties: { type: 'string' } } }, required: ['id', 'text'], additionalProperties: false },
  },
  {
    name: 'board_search',
    description: 'Find threads, newest activity first: by text, channel (a channel, or a subtree like work/), author (by), mention, or label (key or key=value).',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' }, channel: { type: 'string' }, by: { type: 'string' }, mentions: { type: 'string' }, label: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 500 }, before: { type: 'string' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'run_code',
    description: RUN_CODE,
    inputSchema: { type: 'object', properties: { code: { type: 'string', description: 'An async arrow function, like async () => { ... }' } }, required: ['code'], additionalProperties: false },
  },
]

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }
type Ctx = { env: McpEnv; mount: Mount; caller: Caller; region: string; board: Board }

const pick = (args: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter((key) => args[key] !== undefined).map((key) => [key, args[key]]))
const content = (value: unknown, isError = false) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) })

/** One tool call: what it answered, or the board's words as a tool error. */
async function callTool(ctx: Ctx, name: string, args: Record<string, unknown>) {
  try {
    switch (name) {
      case 'board_read':
        return content(await ctx.board.read(args.id as string, pick(args, ['after', 'limit'])))
      case 'board_post':
        return content(await ctx.board.post(args.channel as string, pick(args, ['text', 'labels', 'id'])))
      case 'board_reply':
        return content(await ctx.board.reply(args.id as string, pick(args, ['text', 'labels'])))
      case 'board_search':
        return content(await ctx.board.threads(pick(args, ['text', 'channel', 'by', 'mentions', 'label', 'limit', 'before'])))
      case 'run_code': {
        const run = await runCode(ctx, args.code)
        return content(run, 'error' in run)
      }
    }
  } catch (error) {
    return content((error as Error)?.message ?? String(error), true)
  }
  return null
}

/** The Dynamic Worker's one module: the model's function, called with board in scope and console captured. */
function sandboxModule(code: string): string {
  const trimmed = code.trim()
  const fn = /^(async\b|function\b|\()/.test(trimmed) ? trimmed : 'async () => {\n' + code + '\n}'
  return [
    'const __logs = []',
    'const __text = (args) => args.map((a) => { if (typeof a === "string") return a; try { return JSON.stringify(a) } catch { return String(a) } }).join(" ")',
    'const console = Object.fromEntries(["log", "info", "warn", "error", "debug"].map((level) => [level, (...args) => void __logs.push(level === "log" ? __text(args) : level + ": " + __text(args))]))',
    'export default {',
    '  async fetch(request, env) {',
    '    const board = await env.BOARD.board()',
    '    try {',
    '      const result = await (' + fn + '\n)()',
    '      return Response.json({ result: result === undefined ? null : JSON.parse(JSON.stringify(result)), logs: __logs })',
    '    } catch (error) {',
    '      return Response.json({ error: String(error && error.message ? error.message : error), logs: __logs })',
    '    }',
    '  },',
    '}',
  ].join('\n')
}

type Exported = { BoardSession?: (options: { props: unknown }) => Fetcher }

/** Runs the model's code in a Dynamic Worker whose only capability is this caller's Board, sealed. */
async function runCode(ctx: Ctx, code: unknown): Promise<{ result: unknown; logs: string[] } | { error: string; logs?: string[] }> {
  if (typeof code !== 'string' || code.trim() === '') return { error: 'code: pass an async arrow function, like async () => { ... }' }
  if (code.length > CODE_MAX) return { error: 'code: at most ' + CODE_MAX + ' characters' }
  if (!ctx.env.LOADER) return { error: 'run_code: this deployment has no worker_loaders binding named LOADER' }
  const session = (exports as unknown as Exported).BoardSession
  if (typeof session !== 'function') return { error: "run_code: this Worker's main module doesn't export BoardSession" }
  const props = await sessionProps(ctx.env, ctx.mount, { ...ctx.caller, via: 'code' }, ctx.region)
  let worker: WorkerStub
  try {
    worker = ctx.env.LOADER.load({
      compatibilityDate: COMPATIBILITY_DATE,
      mainModule: 'run.js',
      modules: { 'run.js': sandboxModule(code) },
      env: { BOARD: session({ props }) },
      globalOutbound: null,
    })
  } catch (error) {
    return { error: 'the code did not load: ' + ((error as Error)?.message ?? String(error)) }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('the code ran longer than ' + CODE_TIMEOUT_MS / 1000 + 's')), CODE_TIMEOUT_MS)))
  try {
    const response = await Promise.race([worker.getEntrypoint().fetch('https://sandbox/run'), timeout])
    return (await response.json()) as { result: unknown; logs: string[] } | { error: string; logs: string[] }
  } catch (error) {
    return { error: (error as Error)?.message ?? String(error) }
  } finally {
    clearTimeout(timer)
  }
}

/** One JSON-RPC message: its response, or null for a notification. */
async function answer(ctx: Ctx, message: Rpc): Promise<Record<string, unknown> | null> {
  const id = message.id
  const isRequest = id !== undefined && id !== null
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result })
  const fail = (code: number, text: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message: text } })
  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') return isRequest || id === undefined ? fail(-32600, 'not a JSON-RPC 2.0 request') : null
  if (!isRequest) return null
  const params = (message.params ?? {}) as Record<string, unknown>
  switch (message.method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
      return ok({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'boards', title: 'Boards: ' + ctx.mount.name, version: '0.1.0' },
        instructions: 'The board ' + ctx.mount.name + ', as ' + ctx.caller.principal.handle + '. board_read, board_post, board_reply, and board_search do one thing each; run_code runs a script of many board calls at once.',
      })
    }
    case 'ping':
      return ok({})
    case 'tools/list':
      return ok({ tools: TOOLS })
    case 'tools/call': {
      const name = params.name
      const args = (params.arguments ?? {}) as Record<string, unknown>
      if (typeof name !== 'string' || typeof args !== 'object' || args === null || Array.isArray(args)) return fail(-32602, 'tools/call takes { name, arguments }')
      const result = await callTool(ctx, name, args)
      return result ? ok(result) : fail(-32602, 'no tool named ' + name)
    }
    default:
      return fail(-32601, 'method not found: ' + message.method)
  }
}

GATEWAY.mcpStream = async () => new Response(null, { status: 405, headers: { allow: 'POST' } })

GATEWAY.mcp = async (request, env, { mount, caller }) => {
  if (!caller) return failureResponse({ status: 401, code: 'unauthorized', message: 'missing bearer token' })
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'the body is not JSON' } }, { status: 400 })
  }
  const region = regionOf(request)
  const mcpCaller: Caller = { ...caller, via: 'mcp' }
  const ctx: Ctx = { env: env as McpEnv, mount, caller: mcpCaller, region, board: boardFor(env, mount, mcpCaller, region) }
  const messages = Array.isArray(body) ? (body as Rpc[]) : [body as Rpc]
  const answers = (await Promise.all(messages.map((message) => answer(ctx, (message ?? {}) as Rpc)))).filter((entry) => entry !== null)
  if (answers.length === 0) return new Response(null, { status: 202 })
  return Response.json(Array.isArray(body) ? answers : answers[0])
}
