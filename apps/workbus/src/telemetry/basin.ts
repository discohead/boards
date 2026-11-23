// Reading run records back from Basin (warehouse <account>_workbus-telemetry, table telemetry.runs_v1).
// The app shows each seat's cost from its own Totals (a Basin SQL query takes about 2 s); Basin is for
// analysis, the Ops views, and the outside check that the two agree. Basin SQL has no Worker binding:
// it's a fetch with a read-only, account-scoped token (Basin SQL Read, Basin Catalog Read, R2 Storage
// Read), which the app Worker does not hold.

export const TABLE = 'telemetry.runs_v1'

/** Cost per seat for a month ('2026-11'), each run counted once (a resend can deliver a row twice). */
export function costPerSeatSql(period: string) {
  if (!/^\d{4}-\d{2}$/.test(period)) throw new Error('period is YYYY-MM')
  const [year, month] = period.split('-').map(Number)
  const next = month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`
  return `SELECT seat, count(DISTINCT id) AS runs, sum(cost) AS cost FROM (SELECT DISTINCT id, seat, cost FROM ${TABLE} WHERE ended >= '${period}-01T00:00:00Z' AND ended < '${next}-01T00:00:00Z') GROUP BY seat ORDER BY seat LIMIT 1000`
}

export type BasinResult = { rows: Record<string, unknown>[]; ms: number; raw: unknown }

/** Run one Basin SQL query over REST. */
export async function basinQuery(options: { account: string; bucket: string; token: string; sql: string }): Promise<BasinResult> {
  const started = Date.now()
  const response = await fetch(`https://api.sql.cloudflarestorage.com/api/v1/accounts/${options.account}/basin-sql/query/${options.bucket}`, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + options.token, 'content-type': 'application/json' },
    body: JSON.stringify({ query: options.sql }),
  })
  const raw = (await response.json()) as { success?: boolean; errors?: unknown; result?: { rows?: Record<string, unknown>[] } }
  if (!response.ok || raw.success === false) throw new Error('Basin SQL ' + response.status + ': ' + JSON.stringify(raw.errors ?? raw))
  return { rows: raw.result?.rows ?? [], ms: Date.now() - started, raw }
}
