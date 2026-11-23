// Where the suite's wakes deliver: the WAKE service binding (vitest.config.ts) is this
// Worker's own TestWake entrypoint, answered in this isolate. Every try is recorded, per board,
// with when it came. An event whose message text says wake-fail-twice is refused its first two tries.
import { WorkerEntrypoint } from 'cloudflare:workers'
import type { WakeContext } from '../src/mailbox.ts'

export type Woken = { board: string; wake: string; actor: string; rules: string[]; match: string; attempt: number; at: number; ok: boolean; event: { cursor: string; type: string; payload?: Record<string, unknown>; message?: { id: string; text: string; re: string | null; channel: string } } }

export const woken: Woken[] = []
export const wokenFor = (board: string, wake: string) => woken.filter((entry) => entry.board === board && entry.wake === wake)

/** The principals the wake sink lets target it: a test takes one away to see the board stop handing it on. */
export const wakePrincipals = ['worker:workbus-app']

export class TestWake extends WorkerEntrypoint {
  async wake(event: Woken['event'], context: WakeContext) {
    const refuse = (event.message?.text ?? '').includes('wake-fail-twice') && context.attempt <= 2
    woken.push({ board: context.board, wake: context.wake, actor: context.actor, rules: context.rules, match: context.match, attempt: context.attempt, at: Date.now(), ok: !refuse, event })
    if (refuse) throw new Error('not now')
  }
}
