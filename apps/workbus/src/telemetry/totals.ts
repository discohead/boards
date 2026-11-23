// The Seat's own record of its runs and their cost: the cost the app shows and the budget checks
// read (§5.6). The same records go to Basin (runs_v1), which a check compares against.
// Runs are kept in the Seat's SQLite, keyed by id, so a record written twice counts once, and a
// send that fails stays unsent until flush() delivers it.
import { Run, toRow, type RunRow } from './run.ts'

/** The part of SqlStorage this uses (a Durable Object's ctx.storage.sql, or node:sqlite in a check). */
export type Sql = { exec(query: string, ...bindings: (string | number | null)[]): { toArray(): Record<string, unknown>[] } }

/** The Pipelines binding for runs_v1, or anything with its send(). */
export type RunStream = { send(rows: RunRow[]): Promise<void> }

/** A budget period: the calendar month, in UTC, that a run ended in. */
export const periodOf = (iso: string) => iso.slice(0, 7)

export type Spend = { seat: string; period: string; runs: number; cost: number; tokens: { input: number; output: number; cacheRead: number; cacheWrite: number } }

export class Totals {
  readonly sql: Sql
  constructor(sql: Sql) {
    this.sql = sql
    sql.exec(`CREATE TABLE IF NOT EXISTS telemetry_runs (
      id TEXT PRIMARY KEY, seat TEXT NOT NULL, period TEXT NOT NULL, cost REAL NOT NULL,
      input INTEGER NOT NULL, output INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL,
      record TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0)`)
    sql.exec('CREATE INDEX IF NOT EXISTS telemetry_runs_period ON telemetry_runs (seat, period)')
  }

  /** Keep a run (once, by id). Throws when it doesn't fit the Run schema; returns whether it was new. */
  add(input: Run): boolean {
    const run = Run.parse(input)
    const before = this.sql.exec('SELECT 1 FROM telemetry_runs WHERE id = ?', run.id).toArray().length
    if (before) return false
    this.sql.exec('INSERT INTO telemetry_runs (id, seat, period, cost, input, output, cache_read, cache_write, record) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      run.id, run.seat, periodOf(run.ended), run.cost, run.tokens.input, run.tokens.output, run.tokens.cacheRead, run.tokens.cacheWrite, JSON.stringify(run))
    return true
  }

  /** Send every unsent run to the stream, oldest first, in batches. Returns how many were sent. */
  async flush(stream: RunStream, batch = 100): Promise<number> {
    let sent = 0
    for (;;) {
      const rows = this.sql.exec('SELECT id, record FROM telemetry_runs WHERE sent = 0 ORDER BY rowid LIMIT ?', batch).toArray()
      if (!rows.length) return sent
      await stream.send(rows.map((row) => toRow(JSON.parse(String(row.record)))))
      for (const row of rows) this.sql.exec('UPDATE telemetry_runs SET sent = 1 WHERE id = ?', String(row.id))
      sent += rows.length
    }
  }

  /** A seat's spend in a period (default: this month). */
  spend(seat: string, period = periodOf(new Date().toISOString())): Spend {
    const [row] = this.sql.exec(`SELECT count(*) AS runs, coalesce(sum(cost), 0) AS cost, coalesce(sum(input), 0) AS input,
      coalesce(sum(output), 0) AS output, coalesce(sum(cache_read), 0) AS cache_read, coalesce(sum(cache_write), 0) AS cache_write
      FROM telemetry_runs WHERE seat = ? AND period = ?`, seat, period).toArray()
    return { seat, period, runs: Number(row.runs), cost: Number(row.cost), tokens: { input: Number(row.input), output: Number(row.output), cacheRead: Number(row.cache_read), cacheWrite: Number(row.cache_write) } }
  }

  /** Every period this seat has runs in, newest first. */
  periods(seat: string): Spend[] {
    return this.sql.exec('SELECT DISTINCT period FROM telemetry_runs WHERE seat = ? ORDER BY period DESC', seat).toArray().map((row) => this.spend(seat, String(row.period)))
  }

  /** Runs not yet delivered to Basin. */
  unsent(): number {
    return Number(this.sql.exec('SELECT count(*) AS n FROM telemetry_runs WHERE sent = 0').toArray()[0].n)
  }
}
