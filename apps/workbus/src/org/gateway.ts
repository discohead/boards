// The AI Gateway's spend limits per seat, as set on the gateway "workbus" (design/workbus.md §5.6;
// the recipe is in the app's README). The reconciler can't read them (the app holds no Cloudflare
// token), so they're written down here, and a seat whose budget needs more than its backstop is
// flagged in its doc's thread for an owner to add a named rule.
export const GATEWAY_LIMITS = {
  /** seat-any: every seat value, partitioned, over a sliding 31 days. */
  shared: 25,
  /** seat-<key>: named rules, for seats that need a limit of their own. */
  named: { op: 25, ada: 25 } as Record<string, number>,
}

/** The backstop sits a quarter above a seat's monthly budget. */
export const MARGIN = 1.25

/** Why a seat's budget needs a named rule, or null when its backstop covers it. */
export function backstopNeeded(key: string, month: number | null): string | null {
  if (month === null) return null
  const limit = GATEWAY_LIMITS.named[key] ?? GATEWAY_LIMITS.shared
  if (month * MARGIN <= limit) return null
  return 'its budget of $' + month + ' a month needs a gateway backstop of $' + Math.ceil(month * MARGIN) + ', more than the $' + limit + ' its ' + (key in GATEWAY_LIMITS.named ? 'rule seat-' + key : 'shared rule, seat-any,') + ' allows. It runs, and its own budget still stops it, but an owner should add a named rule seat-' + key + ' (see the app\'s README)'
}
