// A Session: one seat working one thread (design/workbus.md §5.2). A top-level Durable Object named
// "<seat>:<thread>" (not a sub-agent: a facet can't set alarms, and Pi's wake needs one), hosting one
// PiHarness and, in the same SQLite, the seat's computer Workspace. The Seat routes wake-ups here
// through the seam (harness/pi.ts's PiHarnessAdapter); this object holds no secret, and its board
// tools hold only the seat's narrowed Board.
import { createRegistry, Harness, type ToolRegistration } from '@earendil-works/pi-durable'
import { createModels } from '@earendil-works/pi-ai/models'
import { Agent } from 'agents'
import { PiHarness } from 'agents/harness/pi'
import { createAI } from 'agents/models/pi-ai'

import { BOARD } from '../board.ts'
import { boardTools, seatBoard } from '../harness/board.ts'
import { computerTools, workspace } from '../harness/computer.ts'
import { Approval, compile, gate, gatewayLog, meter, systemPrompt, type Hold } from '../harness/pi.ts'
import type { Outcome, Receipt, SeatRef, SessionEvent, SubmitOptions, Tool, ToolAnswer, TranscriptMessage, Turn, Usage } from '../harness/types.ts'

/** Every seat runs Haiku during development (§5.6), through the org's gateway, on its BYOK key. */
export const MODEL = 'anthropic/claude-haiku-5.5'
export const GATEWAY = 'workbus'
export const BYOK_ALIAS = 'workbus-anthropic'

/** Most tool rounds one wake-up may take before it ends unanswered (turn_limit). */
const MAX_TURNS = 24

/** A claim token: 32 random bytes in base64url, the shape the board takes. */
function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString())

export class Session extends Agent<Env> {
  readonly space = workspace(this.ctx.storage, this.env.LOADER)
  readonly registry = createRegistry()
  readonly harness = new PiHarness({
    // pi opens when the object starts, maybe before configure(): the seat's parts install once it has one.
    harness: async ({ storage, context, onWake }) => {
      this.#install()
      this.#models.setProvider(this.#ai(this.#configured()).provider)
      return Harness.open(storage, { models: this.#models, registry: this.registry, onWake, onReport: (report) => console.warn('pi report', JSON.stringify(report)) }, context)
    },
    // pi stores only the model's provider and id with the session; the factory's Models resolve it.
    defaults: { model: createAI({ binding: this.env.AI }).model(MODEL), maxTurns: MAX_TURNS },
  })
  #listeners = new Set<(event: SessionEvent) => void>()
  #models = createModels()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.lifecycle.use(this.harness)
    this.sql`CREATE TABLE IF NOT EXISTS wb_seat (k TEXT PRIMARY KEY, seat TEXT NOT NULL)`
    this.sql`CREATE TABLE IF NOT EXISTS wb_ops (id TEXT PRIMARY KEY, kind TEXT NOT NULL, resumes TEXT, started INTEGER NOT NULL, ended INTEGER)`
    this.sql`CREATE TABLE IF NOT EXISTS wb_responses (id INTEGER PRIMARY KEY AUTOINCREMENT, op TEXT, model TEXT, input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER, cost REAL, log TEXT, at INTEGER NOT NULL)`
    this.sql`CREATE TABLE IF NOT EXISTS wb_tools (call TEXT PRIMARY KEY, op TEXT, name TEXT NOT NULL, started INTEGER, ended INTEGER, ok INTEGER)`
    this.sql`CREATE TABLE IF NOT EXISTS wb_approvals (id TEXT PRIMARY KEY, call TEXT NOT NULL UNIQUE, pi_task TEXT NOT NULL, op TEXT, tool TEXT NOT NULL, kind TEXT NOT NULL, args TEXT NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL)`
  }

  /** The seat and thread, from this object's name. */
  get thread(): string {
    return this.name.slice(this.name.indexOf(':') + 1)
  }

  #configured(): SeatRef | null {
    const row = this.sql<{ seat: string }>`SELECT seat FROM wb_seat WHERE k = 'seat'`[0]
    return row ? (JSON.parse(row.seat) as SeatRef) : null
  }

  #seat(): SeatRef {
    const seat = this.#configured()
    if (!seat) throw new Error('session ' + this.name + ' has no seat: configure() it first')
    return seat
  }

  /** The gateway's metadata on every call (§5.6): the seat, its team, and this thread. */
  #ai(seat: SeatRef | null) {
    const key = this.name.slice(0, this.name.indexOf(':'))
    return createAI({ binding: this.env.AI, gateway: GATEWAY, byokAlias: BYOK_ALIAS, metadata: { seat: seat?.key ?? key, team: seat?.team ?? null, thread: this.thread } })
  }

  #claimToken(): string {
    const made = newToken()
    this.sql`INSERT OR IGNORE INTO wb_seat (k, seat) VALUES ('claim', ${made})`
    return this.sql<{ seat: string }>`SELECT seat FROM wb_seat WHERE k = 'claim'`[0]!.seat
  }

  /** The seat's tools, by its tiers. */
  #tools(seat: SeatRef): Tool<any>[] {
    const tools: Tool<any>[] = []
    if (seat.tools.includes('board')) tools.push(...boardTools(() => seatBoard(this.env.WORKBUS, BOARD, this.#seat()), () => this.#claimToken()))
    if (seat.tools.includes('computer')) tools.push(...computerTools(this.space))
    return tools
  }

  #byName = new Map<string, Tool<unknown>>()

  /** Installs (or replaces, in place) the seat's extension: its prompt, its tools, the gate, and the meter. */
  #install() {
    const seat = this.#configured()
    const tools = seat ? this.#tools(seat) : []
    this.#byName = new Map(tools.map((tool) => [tool.name, tool]))
    const registrations: ToolRegistration[] = tools.map((tool) => compile(tool, (callId, signal) => ({ seat: this.#seat(), thread: this.thread, callId, signal })))
    this.registry.install({
      name: 'workbus.seat',
      sections: [{ key: 'seat', tag: false, render: () => {
        const seat = this.#configured()
        return seat ? systemPrompt(seat, this.thread) : undefined
      } }],
      tools: registrations,
      hooks: [
        gate(() => this.#byName, () => this.#seat(), this.#hold),
        ...meter({
          response: async (message) => {
            const u = message.usage ?? {}
            const op = await this.#running()
            this.sql`INSERT INTO wb_responses (op, model, input, output, cache_read, cache_write, cost, log, at) VALUES (${op}, ${message.model ?? null}, ${u.input ?? 0}, ${u.output ?? 0}, ${u.cacheRead ?? 0}, ${u.cacheWrite ?? 0}, ${u.cost?.total ?? 0}, ${gatewayLog(message)}, ${Date.now()})`
          },
          tool: async (call, name, phase, ok) => {
            const op = await this.#running()
            const now = Date.now()
            if (phase === 'start') this.sql`INSERT OR IGNORE INTO wb_tools (call, op, name, started) VALUES (${call}, ${op}, ${name}, ${now})`
            else {
              this.sql`INSERT OR IGNORE INTO wb_tools (call, op, name) VALUES (${call}, ${op}, ${name})`
              this.sql`UPDATE wb_tools SET ended = ${now}, ok = ${ok ? 1 : 0} WHERE call = ${call} AND ended IS NULL`
            }
          },
        }),
      ],
    })
  }

  /** The operation a run is answering now: the oldest one pi has running. */
  async #running(): Promise<string | null> {
    const pending = await this.harness.pending()
    return pending.find((p) => p.status === 'running')?.operationId ?? null
  }

  /** Holds a task for the principal for one call, once: kind is the hold's kind (§6.2). */
  #hold: Hold = async (call, piTask, kind) => {
    if (this.sql`SELECT 1 FROM wb_approvals WHERE call = ${call.id}`.length > 0) return
    const seat = this.#seat()
    const board = seatBoard(this.env.WORKBUS, BOARD, seat)
    const thread = (await board.read(this.thread, { limit: 1 })) as { message: { id: string; channel: string } }
    const args = JSON.stringify(call.arguments ?? {}, null, 1)
    const text = '@' + seat.handle + ' asks to run ' + call.name + ' in #' + thread.message.id + ':\n\n```json\n' + args.slice(0, 4000) + '\n```'
    const made = (await board.tasks.create({ channel: thread.message.channel, text, id: 'approval-' + call.id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48) })) as { task: { id: string } }
    await board.tasks.block(made.task.id, 'Approve or deny ' + call.name + ' for @' + seat.handle, kind)
    const op = await this.#running()
    this.sql`INSERT OR IGNORE INTO wb_approvals (id, call, pi_task, op, tool, kind, args, state, at) VALUES (${made.task.id}, ${call.id}, ${piTask}, ${op}, ${call.name}, ${kind}, ${args}, 'held', ${Date.now()})`
    this.#emit({ type: 'approval', approvalId: made.task.id, tool: call.name, state: 'held' })
  }

  #emit(event: SessionEvent) {
    for (const listener of this.#listeners) listener(event)
  }

  // The RPC face (harness/pi.ts's SessionStub).

  /** The seat this session works for; a new revision reinstalls its prompt and tools. */
  async configure(seat: SeatRef): Promise<void> {
    const before = this.sql<{ seat: string }>`SELECT seat FROM wb_seat WHERE k = 'seat'`[0]
    if (before && JSON.parse(before.seat).revision === seat.revision) return
    this.sql`INSERT OR REPLACE INTO wb_seat (k, seat) VALUES ('seat', ${JSON.stringify(seat)})`
    this.#models.setProvider(this.#ai(seat).provider)
    this.#install()
  }

  /** A wake-up, or the principal's answer to a held call. A repeated operationId runs once. */
  async submit(input: Turn | ToolAnswer, options: SubmitOptions): Promise<Receipt> {
    if (input.type === 'approval') return this.#answer(input, options)
    const text = input.parts.map((part) => part.text).join('\n')
    const receipt = await this.harness.submit(text, { operationId: options.operationId, whenBusy: options.whenBusy ?? 'followUp', onAbort: 'keep' })
    if (receipt.accepted) {
      this.sql`INSERT OR IGNORE INTO wb_ops (id, kind, started) VALUES (${options.operationId}, 'turn', ${Date.now()})`
      this.#emit({ type: 'operation', status: { operationId: options.operationId, status: 'queued' } })
      this.ctx.waitUntil(this.wait(options.operationId).catch(() => undefined))
    }
    return { operationId: receipt.operationId, session: this.name, accepted: receipt.accepted }
  }

  async #answer(answer: ToolAnswer, options: SubmitOptions): Promise<Receipt> {
    const held = this.sql<{ call: string; pi_task: string; op: string | null; tool: string }>`SELECT call, pi_task, op, tool FROM wb_approvals WHERE id = ${answer.approvalId}`[0]
    if (!held) throw new Error('no call in ' + this.name + ' waits for approval ' + answer.approvalId)
    const result = await this.harness.signal(held.pi_task as any, Approval, held.call, { approved: answer.approved, reason: answer.reason ?? '' })
    const accepted = result === 'delivered'
    if (accepted) {
      this.sql`UPDATE wb_approvals SET state = ${answer.approved ? 'approved' : 'denied'} WHERE id = ${answer.approvalId}`
      this.sql`INSERT OR IGNORE INTO wb_ops (id, kind, resumes, started) VALUES (${options.operationId}, 'approval', ${held.op}, ${Date.now()})`
      this.#emit({ type: 'approval', approvalId: answer.approvalId, tool: held.tool, state: answer.approved ? 'approved' : 'denied' })
    }
    return { operationId: options.operationId, session: this.name, accepted }
  }

  /**
   * How an operation ended, with what it cost. An approval's answer ends when the operation it
   * resumed does, and names it in resumes: that operation's usage is the run's, so the answer's is empty.
   */
  async wait(operationId: string, timeoutMs = 600_000): Promise<Outcome & { resumes?: string }> {
    const op = this.sql<{ kind: string; resumes: string | null }>`SELECT kind, resumes FROM wb_ops WHERE id = ${operationId}`[0]
    const target = op?.kind === 'approval' && op.resumes ? op.resumes : operationId
    const result = await this.harness.wait(target, { signal: AbortSignal.timeout(timeoutMs) })
    this.sql`UPDATE wb_ops SET ended = ${Date.now()} WHERE id = ${operationId} AND ended IS NULL`
    if (target !== operationId) this.sql`UPDATE wb_ops SET ended = ${Date.now()} WHERE id = ${target} AND ended IS NULL`
    this.#emit({ type: 'operation', status: { operationId, status: result.status, ...(result.reason ? { reason: result.reason } : {}) } })
    return {
      operationId,
      session: this.name,
      status: result.status,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.text ? { text: result.text } : {}),
      usage: this.usage(operationId, target === operationId),
      ...(target !== operationId ? { resumes: target } : {}),
    }
  }

  /** One operation's usage, for its run record; an approval's answer measures nothing of its own. */
  usage(operationId: string, measured = true): Usage {
    const op = this.sql<{ started: number; ended: number | null }>`SELECT started, ended FROM wb_ops WHERE id = ${operationId}`[0]
    const responses = !measured ? [] : this.sql<{ model: string | null; input: number; output: number; cache_read: number; cache_write: number; cost: number; log: string | null }>`SELECT model, input, output, cache_read, cache_write, cost, log FROM wb_responses WHERE op = ${operationId} ORDER BY id`
    const tools = !measured ? [] : this.sql<{ name: string; started: number | null; ended: number | null; ok: number | null }>`SELECT name, started, ended, ok FROM wb_tools WHERE op = ${operationId} ORDER BY started`
    const sum = (key: 'input' | 'output' | 'cache_read' | 'cache_write' | 'cost') => responses.reduce((total, r) => total + (r[key] ?? 0), 0)
    const now = Date.now()
    return {
      model: responses.at(-1)?.model ?? null,
      steps: responses.length,
      tokens: { input: sum('input'), output: sum('output'), cacheRead: sum('cache_read'), cacheWrite: sum('cache_write') },
      cost: sum('cost'),
      tools: tools.map((t) => ({ name: t.name, ms: t.started !== null && t.ended !== null ? t.ended - t.started : 0, ok: t.ok === 1 })),
      logs: responses.flatMap((r) => (r.log ? [r.log] : [])),
      started: iso(op?.started ?? now)!,
      ended: iso(op?.ended ?? null),
    }
  }

  /** Withdraws one queued operation (or aborts the run it joined), or, without one, everything. */
  async abort(operationId?: string): Promise<void> {
    await this.harness.abort(operationId ? { operationId } : {})
  }

  /** The transcript so far, then every change, as NDJSON SessionEvents. */
  async watch(): Promise<ReadableStream<Uint8Array>> {
    const encoder = new TextEncoder()
    const seen = new Set<string>()
    const listeners = this.#listeners
    const view = await this.harness.session().watch()
    let send: ((event: SessionEvent) => void) | undefined
    return new ReadableStream<Uint8Array>({
      start(controller) {
        send = (event) => controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'))
        const entries = (value: { entries: readonly unknown[] }) => {
          for (const entry of value.entries) for (const message of transcript(entry)) if (!seen.has(message.id)) (seen.add(message.id), send!({ type: 'message', message }))
        }
        entries(view.value)
        listeners.add(send)
        view.start(async (call) => {
          if (call.kind === 'value') entries(call.value)
        })
      },
      async cancel() {
        if (send) listeners.delete(send)
        await view.stop()
      },
    })
  }

  /** What this session holds, for the Seat's views and for checks: its seat, operations, approvals, and files. */
  async inspect() {
    return {
      name: this.name,
      seat: this.sql<{ seat: string }>`SELECT seat FROM wb_seat WHERE k = 'seat'`.map((r) => JSON.parse(r.seat).key)[0] ?? null,
      pending: await this.harness.pending(),
      operations: this.sql`SELECT id, kind, resumes, started, ended FROM wb_ops ORDER BY started`,
      approvals: this.sql`SELECT id, call, tool, kind, state, op FROM wb_approvals ORDER BY at`,
      files: await this.space.fs.readdir('/workspace').catch(() => []),
    }
  }
}

/** Pi's transcript entries as the seam's messages. */
function transcript(entry: any): TranscriptMessage[] {
  const out: TranscriptMessage[] = []
  const id = String(entry?.id ?? '')
  for (const [index, message] of (Array.isArray(entry?.model) ? entry.model : []).entries()) {
    const key = id + '.' + index
    const parts: any[] = Array.isArray(message?.content) ? message.content : typeof message?.content === 'string' ? [{ type: 'text', text: message.content }] : []
    const text = parts.filter((p) => p?.type === 'text').map((p) => p.text).join('')
    if (message?.role === 'user') out.push({ id: key, role: 'user', text })
    else if (message?.role === 'assistant') {
      if (text) out.push({ id: key, role: 'assistant', text })
      for (const call of parts.filter((p) => p?.type === 'toolCall')) out.push({ id: key + '.' + call.id, role: 'tool', text: JSON.stringify(call.arguments ?? {}), tool: { name: call.name, call: call.id } })
    } else if (message?.role === 'toolResult') out.push({ id: key, role: 'tool', text, tool: { name: message.toolName, call: message.toolCallId, ok: message.isError !== true } })
  }
  return out
}
