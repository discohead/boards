// Task writes (packages/workbus/src/ledger/tasks.ts), each optimistic as actions.ts's are: the task
// changes at once in the tasks collection and in messages (where the thread pane reads its root),
// and settles on the task's own event, whose cursor is the answer's version. A refusal rolls it back.
//
// Complete, release, and fail need the claim's epoch and token. The board takes a token the caller
// makes, so each claim here sends one and keeps it (in localStorage, so a reload can still finish
// the work). Completing a task nobody holds claims it first, in the same action.
import { safeRandomUUID, type DbClient } from '@tanstack/db'
import { action, sendAndSettle } from './settle.ts'
import type { BusCollections } from './index.ts'
import type { BusRuntime } from './runtime.ts'
import type { Message, TaskFacet } from './types.ts'

type Claim = { epoch: number; token: string }

const CLAIMS_KEY = 'workbus.claims'
/** How long a claim made to finish a task at once holds it: the write that follows takes a moment. */
const FINISH_LEASE_S = 60

/** Claims this browser holds, by task: the token is proof the board checks, so it's kept with the epoch it was issued at. */
class Claims {
  #map = new Map<string, Claim>()
  constructor() {
    if (typeof localStorage === 'undefined') return
    try {
      for (const [id, claim] of Object.entries(JSON.parse(localStorage.getItem(CLAIMS_KEY) ?? '{}') as Record<string, Claim>)) this.#map.set(id, claim)
    } catch {}
  }
  get = (id: string) => this.#map.get(id)
  set(id: string, claim: Claim | null) {
    if (claim) this.#map.set(id, claim)
    else this.#map.delete(id)
    if (typeof localStorage !== 'undefined') localStorage.setItem(CLAIMS_KEY, JSON.stringify(Object.fromEntries(this.#map)))
  }
}

/** A claim token: 32 random bytes in base64url, 43 characters, as the board asks. */
function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

type Answer = { task: Message; claim?: { epoch: number; token: string; until: string } }

export function taskActions(db: DbClient, runtime: BusRuntime, c: BusCollections) {
  const { client } = runtime
  const feed = runtime.feed!
  const claims = new Claims()
  const me = () => runtime.me.actor

  /** Change a task where it's shown: the tasks collection, and messages when its root is there. */
  const patch = (id: string, change: (task: TaskFacet, message: Message) => void) => {
    for (const collection of [c.tasks, c.messages]) {
      if (!collection.has(id)) continue
      collection.update(id, (message) => {
        if (message.task) change(message.task, message)
        if (message.task) message.labels['board.task'] = message.task.state
      })
    }
  }

  /** Send a task write; it settles on its event (the answer's version), or after ECHO_MS its answer is written. */
  /** With a client ID, it settles on that event and then on the feed reaching the answer's version (settle.ts). */
  const settle = (send: () => Promise<Answer>, clientId?: string) =>
    sendAndSettle(feed, send, { ...(clientId ? { clientId } : {}), cursor: (answer) => answer.task.version }, (answer) => {
      c.tasks.utils.rows.merge([answer.task], (row) => row.version)
      if (c.messages.has(answer.task.id)) c.messages.utils.rows.merge([answer.task], (row) => row.version)
    })

  /**
   * My live claim on a task, if this browser holds it. It reads the board's own row (the synced
   * rows), not the collection's: inside a write, the optimistic change has already moved the task on.
   */
  const held = (id: string): Claim | null => {
    const task = c.tasks.utils.rows.get(id)?.task
    const claim = claims.get(id)
    if (!task || !claim) return null
    return task.state === 'claimed' && task.claim?.actor === me() && task.epoch === claim.epoch ? claim : null
  }

  const claimNow = async (id: string, lease?: number): Promise<Claim> => {
    const token = newToken()
    const answer = await client.post<Answer>('/tasks/' + id + '/claim', { token, ...(lease ? { lease } : {}) })
    const claim = { epoch: answer.claim!.epoch, token: answer.claim!.token }
    claims.set(id, claim)
    return claim
  }

  const claimed = (task: TaskFacet) => {
    task.state = 'claimed'
    task.claim = { actor: me(), until: new Date(Date.now() + 15 * 60_000).toISOString() }
    task.epoch += 1
  }

  /** A new task: a new thread in a channel, or (re) a thread that's there, which gains a state. */
  const create = action<{ channel: string; text: string; for?: string | null; labels?: Record<string, string>; id?: string } | { re: string; for?: string | null }>(db, {
    onMutate: (input) => {
      const facet: TaskFacet = { state: 'ready', owner: me(), by: me(), for: input.for ?? null, needs: [], epoch: 0, claim: null, blocked: null, result: null, reason: null }
      if ('re' in input) {
        const root = c.messages.get(input.re) ?? c.threads.get(input.re)?.root
        if (root && !c.tasks.has(input.re)) c.tasks.insert({ ...root, labels: { ...root.labels, 'board.task': 'ready' }, task: facet, pending: input.re })
        if (root && c.messages.has(input.re)) c.messages.update(input.re, (message) => void ((message.task = facet), (message.labels['board.task'] = 'ready')))
        return
      }
      const id = (input.id ??= 'web-' + safeRandomUUID())
      c.tasks.insert({
        id, channel: input.channel, text: input.text, re: null, replyTo: null, thread: id, labels: { ...input.labels, 'board.task': 'ready' }, reactions: {},
        by: { actor: me(), principal: me(), profile: null }, createdAt: new Date().toISOString(), editedAt: null, deleted: false, version: 0, revision: 0, pending: id, task: facet,
      })
    },
    mutationFn: async (input) => {
      const body = 're' in input ? { re: input.re, ...(input.for ? { for: input.for } : {}) } : { channel: input.channel, text: input.text, id: input.id, ...(input.labels ? { labels: input.labels } : {}), ...(input.for ? { for: input.for } : {}) }
      await settle(() => client.post<Answer>('/tasks', body), 're' in input ? undefined : input.id)
    },
  })

  const claim = action<{ id: string }>(db, {
    onMutate: ({ id }) => patch(id, claimed),
    mutationFn: async ({ id }) => {
      await settle(async () => {
        const token = newToken()
        const answer = await client.post<Answer>('/tasks/' + id + '/claim', { token })
        claims.set(id, { epoch: answer.claim!.epoch, token: answer.claim!.token })
        return answer
      })
    },
  })

  const release = action<{ id: string }>(db, {
    onMutate: ({ id }) => patch(id, (task) => void ((task.state = 'ready'), (task.claim = null))),
    mutationFn: async ({ id }) => {
      const proof = held(id) ?? claims.get(id)
      if (!proof) throw new Error('this browser holds no claim on #' + id)
      await settle(() => client.post<Answer>('/tasks/' + id + '/release', proof))
      claims.set(id, null)
    },
  })

  /** Complete it: with my claim, or by claiming it now. A proposal's change is applied by the board as it completes. */
  const complete = action<{ id: string; result?: string }>(db, {
    onMutate: ({ id, result }) => patch(id, (task) => void ((task.state = 'completed'), (task.claim = null), (task.result = result ?? null))),
    mutationFn: async ({ id, result }) => {
      const proof = held(id) ?? (await claimNow(id, FINISH_LEASE_S))
      await settle(() => client.post<Answer>('/tasks/' + id + '/complete', { ...proof, ...(result ? { result } : {}) }))
      claims.set(id, null)
    },
  })

  const fail = action<{ id: string; reason: string }>(db, {
    onMutate: ({ id, reason }) => patch(id, (task) => void ((task.state = 'failed'), (task.claim = null), (task.reason = reason))),
    mutationFn: async ({ id, reason }) => {
      const proof = held(id) ?? (await claimNow(id, FINISH_LEASE_S))
      await settle(() => client.post<Answer>('/tasks/' + id + '/fail', { ...proof, reason }))
      claims.set(id, null)
    },
  })

  /** Hold it for a person, with a kind (decision, approval, review, budget). My claim holds it, if I have one; else I hold it as its owner. */
  const block = action<{ id: string; reason: string; kind?: string }>(db, {
    onMutate: ({ id, reason, kind }) => patch(id, (task) => void ((task.state = 'blocked'), (task.claim = null), (task.blocked = { kind: kind ?? null, reason }))),
    mutationFn: async ({ id, reason, kind }) => {
      const proof = held(id)
      await settle(() => client.post<Answer>('/tasks/' + id + '/block', { reason, ...(kind ? { kind } : {}), ...(proof ?? {}) }))
      if (proof) claims.set(id, null)
    },
  })

  /** Lift a hold; with a decision, it's an answer (approved or declined, with a note) the one who held it reads on the task. */
  const unblock = action<{ id: string; decision?: 'approved' | 'declined'; note?: string }>(db, {
    onMutate: ({ id, decision, note }) =>
      patch(id, (task) => {
        task.state = task.needs.length > 0 ? 'waiting' : 'ready'
        task.blocked = null
        if (decision) task.answer = { decision, note: note ?? null, by: me() }
      }),
    mutationFn: async ({ id, decision, note }) => void (await settle(() => client.post<Answer>('/tasks/' + id + '/unblock', decision ? { decision, ...(note ? { note } : {}) } : undefined))),
  })

  const reopen = action<{ id: string }>(db, {
    onMutate: ({ id }) => patch(id, (task) => void ((task.state = 'ready'), (task.reason = null))),
    mutationFn: async ({ id }) => void (await settle(() => client.post<Answer>('/tasks/' + id + '/reopen'))),
  })

  /** Let one actor claim it (a person, a profile, a seat: worker:workbus-app+<key>), or anyone (null). */
  const assign = action<{ id: string; for: string | null }>(db, {
    onMutate: ({ id, for: assignee }) => patch(id, (task) => void (task.for = assignee)),
    mutationFn: async ({ id, for: assignee }) => void (await settle(() => client.post<Answer>('/tasks/' + id + '/assign', { for: assignee }))),
  })

  const cancel = action<{ id: string; reason: string }>(db, {
    onMutate: ({ id, reason }) => patch(id, (task) => void ((task.state = 'canceled'), (task.claim = null), (task.reason = reason))),
    mutationFn: async ({ id, reason }) => void (await settle(() => client.post<Answer>('/tasks/' + id + '/cancel', { reason }))),
  })

  /** What it waits for: tasks that complete first. Its owner's, while no one holds it. */
  const needs = action<{ id: string; needs: string[] }>(db, {
    onMutate: ({ id, needs: list }) => patch(id, (task) => void (task.needs = list)),
    mutationFn: async ({ id, needs: list }) => void (await settle(() => client.post<Answer>('/tasks/' + id + '/needs', { needs: list }))),
  })

  return { create, claim, release, complete, fail, block, unblock, reopen, assign, cancel, needs, held }
}

export type TaskActions = ReturnType<typeof taskActions>
