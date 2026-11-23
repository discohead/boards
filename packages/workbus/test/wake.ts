// Where the suite's subscriptions deliver: the WAKE service binding (vitest.config.ts) is this
// Worker's own TestWake entrypoint, answered in this isolate. Every try is recorded, per board,
// with when it came. An event whose message text says wake-fail-twice is refused its first two tries.
import { WorkerEntrypoint } from 'cloudflare:workers'
import type { SubscriptionContext } from '../src/mailbox.ts'

export type Wake = { board: string; subscription: string; actor: string; rules: string[]; match: string; attempt: number; at: number; ok: boolean; event: { cursor: string; type: string; message?: { id: string; text: string; re: string | null; channel: string } } }

export const wakes: Wake[] = []
export const wokenFor = (board: string, subscription: string) => wakes.filter((entry) => entry.board === board && entry.subscription === subscription)

/** The principals the wake sink lets target it: a test takes one away to see the board stop handing it on. */
export const wakePrincipals = ['worker:workbus-app']

export class TestWake extends WorkerEntrypoint {
  async wake(event: Wake['event'], context: SubscriptionContext) {
    const refuse = (event.message?.text ?? '').includes('wake-fail-twice') && context.attempt <= 2
    wakes.push({ board: context.board, subscription: context.subscription, actor: context.actor, rules: context.rules, match: context.match, attempt: context.attempt, at: Date.now(), ok: !refuse, event })
    if (refuse) throw new Error('not now')
  }
}
