// The reconciler (design/workbus.md §4.5): org/'s docs turned into running parts. It runs as the
// app (worker:workbus-app, no profile) on each org/ doc event its wake delivers, and on
// boot. Each pass reads every doc in org/ (the board has checked their blocks), plans with
// rules.ts, and applies each seat's runtime idempotently: its Seat object's config (ordered by
// the docs' revision), and one wake as the seat itself (keyed by the seat, ordered by its
// doc's revision; the board answers a repeat as no change). A doc that can't apply gets a reply in
// its thread, once per revision, saying why; its seat keeps what it had.
import type { Board } from '../bus.ts'
import { codeOf } from '../bus.ts'
import { pathOf, plan, type OrgDoc, type Permission, type Plan, type SeatRuntime } from './rules.ts'

/** The reconciler's own wake, and each seat's: keys in the app's one namespace. */
export const ORG_WAKE = 'org'
export const SEAT_PREFIX = 'seat.'
export const seatWake = (key: string) => SEAT_PREFIX + key
export const SINK = 'wake'

export type SeatStub = { configure(runtime: SeatRuntime | null, revision: number): Promise<unknown> }
export type Applied = { seat: string; wake: 'created' | 'changed' | 'same' | 'stale' | 'conflict' | 'removed'; config: unknown }
export type Pass = { plan: Plan; applied: Applied[]; replies: string[] }

/** Every doc in org/ and its subtree, as rules.ts reads them. */
export async function readOrg(app: Board): Promise<OrgDoc[]> {
  const out: OrgDoc[] = []
  let before: string | undefined
  for (let page = 0; page < 20; page++) {
    const answer = await app.threads({ channel: 'org/', limit: 200, ...(before ? { before } : {}) })
    for (const { message } of answer.threads as { message: any }[]) {
      if (!message.doc || message.deleted) continue
      const path: string = message.doc.path
      const split = path.lastIndexOf('/')
      out.push({ id: message.id, channel: path.slice(0, split), slug: path.slice(split + 1), title: message.doc.title, revision: Number(message.revision), text: message.text, blocks: message.blocks ?? [] })
    }
    if (!answer.older) break
    before = answer.older
  }
  return out
}

/** What the app may do on the board, by pattern, as its /me says: no seat may do more. */
export async function holdings(app: Board): Promise<Record<string, Permission[]>> {
  const me = await app.me()
  const can = me.can as Record<string, Permission[] | 'all'>
  return Object.fromEntries(Object.entries(can).map(([pattern, grant]) => [pattern, grant === 'all' ? ['read', 'post', 'react', 'label', 'edit', 'sync', 'manage'] : grant]))
}

/** The seat as the board sees it: the app, writing as its profile, held to its can. */
export const seatBoard = (app: Board, seat: Pick<SeatRuntime, 'key' | 'name' | 'handle' | 'avatar' | 'can'>) =>
  app.as({ key: seat.key, name: seat.name, handle: seat.handle, ...(seat.avatar ? { avatar: seat.avatar } : {}) }).narrow(seat.can)

/**
 * One pass. changed names the doc that brought it (from its event), so a problem with that doc is
 * answered in its thread; on boot there's none, and problems are only logged.
 */
export async function reconcile(app: Board, seatOf: (key: string) => SeatStub, changed?: string): Promise<Pass> {
  const [docs, holds] = await Promise.all([readOrg(app), holdings(app)])
  const planned = plan(docs, holds)
  const applied: Applied[] = []
  for (const seat of planned.seats) {
    let wake: Applied['wake']
    try {
      const answer = await seatBoard(app, seat).setWake(seatWake(seat.key), { sink: SINK, rules: seat.rules, revision: seat.revision })
      wake = answer.stale ? 'stale' : answer.created ? 'created' : answer.changed ? 'changed' : 'same'
    } catch (error) {
      // The same revision with other content: the derivation changed under a doc that didn't (a deploy).
      if (codeOf(error) !== 'revision_conflict') throw error
      wake = 'conflict'
      console.warn('reconcile: ' + seat.key + "'s wake at revision " + seat.revision + ' conflicts with what the board holds:', String(error))
    }
    applied.push({ seat: seat.key, wake, config: await seatOf(seat.key).configure(seat, seat.configRevision) })
  }
  // A seat whose doc is gone is let go: its wake removed, its Seat retired. History stays.
  const live = new Set(docs.filter((doc) => doc.channel === 'org/seats').map((doc) => doc.slug))
  const { wakes } = await app.wakes({ prefix: SEAT_PREFIX })
  for (const held of wakes as { key: string }[]) {
    const key = held.key.slice(SEAT_PREFIX.length)
    if (live.has(key)) continue
    await app.deleteWake(held.key)
    applied.push({ seat: key, wake: 'removed', config: await seatOf(key).configure(null, 0) })
  }
  const replies: string[] = []
  for (const problem of planned.problems) {
    console.warn('reconcile: ' + problem.path + ' (revision ' + problem.revision + '): ' + problem.why)
    if (problem.doc !== changed) continue
    // One reply per revision: a redelivered event, or a second pass, finds the first.
    await app.reply(problem.doc, { text: "This revision of " + problem.path + " can't apply: " + problem.why + '. Until it can, the seat keeps the config it had.', id: 'reconcile-' + problem.doc + '-' + problem.revision })
    replies.push(problem.path)
  }
  return { plan: planned, applied, replies }
}

export { pathOf }
