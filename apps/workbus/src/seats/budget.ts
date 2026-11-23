// A seat's budget (design/workbus.md §5.6), as pure decisions the Seat acts on: when its spend this
// period crosses alert × month it holds one task for the principal (kind budget), once per period;
// at the limit it stops starting runs (over_budget) and holds another, which a raised budget or a
// new period closes. Kept apart from the Durable Object so scripts/seat-check.ts runs it in node.

export type BudgetKind = 'alert' | 'limit'
/** The budget tasks a seat holds in one period, by kind, and whether each is still open. */
export type BudgetTasks = { period: string; alert?: { task: string; open: boolean }; limit?: { task: string; open: boolean } }
export type BudgetStep = { hold: BudgetKind } | { close: BudgetKind; why: string } | null

/** The calendar month, in UTC, a time falls in: the budget period (telemetry/totals.ts's periodOf). */
export const periodOf = (at: number) => new Date(at).toISOString().slice(0, 7)
/** When the period after this one starts, in ms: when an over-budget seat may run again on its own. */
export function nextPeriod(at: number): number {
  const date = new Date(at)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)
}
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
export const monthName = (period: string) => MONTHS[Number(period.slice(5, 7)) - 1] + ' ' + period.slice(0, 4)
export const usd = (cost: number) => '$' + (cost < 1 ? cost.toFixed(4).replace(/0{1,2}$/, '') : cost.toFixed(2))

/**
 * What to do now, one step at a time (the Seat asks again after each): close a limit task the
 * budget no longer calls for, hold the limit task at the limit, or the alert task past the alert.
 * Each kind is held at most once per period; a new period starts with none.
 */
export function budgetStep(spend: number, budget: { month: number | null; alert: number }, held: BudgetTasks, period: string): BudgetStep {
  if (held.period !== period) return held.limit?.open ? { close: 'limit', why: 'period' } : held.alert?.open ? { close: 'alert', why: 'period' } : null
  const month = budget.month
  if (held.limit?.open && (month === null || spend < month)) return { close: 'limit', why: 'raised' }
  if (month === null) return null
  if (spend >= month && !held.limit) return { hold: 'limit' }
  if (spend >= budget.alert * month && spend < month && !held.alert && !held.limit) return { hold: 'alert' }
  return null
}

/** The held task's text and reason, as the principal reads them in the inbox. */
export function budgetText(kind: BudgetKind, seat: { key: string; name: string }, spend: number, month: number, period: string, waiting: number) {
  const spent = seat.name + ' has spent ' + usd(spend) + ' of its ' + usd(month) + ' budget for ' + monthName(period)
  if (kind === 'alert')
    return {
      text: spent + ' (' + Math.round((spend / month) * 100) + '%).',
      reason: spent + '. It goes on running until the limit: raise budget.month in org/seats/' + seat.key + ' if it needs more.',
    }
  return {
    text: spent + ', its limit, and has stopped starting runs' + (waiting ? ' (' + waiting + (waiting === 1 ? ' wake-up waits' : ' wake-ups wait') + ')' : '') + '.',
    reason: 'Raise budget.month in org/seats/' + seat.key + ' to let it run again, or leave it until ' + monthName(periodOf(nextPeriod(Date.parse(period + '-01T00:00:00Z')))) + ', when its budget starts over.',
  }
}
