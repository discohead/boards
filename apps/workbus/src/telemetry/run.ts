// The run record (design/workbus.md §8.2): one per harness operation, written by the Seat when the
// operation ends. Validated here before it is sent, because a Basin stream accepts a row that doesn't
// fit its schema and then drops it without a word.
import { z } from 'zod'

const count = z.number().int().nonnegative()

export const Tool = z.object({ name: z.string().min(1), ms: count, ok: z.boolean() })

export const Run = z.object({
  id: z.string().min(1),
  seat: z.string().min(1),
  team: z.string().min(1).nullable(),
  thread: z.string().min(1),
  task: z.string().min(1).nullable(),
  operation: z.string().min(1),
  harness: z.literal('pi'),
  model: z.string().min(1),
  charter: z.string().min(1).nullable(), // the seat doc's revision
  started: z.iso.datetime(),
  ended: z.iso.datetime(),
  outcome: z.enum(['answered', 'ended', 'failed', 'aborted', 'over_budget']),
  steps: count, // model responses in the operation
  tools: z.array(Tool),
  tokens: z.object({ input: count, output: count, cacheRead: count, cacheWrite: count }),
  cost: z.number().nonnegative(), // USD
  // Where cost came from: pi-ai prices each response from its model catalog, as the gateway does.
  // The gateway's own figure joins through logIds (cf-aig-log-id).
  costSource: z.enum(['pi', 'gateway']),
  logIds: z.array(z.string()),
  error: z.string().nullable(),
})
export type Run = z.infer<typeof Run>
export type Outcome = Run['outcome']

/** The row the stream runs_v1 takes (src/telemetry/runs_v1.schema.json): flat, snake_case, no nulls. */
export type RunRow = ReturnType<typeof toRow>

export function toRow(run: Run) {
  const row = {
    id: run.id,
    seat: run.seat,
    team: run.team ?? undefined,
    thread: run.thread,
    task: run.task ?? undefined,
    operation: run.operation,
    harness: run.harness,
    model: run.model,
    charter: run.charter ?? undefined,
    started: run.started,
    ended: run.ended,
    outcome: run.outcome,
    steps: run.steps,
    tools: run.tools,
    input_tokens: run.tokens.input,
    output_tokens: run.tokens.output,
    cache_read_tokens: run.tokens.cacheRead,
    cache_write_tokens: run.tokens.cacheWrite,
    cost: run.cost,
    cost_source: run.costSource,
    log_ids: run.logIds,
    error: run.error ?? undefined,
  }
  // The stream treats a missing optional field as null; it rejects an explicit null on some types.
  for (const key of Object.keys(row) as (keyof typeof row)[]) if (row[key] === undefined) delete row[key]
  return row
}

/** What pi's assistant messages carry that a run record needs, read structurally (no pi import). */
export type PiResponse = {
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } }
  diagnostics?: { type?: string; details?: unknown }[]
  model?: string
}

export type Usage = Pick<Run, 'steps' | 'tokens' | 'cost' | 'logIds'>

/** The sum of an operation's model responses: its tokens, its cost, and the gateway's log ids. */
export function usageOf(responses: readonly PiResponse[]): Usage {
  const usage: Usage = { steps: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0, logIds: [] }
  for (const response of responses) {
    const u = response.usage ?? {}
    usage.steps++
    usage.tokens.input += u.input ?? 0
    usage.tokens.output += u.output ?? 0
    usage.tokens.cacheRead += u.cacheRead ?? 0
    usage.tokens.cacheWrite += u.cacheWrite ?? 0
    usage.cost += u.cost?.total ?? 0
    for (const diagnostic of response.diagnostics ?? []) {
      const logId = (diagnostic.details as { logId?: unknown } | undefined)?.logId
      if (typeof logId === 'string' && !usage.logIds.includes(logId)) usage.logIds.push(logId)
    }
  }
  return usage
}

/** The harness's per-operation usage (src/harness/types.ts), read structurally. */
export type HarnessUsage = {
  model: string | null
  steps: number
  tokens: Run['tokens']
  cost: number
  tools: Run['tools']
  logs: string[]
  started: string
  ended: string | null
}

/** How the harness says an operation ended. */
export type HarnessOutcome = { operationId: string; status: 'done' | 'unanswered'; reason?: string; usage: HarnessUsage; resumes?: string }

/** What only the Seat knows about a run. */
export type SeatFields = Pick<Run, 'seat' | 'team' | 'thread' | 'task' | 'charter'> & { overBudget?: boolean }

/**
 * The run record for a finished operation. Its id is the operation's, so recording an operation
 * twice counts once. Returns null for an approval's answer (an operation that only resumes another):
 * the resumed operation's own record carries the work.
 */
export function runOf(outcome: HarnessOutcome, seat: SeatFields, now = new Date().toISOString()): Run | null {
  if (outcome.resumes) return null
  const usage = outcome.usage
  const failed = outcome.status === 'done' ? null : (outcome.reason ?? 'unanswered')
  return Run.parse({
    id: seat.seat + ':' + outcome.operationId,
    seat: seat.seat, team: seat.team, thread: seat.thread, task: seat.task, charter: seat.charter,
    operation: outcome.operationId,
    harness: 'pi',
    model: usage.model ?? 'none',
    started: usage.started,
    ended: usage.ended ?? now,
    outcome: seat.overBudget ? 'over_budget' : outcome.status === 'done' ? 'answered' : /abort|withdraw/.test(failed ?? '') ? 'aborted' : 'failed',
    steps: usage.steps,
    tools: usage.tools,
    tokens: usage.tokens,
    cost: usage.cost,
    costSource: 'pi',
    logIds: usage.logs,
    error: failed,
  })
}
