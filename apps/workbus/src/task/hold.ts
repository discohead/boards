// A live list that never moves what the principal is on (design/workbus.md §9.3). The rows re-sort
// as the board changes, except the selected one: it stays in the group, and at the place in it,
// where it was until the selection moves. A selected row that has left the list (finished, say,
// under an open filter) stays too, until then.

export type Placed = { key: string; group: string }

/**
 * next, with `selected` put back where it was in `shown` (its group, and its index in that group,
 * at most the group's end). `keep` is the selected row as it is now, for a row next lacks.
 */
export function holdSelected<T extends Placed>(shown: readonly Placed[], next: readonly T[], selected: string | null, keep?: T): T[] {
  if (selected === null) return [...next]
  const before = shown.findIndex((row) => row.key === selected)
  if (before < 0) return [...next]
  const was = shown[before]!
  const index = shown.slice(0, before).filter((row) => row.group === was.group).length
  const row = next.find((one) => one.key === selected) ?? keep
  if (!row) return [...next]
  const rest = next.filter((one) => one.key !== selected)
  const held = { ...row, group: was.group }
  // Into its old group at its old index in it, or at the group's end; a group that's gone comes back where it was.
  const members = rest.map((one, at) => [one, at] as const).filter(([one]) => one.group === was.group)
  let at: number
  if (members.length === 0) {
    const groupsBefore = new Set(shown.slice(0, before).map((one) => one.group))
    const lastBefore = rest.reduce((last, one, i) => (groupsBefore.has(one.group) ? i : last), -1)
    at = lastBefore + 1
  } else at = index < members.length ? members[index]![1] : members[members.length - 1]![1] + 1
  return [...rest.slice(0, at), held, ...rest.slice(at)]
}
