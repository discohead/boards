// The board tier (§5.4): the seat's narrowed Board, as tools. The Board is the only thing a board
// tool holds: env.WORKBUS.board('bus').as(seat's profile).narrow(seat's can), so every write is the
// seat's actor, and a narrowing can only shrink what workbus-app may do.
import { z } from 'zod'

import type { SeatRef, Tool, ToolResult } from './types.ts'

/** The Board's methods the tools use, typed by hand (the binding's own types bring in the framework). */
export type SeatBoard = {
  post(channel: string, input: string | Record<string, unknown>): Promise<unknown>
  reply(id: string, input: string | Record<string, unknown>): Promise<unknown>
  read(id: string, range?: { after?: string; limit?: number }): Promise<unknown>
  messages(channel: string, range?: { after?: string; limit?: number }): Promise<unknown>
  threads(query?: Record<string, unknown>): Promise<unknown>
  follow(id: string, opts?: { on?: boolean }): Promise<unknown>
  follows(query?: { limit?: number }): Promise<unknown>
  actors(query?: { hidden?: boolean }): Promise<unknown>
  tasks: {
    list(query?: Record<string, unknown>): Promise<unknown>
    create(input: Record<string, unknown>): Promise<{ task: unknown }>
    createMany(channel: string, tasks: unknown[], opts?: { id?: string }): Promise<unknown>
    claim(target: { id: string }, opts?: { lease?: number; token?: string }): Promise<{ complete(result?: string): Promise<unknown>; block(reason: string, kind?: string): Promise<unknown>; fail(reason: string): Promise<unknown>; task: unknown }>
    block(id: string, reason: string, kind?: string): Promise<unknown>
    approve(id: string, note?: string): Promise<unknown>
    decline(id: string, note?: string): Promise<unknown>
    assign(id: string, to: string | null): Promise<unknown>
    reopen(id: string): Promise<unknown>
    cancel(id: string, reason: string): Promise<unknown>
  }
  label(id: string, change: { set?: Record<string, string>; unset?: string[] }): Promise<unknown>
  docs: {
    create(input: Record<string, unknown>): Promise<unknown>
    read(id: string, query?: { section?: string }): Promise<unknown>
    at(path: string, query?: { section?: string }): Promise<unknown>
    edit(id: string, input: Record<string, unknown>): Promise<unknown>
  }
}

type WorkbusBinding = { board(name: string): { as(profile: unknown): { narrow(can: unknown): SeatBoard } } }

/** The seat's Board: its own actor, narrowed to its seat doc's can. */
export function seatBoard(binding: unknown, board: string, seat: SeatRef): SeatBoard {
  const profile = { key: seat.key, name: seat.name, handle: seat.handle, ...(seat.avatar ? { avatar: seat.avatar } : {}) }
  return (binding as WorkbusBinding).board(board).as(profile).narrow(seat.can)
}

const json = (value: unknown): ToolResult => ({ text: JSON.stringify(value, null, 1) })

/** A board refusal is the model's to read and work around, not a crash. */
async function answer(run: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return json(await run())
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), isError: true }
  }
}

const Id = z.string().describe("a message's ID, as the board gives it")
const Channel = z.string().describe("a channel's path, like 'eng' or 'dm/op'")
const Text = z.string().min(1).describe('markdown; @handle mentions someone')

/** The labels a seat's edges write (org/rules.ts): a consult, and a hold escalated to a seat. */
const CONSULT = 'org.consult'
const ESCALATED = 'org.escalated'
const ANSWER = 'org.answer'
/** The handoff a task carries out: when every task with it is done, the watchdog says so in the handoff's thread (seats/watch.ts). */
export const HANDOFF = 'org.handoff'
/** A text without a leading mention of whom it's for: the tool adds that mention itself. */
const unmention = (text: string, to: { handle: string; actor: string }) => text.replace(/^\s*(?:@\[([^\]]+)\]|@([a-z0-9-]+))[:,]?\s*/, (all, actor, handle) => (actor === to.actor || handle === to.handle ? '' : all))
/** Where a consult goes when the session's thread is a DM, which the other seat can't read. */
const CONSULTS = 'ops/consults'

export type BoardToolsOptions = {
  /** The session's own claim token: a claim made with it is the session's to complete later, after the stub is gone. */
  claimToken: () => string
  /** The seat as configured now: whom it may assign, where its escalations go, whom it consults. */
  seat?: () => SeatRef | null
  /** Before a task is completed: the Seat makes its review tasks (a reviews edge), so work that needs it waits on them. */
  beforeComplete?: (task: string) => Promise<unknown>
  /** An escalation to a seat: held by the Seat as the app, so the seat it's for can answer it (a hold by a seat's claim is the principal's alone). */
  escalate?: (task: string, reason: string, kind?: string) => Promise<unknown>
  /** The principal's request the running operation belongs to: every message, task, doc, and proposal it makes carries it as org.request. */
  request?: () => string | null
  /** Labels a message with a request as the app, for what the seat makes where it may post but not label (a proposal in org/). */
  stamp?: (id: string, request: string) => Promise<unknown>
}

/** The label of the principal's request a seat's writes belong to (seats/seat.ts requestOf). */
export const REQUEST = 'org.request'

/** Every message or task ID in a write's answer: what it made, to label. */
function madeIds(value: unknown): string[] {
  const out = new Set<string>()
  const visit = (node: unknown, depth: number) => {
    if (!node || typeof node !== 'object' || depth > 3) return
    if (Array.isArray(node)) return node.forEach((one) => visit(one, depth + 1))
    const record = node as Record<string, unknown>
    if (typeof record.id === 'string' && /^\d+$/.test(record.id) && ('channel' in record || 'task' in record || 'state' in record)) out.add(record.id)
    for (const key of ['message', 'task', 'tasks', 'proposal', 'doc']) if (key in record) visit(record[key], depth + 1)
  }
  visit(value, 0)
  return [...out]
}

/** The board tools, over the seat's Board, shaped by its edges (§4.5). */
export function boardTools(board: () => SeatBoard, options: BoardToolsOptions): Tool<any>[] {
  const { claimToken } = options
  const seat = () => options.seat?.() ?? null
  // A seat that may assign only to some (the advisor, to the operator) is refused any other, before the board is asked.
  const refused = (fors: (string | undefined)[]): ToolResult | null => {
    const allowed = seat()?.assigns
    if (!allowed) return null
    const other = fors.find((to) => to === undefined || !allowed.includes(to))
    if (other === undefined && fors.every((to) => to !== undefined)) return null
    return { text: 'You may assign tasks only to ' + allowed.join(' or ') + ': set "for" to ' + (allowed.length === 1 ? 'it' : 'one of them') + ' on every task.', isError: true }
  }
  const claimed = (id: string) => board().tasks.claim({ id }, { token: claimToken() })
  const request = () => options.request?.() ?? null
  const stampOf = (): Record<string, string> => {
    const id = request()
    return id ? { [REQUEST]: id } : {}
  }
  /**
   * A write that carries the request's label. Where the seat may post but not label (org/), the board
   * refuses the label: it's made without, then labeled by the seat's Seat, as the app.
   */
  async function stamped<T>(write: (labels: Record<string, string>) => Promise<T>): Promise<T> {
    const labels = stampOf()
    if (!Object.keys(labels).length) return write({})
    try {
      return await write(labels)
    } catch (error) {
      if (!/label/i.test(String(error)) || !options.stamp) throw error
      const made = await write({})
      for (const id of madeIds(made)) await options.stamp(id, labels[REQUEST]!)
      return made
    }
  }
  /** Labels what a write made after it (a proposal's task, whose labels the write can't set), as the seat or else its Seat. */
  async function stampAfter(made: unknown): Promise<void> {
    const id = request()
    if (!id) return
    for (const one of madeIds(made)) await board().label(one, { set: { [REQUEST]: id } }).catch(() => options.stamp?.(one, id))
  }

  /** An open proposal for a path, by anyone: a new doc's (new:<path>) or an existing doc's (its ID). */
  const openProposal = async (channel: string, value: string): Promise<string | null> => {
    const { tasks } = (await board().tasks.list({ channel, state: 'open', label: 'board.doc.proposal=' + value, limit: 5 })) as { tasks: { message: { id: string } }[] }
    return tasks[0]?.message.id ?? null
  }
  /** An open hire proposal for a role (its seat block's "role"), by anyone. */
  const openHire = async (role: string): Promise<string | null> => {
    const { tasks } = (await board().tasks.list({ channel: 'org/seats', state: 'open', label: 'board.doc.proposal', limit: 50 })) as { tasks: { message: { id: string; text: string; labels: Record<string, string> } }[] }
    const hire = tasks.find(({ message }) => (message.labels['board.doc.proposal'] ?? '').startsWith('new:org/seats/') && message.text.includes('"role": "' + role + '"'))
    return hire?.message.id ?? null
  }
  const proposedAlready = (id: string, path: string) =>
    'an open proposal, #' + id + ', already asks for ' + path + ': reuse it (say what you would change in its thread), or wait for the principal to apply or drop it. A second proposal for the same path is refused.'

  /** Ends a handoff task (one assigned to this seat) with what it became. A handoff already done or not this seat's is left as it is. */
  const closeHandoff = async (id: string, result: string): Promise<string> => {
    try {
      await (await claimed(id)).complete(result)
      return 'completed'
    } catch (error) {
      return 'left open: ' + (error instanceof Error ? error.message : String(error))
    }
  }

  const tools: Tool<any>[] = [
    {
      name: 'board_post',
      description: 'Start a thread in a channel. Answers the message, with its ID.',
      input: z.object({ channel: Channel, text: Text }),
      replay: 'unsafe',
      approval: 'never',
      run: ({ channel, text }) => answer(() => stamped((labels) => board().post(channel, { text, labels }))),
    },
    {
      name: 'board_reply',
      description: 'Reply in the thread of a message.',
      input: z.object({ id: Id, text: Text }),
      replay: 'unsafe',
      approval: 'never',
      run: ({ id, text }) => answer(() => stamped((labels) => board().reply(id, { text, labels }))),
    },
    {
      name: 'board_read',
      description: 'Read a thread (its root and replies) from any message in it, or a channel\'s messages, oldest first.',
      input: z.object({ id: Id.optional(), channel: Channel.optional(), after: z.string().optional(), limit: z.number().int().min(1).max(100).optional() }),
      replay: 'safe',
      approval: 'never',
      run: ({ id, channel, after, limit }) =>
        answer(() => {
          const range = { ...(after ? { after } : {}), limit: limit ?? 50 }
          if (id) return board().read(id, range)
          if (channel) return board().messages(channel, range)
          throw new Error('pass id (a thread) or channel')
        }),
    },
    {
      name: 'board_search',
      description: 'Find threads, newest activity first, by text, channel, author, or mention.',
      input: z.object({ text: z.string().optional(), channel: z.string().optional(), by: z.string().optional(), mentions: z.string().optional(), limit: z.number().int().min(1).max(50).optional() }),
      replay: 'safe',
      approval: 'never',
      run: (query) => answer(() => board().threads({ ...query, limit: query.limit ?? 20 })),
    },
    {
      name: 'task_list',
      description: 'Tasks by state (open, ready, claimed, blocked, completed, ...), channel, owner, or for whom.',
      input: z.object({ channel: z.string().optional(), state: z.string().optional(), owner: z.string().optional(), for: z.string().optional(), limit: z.number().int().min(1).max(100).optional() }),
      replay: 'safe',
      approval: 'never',
      run: (query) => answer(() => board().tasks.list({ ...query, limit: query.limit ?? 50 })),
    },
    {
      name: 'task_create',
      description: 'Make a task: a new thread in a channel with a state the board keeps. needs: IDs of tasks it waits for. for: the actor it is assigned to.',
      input: z.object({ channel: Channel, text: Text, needs: z.array(Id).optional(), for: z.string().optional() }),
      replay: 'unsafe',
      approval: 'never',
      run: async (input) => refused([input.for]) ?? answer(() => stamped((labels) => board().tasks.create({ ...input, labels }))),
    },
    {
      name: 'task_create_many',
      description: "Make several tasks in one channel at once. Each has a key; needs names other tasks' keys (or existing IDs), so the board keeps their order. handoff: the ID of a task handed to you that these tasks carry out; it's completed, naming them.",
      input: z.object({
        channel: Channel,
        tasks: z.array(z.object({ key: z.string(), text: Text, needs: z.array(z.string()).optional(), for: z.string().optional() })).min(1).max(20),
        handoff: Id.optional(),
      }),
      replay: 'unsafe',
      approval: 'never',
      run: async ({ channel, tasks, handoff }) =>
        refused(tasks.map((t: { for?: string }) => t.for)) ??
        answer(async () => {
          const made = (await stamped((labels) => board().tasks.createMany(channel, tasks.map((t: { key: string; text: string; needs?: string[]; for?: string }) => ({ ...t, labels: { ...labels, ...(handoff ? { [HANDOFF]: handoff } : {}) }, needs: t.needs?.map((need) => (tasks.some((o: { key: string }) => o.key === need) ? { key: need } : need)) }))))) as { tasks?: { task?: { id: string }; id?: string; message?: { id: string } }[] }
          if (!handoff) return made
          const ids = (made.tasks ?? []).map((one) => '#' + (one.task?.id ?? one.message?.id ?? one.id))
          return { ...made, handoff: { id: handoff, state: await closeHandoff(handoff, 'Turned into ' + ids.join(', ') + ' in ' + channel + '.') } }
        }),
    },
    {
      name: 'task_claim',
      description: 'Claim a ready task before working on it. Only one claimant holds a task at a time.',
      input: z.object({ id: Id }),
      replay: 'safe',
      approval: 'never',
      run: ({ id }) => answer(async () => (await claimed(id)).task),
    },
    {
      name: 'task_complete',
      description: 'Complete a task this seat claimed, with a short result.',
      input: z.object({ id: Id, result: z.string().optional() }),
      replay: 'unsafe',
      approval: 'never',
      run: ({ id, result }) =>
        answer(async () => {
          const claim = await claimed(id)
          if (options.beforeComplete) await options.beforeComplete(id)
          return claim.complete(result)
        }),
    },
    {
      name: 'task_block',
      description: "Escalate a task: hold it, with why and a kind (decision, review, or budget), for whoever you escalate to (the seat your edges name, or the principal).",
      input: z.object({ id: Id, reason: Text, kind: z.enum(['decision', 'review', 'budget']).optional() }),
      replay: 'unsafe',
      approval: 'never',
      run: ({ id, reason, kind }) =>
        answer(async () => {
          // To a seat, the hold is labeled for it, which wakes it (its derived escalated rule); to the principal, it's in their inbox.
          const to = seat()?.escalates
          // Only a task the app owns (a seat made it) can be held for a seat; a person's task is held for them by its claim, as before.
          const view = to ? ((await board().read(id, { limit: 1 }).catch(() => null)) as { message?: { task?: { owner?: string } } } | null) : null
          if (to && options.escalate && view?.message?.task?.owner === 'worker:workbus-app') {
            await board().label(id, { set: { [ESCALATED]: to.key } })
            // Its claim lets go first: the hold is the task's, for the seat to answer; the seat claims it again after.
            const claim = await claimed(id).catch(() => null)
            if (claim) await (claim as unknown as { release(): Promise<unknown> }).release()
            return { escalatedTo: to.actor, held: await options.escalate(id, reason, kind) }
          }
          // To the principal: held by its claim when it holds one (theirs alone to answer), else as the task's maker.
          const claim = await claimed(id).catch(() => null)
          return claim ? claim.block(reason, kind) : board().tasks.block(id, reason, kind)
        }),
    },
    {
      name: 'task_answer',
      description: 'Answer a task escalated to you (labeled org.escalated=<your key>): approved or declined, with a note saying what to do. The holder goes on with your answer.',
      input: z.object({ id: Id, decision: z.enum(['approved', 'declined']), note: z.string().min(1).max(1000) }),
      replay: 'unsafe',
      approval: 'never',
      run: async ({ id, decision, note }) => {
        const me = seat()
        const thread = (await board().read(id, { limit: 1 }).catch(() => null)) as { message?: { labels?: Record<string, string> } } | null
        if (!me || thread?.message?.labels?.[ESCALATED] !== me.key) return { text: '#' + id + " wasn't escalated to you: you answer only tasks labeled " + ESCALATED + '=' + (me?.key ?? '<your key>') + '.', isError: true }
        return answer(() => (decision === 'approved' ? board().tasks.approve(id, note) : board().tasks.decline(id, note)))
      },
    },
    {
      name: 'board_consult',
      description: "Ask a seat you consult a question (only those your edges name). It's posted mentioning it and labeled as a consult, which wakes it, in re, or this session's thread, or (when that's a DM, which it can't read) a new thread in ops/consults. Its answer wakes you. A plain @mention of another seat wakes nothing.",
      input: z.object({ to: z.string().describe('its key or handle'), question: Text, re: Id.optional().describe('a thread you both read; this session\'s thread by default') }),
      replay: 'unsafe',
      approval: 'never',
      run: async ({ to, question, re }, context) => {
        const target = seat()?.consults?.find((one) => one.key === to || one.handle === to.replace(/^@/, ''))
        if (!target) return { text: 'You consult only ' + (seat()?.consults?.map((one) => '@' + one.handle).join(', ') || 'no one') + '.', isError: true }
        const message = { text: '@[' + target.actor + '] ' + unmention(question, target), labels: { [CONSULT]: target.key, ...stampOf() } }
        const thread = re ?? context.thread
        const where = (await board().read(thread, { limit: 1 }).catch(() => null)) as { message?: { channel?: string } } | null
        // A DM is the seat's alone: the seat it consults couldn't read it, so the consult starts a thread where both can.
        if (!where?.message?.channel || where.message.channel.startsWith('dm/')) return answer(() => board().post(CONSULTS, message))
        return answer(() => board().reply(thread, message))
      },
    },
    {
      name: 'board_answer',
      description: 'Answer a consult (a message labeled org.consult=<your key>, from a seat that consults you), once, in its thread. Your answer wakes the seat that asked.',
      input: z.object({ id: Id.describe("the consult's message ID"), answer: Text }),
      replay: 'unsafe',
      approval: 'never',
      run: async ({ id, answer: text }) => {
        const me = seat()
        const asked = (await board().read(id, { limit: 1 }).catch(() => null)) as { message?: { id: string; re: string | null; by?: { actor?: string } }; replies?: { id: string; by?: { actor?: string }; labels?: Record<string, string> }[] } | null
        // The consult may be the thread's root or a reply in it: find it, and who asked.
        const consult = asked?.message?.id === id ? asked?.message : asked?.replies?.find((reply) => reply.id === id)
        const asker = me?.consultedBy?.find((one) => one.actor === consult?.by?.actor)
        if (!me || !asker) return { text: '#' + id + " isn't a consult from a seat that consults you" + (me?.consultedBy?.length ? ' (' + me.consultedBy.map((one) => '@' + one.handle).join(', ') + ')' : '') + '.', isError: true }
        return answer(() => board().reply(id, { text: '@[' + asker.actor + '] ' + unmention(text, asker), labels: { [ANSWER]: asker.key, ...stampOf() } }))
      },
    },
    {
      name: 'task_assign',
      description: "Assign a task to an actor (for: worker:workbus-app+<seat>, or a person's actor), or to no one (null) so anyone may claim it. Its owner or a manager reassigns.",
      input: z.object({ id: Id, for: z.string().nullable() }),
      replay: 'safe',
      approval: 'never',
      run: ({ id, for: to }) => answer(() => board().tasks.assign(id, to)),
    },
    {
      name: 'task_reopen',
      description: 'Open a failed or canceled task again, as it was, to retry it. Its owner or a manager reopens.',
      input: z.object({ id: Id }),
      replay: 'safe',
      approval: 'never',
      run: ({ id }) => answer(() => board().tasks.reopen(id)),
    },
    {
      name: 'doc_read',
      description: "Read a doc by its ID or its path (channel/slug), whole or one section.",
      input: z.object({ id: Id.optional(), path: z.string().optional(), section: z.string().optional() }),
      replay: 'safe',
      approval: 'never',
      run: ({ id, path, section }) =>
        answer(() => {
          const query = section ? { section } : undefined
          if (id) return board().docs.read(id, query)
          if (path) return board().docs.at(path, query)
          throw new Error('pass id or path')
        }),
    },
    {
      name: 'doc_create',
      description: 'Make a doc at channel/slug from its markdown body. propose: true asks for it instead: a proposal task someone with edit there completes to create it (the only way to add a doc where you may post but not edit, as in org/).',
      input: z.object({ channel: Channel, slug: z.string(), body: z.string(), propose: z.boolean().optional(), note: z.string().optional() }),
      replay: 'unsafe',
      approval: 'never',
      run: (input) =>
        answer(async () => {
          // A note goes with a proposal only; without one, it's dropped rather than refused.
          if (!input.propose) delete input.note
          if (input.propose) {
            const path = input.channel + '/' + input.slug
            const open = await openProposal(input.channel, 'new:' + path)
            if (open) throw new Error(proposedAlready(open, path))
          }
          const made = await stamped((labels) => board().docs.create({ ...input, labels }))
          // A proposal's task is the proposal itself: it carries the request too.
          if (input.propose) await stampAfter((made as { proposal?: unknown })?.proposal)
          return made
        }),
    },
    {
      name: 'hire_propose',
      description: "Propose hiring a seat from a template in org/templates (engineer, writer), with the work it's for, in one step: the seat doc as a proposal for the principal to apply, and the work's tasks made for the new seat and waiting on that proposal, so nothing starts and no other seat takes them until it's applied. An open proposal for the same seat is reused, never doubled. handoff: the ID of a task handed to you that this carries out; it's completed, naming what was made.",
      input: z.object({
        template: z.string().describe('a template in org/templates: engineer or writer'),
        key: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/).describe("the new seat's key and handle: a short lowercase word for what it does"),
        name: z.string().min(1).max(64).describe('its display name: a person-like first name'),
        budget: z.number().positive().optional().describe("its monthly budget in USD: the template's, or less"),
        note: z.string().max(2000).optional().describe('why this hire: one or two sentences the principal reads in the inbox'),
        work: z
          .object({ channel: Channel, tasks: z.array(z.object({ key: z.string(), text: Text, needs: z.array(z.string()).optional() })).min(1).max(20) })
          .optional()
          .describe("the work for the new seat, made now and waiting on the hire, in a channel you may post in (eng/queue); needs names other tasks' keys"),
        handoff: Id.optional(),
      }),
      replay: 'unsafe',
      approval: 'never',
      run: (input) =>
        answer(async () => {
          const asked = 'org/seats/' + input.key
          const exists = await board().docs.at(asked).then(() => true, () => false)
          if (exists) throw new Error(asked + ' exists: that seat is hired already; assign the work to worker:workbus-app+' + input.key)
          // One open hire per seat, and per role: a second request reuses the open one, whatever key it was given.
          let proposal = (await openProposal('org/seats', 'new:' + asked)) ?? (await openHire(input.template))
          const reused = proposal !== null
          let path = asked
          let picked: { asked: string; key: string; why: string } | null = null
          if (proposal) {
            const { message } = (await board().read(proposal, { limit: 1 })) as { message: { labels: Record<string, string> } }
            path = String(message.labels['board.doc.proposal'] ?? 'new:' + asked).slice(4)
          } else {
            // A key nobody has had: a let-go seat's actor keeps its key and handle (its history is its own), so a hire never reuses them.
            // Hidden actors too (#16): a let-go seat hidden from the lists still holds its key.
            const actors = ((await board().actors({ hidden: true })) as { actors?: { id: string; handle?: string | null }[] }).actors ?? []
            const free = async (k: string) => !actors.some((one) => one.id === 'worker:workbus-app+' + k || one.handle === k) && !(await board().docs.at('org/seats/' + k).then(() => true, () => false))
            let key = input.key
            for (let n = 2; !(await free(key)); n++) {
              if (n > 9) throw new Error('no free key near ' + input.key + ': choose another word for it')
              key = input.key + '-' + n
            }
            path = 'org/seats/' + key
            if (key !== input.key) picked = { asked: input.key, key, why: input.key + ' was a seat before (its actor and handle stay its own), so this hire is ' + key }
            const template = (await board().docs.at('org/templates/' + input.template).catch(() => null)) as { body: string } | null
            if (!template) throw new Error('no template org/templates/' + input.template + ': the templates are the docs in org/templates')
            const fence = /(\`\`\`json#seat@\d+[^\n]*\n)([\s\S]*?)(\n\`\`\`)/
            const found = fence.exec(template.body)
            if (!found) throw new Error('org/templates/' + input.template + ' has no seat block')
            const block = JSON.parse(found[2]!) as Record<string, any>
            const ceiling = block.budget?.month
            if (input.budget !== undefined && typeof ceiling === 'number' && input.budget > ceiling)
              throw new Error("a hire's budget is the template's ($" + ceiling + ') or less; propose at $' + ceiling + ' and say in the note why it needs more')
            const { role, name: _name, handle: _handle, ...rest } = block
            const ordered = { role, name: input.name, handle: key, ...rest, ...(input.budget !== undefined ? { budget: { ...(block.budget ?? {}), month: input.budget } } : {}) }
            const body = template.body
              .replace(fence, (_all, open: string, _old: string, close: string) => open + JSON.stringify(ordered, null, 2) + close)
              .replace(/^# .*$/m, '# ' + input.name)
              .replace(/\{\{name\}\}/g, input.name)
              .replace(/\n## Hiring from this template[\s\S]*$/, '\n')
            const made = (await board().docs.create({ channel: 'org/seats', slug: key, body, propose: true, ...(input.note ? { note: input.note } : {}) })) as { proposal: { id: string } }
            // The proposal is part of the request it came from: labeled after, as a proposal's task can't be labeled by its write.
            await stampAfter(made.proposal)
            proposal = made.proposal.id
          }
          const actor = 'worker:workbus-app+' + path.slice('org/seats/'.length)
          // The work waits on the hire: for the new seat, needing the proposal. Made once: work already waiting on it stays as it is.
          let tasks: string[] = []
          if (input.work) {
            const { tasks: waiting } = (await board().tasks.list({ needs: proposal, state: 'open', limit: 50 })) as { tasks: { message: { id: string } }[] }
            tasks = waiting.map((one) => one.message.id)
            if (tasks.length === 0) {
              const work = input.work.tasks
              try {
                const made = (await stamped((labels) => board().tasks.createMany(
                  input.work!.channel,
                  work.map((t: { key: string; text: string; needs?: string[] }) => ({ key: t.key, text: t.text, for: actor, labels: { ...labels, ...(input.handoff ? { [HANDOFF]: input.handoff } : {}) }, needs: [proposal, ...(t.needs ?? []).map((need) => (work.some((o: { key: string }) => o.key === need) ? { key: need } : need))] })),
                ))) as { tasks: { id: string }[] }
                tasks = made.tasks.map((one) => one.id)
              } catch (error) {
                // A hire with no work to wait on it isn't what was asked: a proposal made now is withdrawn, and the error says why.
                if (!reused) await board().tasks.cancel(proposal, "Withdrawn: its work couldn't be made (" + (error instanceof Error ? error.message : String(error)) + ').').catch(() => undefined)
                throw new Error("the work couldn't be made in " + input.work.channel + ': ' + (error instanceof Error ? error.message : String(error)) + (reused ? '' : '; the hire proposal was withdrawn too. Put the work in a channel you may post in, such as eng/queue, and call hire_propose again.'))
              }
            }
          }
          const result = { proposal, path, reused, tasks, waitingFor: actor, ...(picked ? { picked } : {}), ...(reused ? { note: 'An open hire proposal, #' + proposal + ', for ' + path + ' was reused: nothing new was proposed.' } : {}) }
          if (!input.handoff) return result
          const said = 'Turned into a hire proposal, #' + proposal + ' (' + path + ')' + (tasks.length ? ', and ' + tasks.map((id) => '#' + id).join(', ') + ', waiting on it, for ' + actor : '') + '.'
          return { ...result, handoff: { id: input.handoff, state: await closeHandoff(input.handoff, said) } }
        }),
    },
    {
      name: 'doc_edit',
      description: "Edit a doc by section ({ section, text }, { after, text }, or { remove }) or replace its body. propose: true makes it a proposal someone reviews.",
      input: z.object({
        id: Id,
        edits: z.array(z.union([z.object({ section: z.string(), text: z.string() }), z.object({ after: z.string(), text: z.string() }), z.object({ remove: z.string() })])).optional(),
        body: z.string().optional(),
        propose: z.boolean().optional(),
        note: z.string().optional(),
      }),
      replay: 'unsafe',
      approval: 'never',
      run: ({ id, ...input }) =>
        answer(async () => {
          if (!input.propose) delete input.note
          if (input.propose) {
            const { doc } = (await board().docs.read(id)) as { doc: { id: string; path: string } }
            const open = await openProposal(doc.path.slice(0, doc.path.lastIndexOf('/')), doc.id)
            if (open) throw new Error(proposedAlready(open, doc.path))
          }
          const made = await board().docs.edit(id, input)
          if (input.propose) await stampAfter((made as { proposal?: unknown })?.proposal)
          return made
        }),
    },
    {
      name: 'board_follow',
      description: 'Follow a thread (or stop, with on: false), so its replies wake this seat; without id, what this seat follows.',
      input: z.object({ id: Id.optional(), on: z.boolean().optional() }),
      replay: 'safe',
      approval: 'never',
      run: ({ id, on }) => answer(() => (id ? board().follow(id, on === undefined ? undefined : { on }) : board().follows({ limit: 50 }))),
    },
  ]
  return tools
}
