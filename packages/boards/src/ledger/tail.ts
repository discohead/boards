// A tail expression, as a person types it after 'boards tail': a channel (or a subtree, x/) and the
// shared filters. What a watcher's config names.
import { badRequest } from '../errors.ts'
import type { Filters } from './messages.ts'

export type Tail = Filters & { all?: boolean }

function words(input: string): string[] {
  const out: string[] = []
  let current = ''
  let quote: string | null = null
  let started = false
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!
    if (quote) {
      if (char === quote) quote = null
      else if (char === '\\' && quote === '"' && i + 1 < input.length) current += input[++i]
      else current += char
    } else if (char === '"' || char === "'") (quote = char), (started = true)
    else if (char === '\\' && i + 1 < input.length) (current += input[++i]), (started = true)
    else if (/\s/.test(char)) {
      if (started) out.push(current), (current = ''), (started = false)
    } else (current += char), (started = true)
  }
  if (quote) throw badRequest('tail: a quote is never closed')
  if (started) out.push(current)
  return out
}

export function parseTail(expression: string): Tail {
  const out: Tail = {}
  const parts = words(expression)
  const labels: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    const value = () => {
      const next = parts[++i]
      if (next === undefined) throw badRequest('tail: ' + part + ' needs a value')
      return next
    }
    switch (part) {
      case '--re': out.re = value(); break
      case '--by': out.by = value().replace(/^@/, ''); break
      case '--mentions': out.mentions = value().replace(/^@/, ''); break
      case '--label': labels.push(value()); break
      case '--source': case '--from': out.from = value(); break
      case '--text': out.text = value(); break
      case '--all': out.all = true; break
      case '--after': throw badRequest("tail: --after isn't a filter")
      default:
        if (part.startsWith('--')) throw badRequest('tail: unknown flag ' + part)
        if (out.channel !== undefined) throw badRequest('tail: one channel at most')
        out.channel = part
    }
  }
  if (labels.length) out.label = labels
  return out
}
