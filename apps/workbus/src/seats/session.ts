// A Session: one seat working one thread (design/workbus.md §5.2). A top-level Durable Object named
// "<seat>:<thread>" (not a sub-agent: a facet can't set alarms, and Pi's wake needs one), hosting one
// PiHarness; its computer tools work in the seat's own SeatWorkspace (seats/workspace.ts), shared by
// every thread the seat works. The Seat routes wake-ups here
// through the seam (harness/pi.ts's PiHarnessAdapter); this object holds no secret, and its board
// tools hold only the seat's narrowed Board.
import { createRegistry, Harness, type ToolRegistration } from '@earendil-works/pi-durable'
import { createModels } from '@earendil-works/pi-ai/models'
import { Agent } from 'agents'
import { PiHarness } from 'agents/harness/pi'
import { createAI } from 'agents/models/pi-ai'

import { BOARD } from '../board.ts'
import { boardTools, seatBoard } from '../harness/board.ts'
import type { PiTool } from '@cloudflare/computer/tools/pi-ai'

import { computerTools, type WorkspaceStub } from '../harness/computer.ts'
import { INSTANCE, SLEEP_MS, SessionSandbox, sandboxTools, type Listed, type WorkspaceSync } from '../harness/sandbox.ts'
import { webTools } from '../harness/web.ts'
import { Approval, compile, gate, gatewayLog, meter, systemPrompt, type Hold } from '../harness/pi.ts'
import type { Outcome, Receipt, SeatRef, SessionEvent, SubmitOptions, Tool, ToolAnswer, TranscriptMessage, Turn, Usage } from '../harness/types.ts'

/**
 * A container's billable time in one operation: from its first sandbox call to the operation's end,
 * and for a container the operation started, the idle minutes before it sleeps (the most it runs
 * unused). An estimate: the platform doesn't report a container's active time per session.
 */
function containerMs(boxes: { started: number; ms: number; at: number }[], end: number): number {
  const first = Math.min(...boxes.map((box) => box.at - box.ms))
  return Math.max(0, end - first) + boxes.filter((box) => box.started).length * SLEEP_MS
}

/** The egress entrypoint (scout's, src/egress/): every request a sandbox makes goes through it. */
const EGRESS = 'Egress'

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
  readonly registry = createRegistry()
  readonly harness = new PiHarness({
    // pi opens when the object starts, maybe before configure(): the seat's parts install once it has one.
    harness: async ({ storage, context, onWake }) => {
      await this.#prepare()
      this.#install()
      this.#models.setProvider(this.#ai(this.#configured()).provider)
      const session = this
      return Harness.open(
        storage,
        {
          models: this.#models,
          registry: this.registry,
          onWake,
          // Read at every request: the running operation's task joins { seat, team, thread } in the gateway's metadata.
          settings: {
            get stream() {
              return session.#task ? { metadata: { task: session.#task } } : {}
            },
          } as any,
          onReport: (report) => console.warn('pi report', JSON.stringify(report)),
        },
        context,
      )
    },
    // pi stores only the model's provider and id with the session; the factory's Models resolve it.
    defaults: { model: createAI({ binding: this.env.AI }).model(MODEL), maxTurns: MAX_TURNS },
  })
  #listeners = new Set<(event: SessionEvent) => void>()
  #models = createModels()
  /** The board task of the operation whose request is being built (set in beforeRequest). */
  #task: string | null = null
  /** The principal's request the running operation belongs to: the org.request its board writes carry (set in beforeRequest and at submit). */
  #request: string | null = null

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.lifecycle.use(this.harness)
    this.sql`CREATE TABLE IF NOT EXISTS wb_seat (k TEXT PRIMARY KEY, seat TEXT NOT NULL)`
    this.sql`CREATE TABLE IF NOT EXISTS wb_ops (id TEXT PRIMARY KEY, kind TEXT NOT NULL, resumes TEXT, task TEXT, started INTEGER NOT NULL, ended INTEGER, request TEXT)`
    // Operations kept before requests were stamped gain their column.
    if (!this.sql<{ name: string }>`PRAGMA table_info(wb_ops)`.some((column) => column.name === 'request')) this.sql`ALTER TABLE wb_ops ADD COLUMN request TEXT`
    this.sql`CREATE TABLE IF NOT EXISTS wb_responses (id INTEGER PRIMARY KEY AUTOINCREMENT, op TEXT, model TEXT, input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER, cost REAL, log TEXT, at INTEGER NOT NULL)`
    this.sql`CREATE TABLE IF NOT EXISTS wb_tools (call TEXT PRIMARY KEY, op TEXT, name TEXT NOT NULL, started INTEGER, ended INTEGER, ok INTEGER)`
    this.sql`CREATE TABLE IF NOT EXISTS wb_sandbox_files (path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime INTEGER NOT NULL)`
    this.sql`CREATE TABLE IF NOT EXISTS wb_sandbox (id INTEGER PRIMARY KEY AUTOINCREMENT, op TEXT, started INTEGER NOT NULL, ms INTEGER NOT NULL, command_ms INTEGER NOT NULL, at INTEGER NOT NULL)`
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
    return createAI({ binding: this.env.AI, gateway: GATEWAY, byokAlias: BYOK_ALIAS, collectLog: true, metadata: { seat: seat?.key ?? key, team: seat?.team ?? null, thread: this.thread } })
  }

  #claimToken(): string {
    const made = newToken()
    this.sql`INSERT OR IGNORE INTO wb_seat (k, seat) VALUES ('claim', ${made})`
    return this.sql<{ seat: string }>`SELECT seat FROM wb_seat WHERE k = 'claim'`[0]!.seat
  }

  /** The seat's tools, by its tiers. */
  #tools(seat: SeatRef): Tool<any>[] {
    const tools: Tool<any>[] = []
    if (seat.tools.includes('board')) tools.push(
        ...boardTools(() => seatBoard(this.env.WORKBUS, BOARD, this.#seat()), {
          claimToken: () => this.#claimToken(),
          seat: () => this.#configured(),
          // What it makes carries the request its operation belongs to; where it may not label, its Seat labels it as the app.
          request: () => this.#request,
          stamp: (id, request) => (this.env.SEAT.getByName(this.#seat().key) as unknown as { stamp(id: string, request: string): Promise<void> }).stamp(id, request),
          // A reviews edge (§4.5): the Seat makes the review tasks, as the app, before the work is complete.
          escalate: (task, reason, kind) => (this.env.SEAT.getByName(this.#seat().key) as unknown as { escalate(task: string, reason: string, kind?: string): Promise<unknown> }).escalate(task, reason, kind),
          beforeComplete: async (task) => {
            const now = this.#configured()
            if (now?.reviewed) await (this.env.SEAT.getByName(now.key) as unknown as { review(task: string): Promise<unknown> }).review(task)
          },
        }),
      )
    if (seat.tools.includes('computer') && this.#declared) tools.push(...computerTools(this.#declared, this.#workspace(seat)))
    if (seat.tools.includes('sandbox') && this.ctx.container)
      tools.push(
        ...sandboxTools(async (command, timeoutS) => {
          const result = await this.#sandbox().run(command, timeoutS)
          const op = await this.#running()
          this.sql`INSERT INTO wb_sandbox (op, started, ms, command_ms, at) VALUES (${op}, ${result.started ? 1 : 0}, ${result.ms}, ${result.commandMs}, ${Date.now()})`
          return result
        }),
      )
    if (seat.tools.includes('web')) tools.push(...webTools({ seat: seat.key, egress: this.ctx.exports.Egress({ props: { seat: seat.key, mode: 'web' } }), ai: this.env.AI, browser: this.env.BROWSER as never, gateway: GATEWAY }))
    return tools
  }

  /**
   * The seat is let go (§5.7): whatever it runs is aborted, its container stopped, and this session's
   * storage (its transcript, its harness state) deleted. Its run records are its Seat's, and stay.
   */
  async retire(): Promise<void> {
    await this.harness.abort({}).catch(() => undefined)
    if (this.ctx.container?.running) await this.ctx.container.destroy().catch(() => undefined)
    await this.destroy()
  }

  /** Stops the session's container (a check's stand-in for sleeping): the next command starts one again. */
  async sandboxReset() {
    if (this.ctx.container?.running) await this.ctx.container.destroy()
  }

  /** One sandbox command as the tool runs it, for checks (vite dev's /dev/session door): its sync and its output. */
  async sandbox(command: string, timeoutS = 120) {
    return this.#sandbox().run(command, timeoutS)
  }

  /** The session's sandbox (harness/sandbox.ts): its container, through the egress, synced with the seat's workspace. */
  #box: SessionSandbox | null = null
  #sandbox(): SessionSandbox {
    if (this.#box) return this.#box
    const container = this.ctx.container
    if (!container) throw new Error('this deployment has no sandbox container')
    const seat = this.#seat()
    const exports = (this.ctx as unknown as { exports: Record<string, (options: { props: unknown }) => Fetcher> }).exports
    const manifest = {
      all: () => new Map(this.sql<Listed>`SELECT path, size, mtime FROM wb_sandbox_files`.map((row) => [row.path, row]) as [string, Listed][]),
      set: (files: Listed[]) => {
        for (const file of files) this.sql`INSERT OR REPLACE INTO wb_sandbox_files (path, size, mtime) VALUES (${file.path}, ${file.size}, ${file.mtime})`
      },
      remove: (paths: string[]) => {
        for (const path of paths) this.sql`DELETE FROM wb_sandbox_files WHERE path = ${path}`
      },
      clear: () => void this.sql`DELETE FROM wb_sandbox_files`,
    }
    this.#box = new SessionSandbox(
      container,
      // Every request it makes is the egress's to decide, and to log, as this seat and thread.
      () => exports[EGRESS]!({ props: { seat: seat.key, mode: 'sandbox', thread: this.thread } }),
      () => this.env.WORKSPACE.getByName(seat.key) as unknown as WorkspaceSync,
      manifest,
      { seat: seat.key, thread: this.thread },
    )
    return this.#box
  }

  #byName = new Map<string, Tool<unknown>>()

  /** Installs (or replaces, in place) the seat's extension: its prompt, its tools, the gate, and the meter. */
  /** The seat's workspace: one per seat key, whatever the thread. */
  #workspace(seat: SeatRef): WorkspaceStub {
    return this.env.WORKSPACE.getByName(seat.key) as unknown as WorkspaceStub
  }

  /** The computer tools' declarations, read once from the seat's workspace. */
  #declared: PiTool[] | null = null
  async #prepare() {
    const seat = this.#configured()
    if (!this.#declared && seat?.tools.includes('computer')) this.#declared = await this.#workspace(seat).declare()
  }

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
          request: async () => {
            const op = await this.#running()
            const row = op ? this.sql<{ task: string | null; request: string | null }>`SELECT task, request FROM wb_ops WHERE id = ${op}`[0] : undefined
            this.#task = row?.task ?? null
            this.#request = row?.request ?? null
          },
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
    // Held in the seat's own DM (owners and the seat), never in the thread's channel: that may be a queue a
    // seat serves, where the task would be ready for a moment between the answer and its close (#19).
    const made = (await board.tasks.create({ channel: 'dm/' + seat.key, text, id: 'approval-' + call.id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48), ...(this.#request ? { labels: { 'org.request': this.#request } } : {}) })) as { task: { id: string } }
    await board.tasks.block(made.task.id, 'Approve or deny ' + call.name + ' for @' + seat.handle, kind)
    const op = await this.#running()
    this.sql`INSERT OR IGNORE INTO wb_approvals (id, call, pi_task, op, tool, kind, args, state, at) VALUES (${made.task.id}, ${call.id}, ${piTask}, ${op}, ${call.name}, ${kind}, ${args}, 'held', ${Date.now()})`
    this.#emit({ type: 'approval', approvalId: made.task.id, tool: call.name, state: 'held' })
    // The hold is the seat's own write, so its subscription never delivers it: tell the Seat which thread waits on it.
    const seats = (this.env as unknown as { SEAT?: DurableObjectNamespace }).SEAT
    if (seats) await (seats.getByName(seat.key) as unknown as { held(input: { approvalId: string; thread: string; operationId: string | null }): Promise<void> }).held({ approvalId: made.task.id, thread: this.thread, operationId: op })
  }

  #emit(event: SessionEvent) {
    for (const listener of this.#listeners) listener(event)
  }

  // The RPC face (harness/pi.ts's SessionStub).

  /**
   * The request an operation belongs to (harness/types.ts RequestHint): the one its wake-up carries; a
   * person's message starts one, unless it's a reply in a thread this session already works for one;
   * none for a schedule; and without a hint, the thread's. The thread keeps the first it gets.
   */
  #requestFor(hint: SubmitOptions['request']): string | null {
    const thread = this.sql<{ seat: string }>`SELECT seat FROM wb_seat WHERE k = 'request'`[0]?.seat ?? null
    if (hint === null) return null
    const request = hint === undefined ? thread : hint.via === 'person' && hint.reply && thread ? thread : hint.id
    if (request && !thread) this.sql`INSERT OR IGNORE INTO wb_seat (k, seat) VALUES ('request', ${request})`
    return request
  }

  /** The seat this session works for; a new revision reinstalls its prompt and tools. */
  async configure(seat: SeatRef): Promise<void> {
    const before = this.sql<{ seat: string }>`SELECT seat FROM wb_seat WHERE k = 'seat'`[0]
    if (before && JSON.parse(before.seat).revision === seat.revision) return
    this.sql`INSERT OR REPLACE INTO wb_seat (k, seat) VALUES ('seat', ${JSON.stringify(seat)})`
    this.#models.setProvider(this.#ai(seat).provider)
    await this.#prepare()
    this.#install()
  }

  /** A wake-up, or the principal's answer to a held call. A repeated operationId runs once. */
  async submit(input: Turn | ToolAnswer, options: SubmitOptions): Promise<Receipt> {
    if (input.type === 'approval') return this.#answer(input, options)
    const text = input.parts.map((part) => part.text).join('\n')
    // pi reads its settings (the gateway's task metadata) before the beforeRequest hook runs, so set it here for the first request too.
    if (options.task && (await this.harness.pending()).length === 0) this.#task = options.task
    const request = this.#requestFor(options.request)
    if (request && (await this.harness.pending()).length === 0) this.#request = request
    const receipt = await this.harness.submit(text, { operationId: options.operationId, whenBusy: options.whenBusy ?? 'followUp', onAbort: 'keep' })
    if (receipt.accepted) {
      this.sql`INSERT OR IGNORE INTO wb_ops (id, kind, task, started, request) VALUES (${options.operationId}, 'turn', ${options.task ?? null}, ${Date.now()}, ${request})`
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
    const boxes = !measured ? [] : this.sql<{ started: number; ms: number; command_ms: number; at: number }>`SELECT started, ms, command_ms, at FROM wb_sandbox WHERE op = ${operationId}`
    const sum = (key: 'input' | 'output' | 'cache_read' | 'cache_write' | 'cost') => responses.reduce((total, r) => total + (r[key] ?? 0), 0)
    const now = Date.now()
    return {
      model: responses.at(-1)?.model ?? null,
      steps: responses.length,
      tokens: { input: sum('input'), output: sum('output'), cacheRead: sum('cache_read'), cacheWrite: sum('cache_write') },
      cost: sum('cost'),
      tools: [
        ...tools.map((t) => ({ name: t.name, ms: t.started !== null && t.ended !== null ? t.ended - t.started : 0, ok: t.ok === 1 })),
        // The container's time in this operation, for its cost (runs_v1 has no column of its own: summed ms × the basic rate).
        ...(boxes.length ? [{ name: 'sandbox:' + INSTANCE, ms: containerMs(boxes, op?.ended ?? now), ok: true }] : []),
      ],
      logs: responses.flatMap((r) => (r.log ? [r.log] : [])),
      started: iso(op?.started ?? now)!,
      ended: iso(op?.ended ?? null),
      ...(boxes.length ? { sandbox: { instance: INSTANCE, calls: boxes.length, starts: boxes.filter((box) => box.started).length, ms: boxes.reduce((total, box) => total + box.ms, 0), commandMs: boxes.reduce((total, box) => total + box.command_ms, 0) } } : {}),
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
      files: this.#configured()?.tools.includes('computer') ? await (this.#workspace(this.#seat()) as unknown as { files(): Promise<unknown[]> }).files() : [],
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
