// Telemetry (design/workbus.md §8): run records, kept by the Seat and streamed to Basin.
//
//   const totals = new Totals(this.ctx.storage.sql)
//   await record(totals, this.env.RUNS, run)            // when an operation ends
//   totals.spend('ada')                                  // cost this month, for the UI and the budget
export { Run, Tool, toRow, usageOf, type Outcome, type PiResponse, type RunRow, type Usage } from './run.ts'
export { Totals, periodOf, type RunStream, type Spend, type Sql } from './totals.ts'
import type { Run } from './run.ts'
import type { RunStream, Totals } from './totals.ts'

/**
 * Record a finished operation: kept in the Seat's totals at once (so budgets see it), then sent to
 * Basin with any earlier runs a failed send left behind. A failed send doesn't throw; the run stays
 * unsent and the next record() or flush() delivers it.
 */
export async function record(totals: Totals, stream: RunStream, run: Run): Promise<{ added: boolean; sent: number; error?: string }> {
  const added = totals.add(run)
  try {
    return { added, sent: await totals.flush(stream) }
  } catch (error) {
    return { added, sent: 0, error: String(error) }
  }
}
