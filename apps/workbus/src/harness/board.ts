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
  tasks: {
    list(query?: Record<string, unknown>): Promise<unknown>
    create(input: Record<string, unknown>): Promise<{ task: unknown }>
    createMany(channel: string, tasks: unknown[], opts?: { id?: string }): Promise<unknown>
    claim(target: { id: string }, opts?: { lease?: number; token?: string }): Promise<{ complete(result?: string): Promise<unknown>; block(reason: string, kind?: string): Promise<unknown>; fail(reason: string): Promise<unknown>; task: unknown }>
    block(id: string, reason: string, kind?: string): Promise<unknown>
  }
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

/**
 * The board tools. claimToken is the session's own claim token: a claim made with it is the
 * session's to complete later, after the stub is gone (a retry with the token gets the claim back).
 */
export function boardTools(board: () => SeatBoard, claimToken: () => string, assigns?: () => readonly string[] | undefined): Tool<any>[] {
  // A seat that may assign only to some (the advisor, to the operator) is refused any other, before the board is asked.
  const refused = (fors: (string | undefined)[]): ToolResult | null => {
    const allowed = assigns?.()
    if (!allowed) return null
    const other = fors.find((to) => to === undefined || !allowed.includes(to))
    if (other === undefined && fors.every((to) => to !== undefined)) return null
    return { text: 'You may assign tasks only to ' + allowed.join(' or ') + ': set "for" to ' + (allowed.length === 1 ? 'it' : 'one of them') + ' on every task.', isError: true }
  }
  const claimed = (id: string) => board().tasks.claim({ id }, { token: claimToken() })
  const tools: Tool<any>[] = [
    {
      name: 'board_post',
      description: 'Start a thread in a channel. Answers the message, with its ID.',
      input: z.object({ channel: Channel, text: Text }),
      replay: 'unsafe',
      approval: 'never',
      run: ({ channel, text }) => answer(() => board().post(channel, text)),
    },
    {
      name: 'board_reply',
      description: 'Reply in the thread of a message.',
      input: z.object({ id: Id, text: Text }),
      replay: 'unsafe',
      approval: 'never',
      run: ({ id, text }) => answer(() => board().reply(id, text)),
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
      run: async (input) => refused([input.for]) ?? answer(() => board().tasks.create(input)),
    },
    {
      name: 'task_create_many',
      description: "Make several tasks in one channel at once. Each has a key; needs names other tasks' keys (or existing IDs), so the board keeps their order.",
      input: z.object({
        channel: Channel,
        tasks: z.array(z.object({ key: z.string(), text: Text, needs: z.array(z.string()).optional(), for: z.string().optional() })).min(1).max(20),
      }),
      replay: 'unsafe',
      approval: 'never',
      run: async ({ channel, tasks }) =>
        refused(tasks.map((t: { for?: string }) => t.for)) ??
        answer(() => board().tasks.createMany(channel, tasks.map((t: { key: string; text: string; needs?: string[]; for?: string }) => ({ ...t, needs: t.needs?.map((need) => (tasks.some((o: { key: string }) => o.key === need) ? { key: need } : need)) })))),
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
      run: ({ id, result }) => answer(async () => (await claimed(id)).complete(result)),
    },
    {
      name: 'task_block',
      description: 'Hold a task for a person, with why and a kind: decision, review, or budget.',
      input: z.object({ id: Id, reason: Text, kind: z.enum(['decision', 'review', 'budget']).optional() }),
      replay: 'unsafe',
      approval: 'never',
      run: ({ id, reason, kind }) => answer(() => board().tasks.block(id, reason, kind)),
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
      description: 'Make a doc at channel/slug from its markdown body.',
      input: z.object({ channel: Channel, slug: z.string(), body: z.string() }),
      replay: 'unsafe',
      approval: 'never',
      run: (input) => answer(() => board().docs.create(input)),
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
      run: ({ id, ...input }) => answer(() => board().docs.edit(id, input)),
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
