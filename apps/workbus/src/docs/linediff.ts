// A line diff for a doc's history: the longest common subsequence of lines, as kept, added, and
// removed runs. Sections are small (a section, not a body), so the quadratic table is fine.
export type DiffLine = { kind: 'same' | 'added' | 'removed'; text: string }

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.replace(/\n$/, '').split('\n')
  const b = after.replace(/\n$/, '').split('\n')
  const n = a.length
  const m = b.length
  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) out.push({ kind: 'same', text: a[i++]! }), j++
    else if (table[i + 1]![j]! >= table[i]![j + 1]!) out.push({ kind: 'removed', text: a[i++]! })
    else out.push({ kind: 'added', text: b[j++]! })
  }
  while (i < n) out.push({ kind: 'removed', text: a[i++]! })
  while (j < m) out.push({ kind: 'added', text: b[j++]! })
  return out
}
