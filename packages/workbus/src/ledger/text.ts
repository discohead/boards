// What a message's text says, as the board reads it: its mentions, its blocks, and its emoji names.

const NAME = '[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?'
const EXACT = /(?<![\w@.-])@\[([^\]\s]+)\]/g
const HANDLE = new RegExp('(?<![\\w@.-])@(' + NAME + '(?:/' + NAME + ')?)(?!:\\S|[a-z0-9_/-]|\\.(?=[a-z0-9]))', 'gi')
const FENCED = /\u0060\u0060\u0060[\s\S]*?\u0060\u0060\u0060/g
const INLINE = /\u0060[^\u0060\n]*\u0060/g

/** Text with code (fenced, inline) and blocks blanked, so only prose is read for mentions. */
export function prose(text: string): string {
  let out = text.replace(FENCED, (span) => ' '.repeat(span.length)).replace(INLINE, (span) => ' '.repeat(span.length))
  if (out.includes('json#')) for (const block of findBlocks(text)) out = out.slice(0, block.start) + ' '.repeat(block.end - block.start) + out.slice(block.end)
  return out
}

export type Token = { kind: 'exact' | 'handle'; value: string; written: string }

/** Each mention in prose, deduplicated by kind and value, in text order. */
export function mentionTokens(text: string): Token[] {
  const body = prose(text)
  const out: Token[] = []
  const seen = new Set<string>()
  for (const match of body.matchAll(EXACT)) {
    const key = 'exact\u0000' + match[1]
    if (!seen.has(key)) seen.add(key), out.push({ kind: 'exact', value: match[1]!, written: match[0] })
  }
  const blanked = body.replace(EXACT, (span) => ' '.repeat(span.length))
  for (const match of blanked.matchAll(HANDLE)) {
    const value = match[1]!.toLowerCase()
    const key = 'handle\u0000' + value
    if (!seen.has(key)) seen.add(key), out.push({ kind: 'handle', value, written: match[0] })
  }
  return out
}

/** A filter term: an actor ID (it has a ':') as written, anything else lowercased. */
export const term = (value: string) => (value.includes(':') ? value : value.toLowerCase())
export const under = (name: string) => (name.includes(':') ? name + '+' : term(name) + '/')
export const isEmail = (value: string) => /^[^\s@:]+@[^\s@:]+$/.test(value)

/** The terms the mentions filter matches against. */
export const mentionTerms = (text: string): string[] => [...new Set(mentionTokens(text).map((token) => term(token.value)))]

/** Rewrites each settled handle to @[actor-id], everywhere it occurs in prose. */
export function rewriteHandles(text: string, settled: Map<string, string>): string {
  if (settled.size === 0) return text
  const body = prose(text).replace(EXACT, (span) => ' '.repeat(span.length))
  let out = ''
  let at = 0
  for (const match of body.matchAll(HANDLE)) {
    const id = settled.get(match[1]!.toLowerCase())
    if (!id) continue
    out += text.slice(at, match.index!) + '@[' + id + ']'
    at = match.index! + match[0].length
  }
  return out + text.slice(at)
}

// Blocks: data in a message, a JSON object in a fence whose info string names its schema.

export type FoundBlock = { id: string; source: string; start: number; end: number; problem: string | null; data: Record<string, unknown> | null; schema: string | null; version: number | null }

const OPEN = /^( {0,3})(\u0060{3,}|~{3,})(.*)$/
const QUOTE = /^ {0,3}>[ \t]?/
const ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?: {1,4}|\t|$)/
const SCHEMA_ID = /^([a-z][a-z0-9._-]{0,79})@([1-9][0-9]{0,4})$/

/** The blocks in a text: top-level json# fences only, as the protocol reads them. */
export function findBlocks(text: string): FoundBlock[] {
  const lines = text.split('\n')
  const out: FoundBlock[] = []
  let offset = 0
  let inContainer = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r$/, '')
    const lineStart = offset
    offset += lines[i]!.length + 1
    if (QUOTE.test(line) || ITEM.test(line)) {
      inContainer = true
      continue
    }
    if (line.trim() === '') inContainer = false
    if (inContainer && !OPEN.test(line)) continue
    const open = OPEN.exec(line)
    if (!open || inContainer) continue
    const marker = open[2]!
    const info = open[3]!.trim()
    if (marker[0] === '\u0060' && info.includes('\u0060')) continue
    const close = new RegExp('^ {0,3}' + (marker[0] === '\u0060' ? '\u0060' : '~') + '{' + marker.length + ',}[ \\t]*$')
    let j = i + 1
    let endOffset = offset
    let closed = false
    const body: string[] = []
    for (; j < lines.length; j++) {
      const inner = lines[j]!.replace(/\r$/, '')
      if (close.test(inner)) {
        closed = true
        endOffset += inner.length
        break
      }
      body.push(inner)
      endOffset += lines[j]!.length + 1
    }
    const isBlock = /^json#(\S*)/.exec(info)
    if (isBlock) {
      const id = isBlock[1]!
      const source = body.join('\n')
      let problem: string | null = null
      let data: Record<string, unknown> | null = null
      const named = SCHEMA_ID.exec(id)
      if (!named) problem = (id || 'json#') + ' names no schema: one is name@version, like sandbox@1'
      else if (!closed) problem = 'the ' + id + " block's fence never closes"
      else {
        try {
          const parsed = JSON.parse(source)
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) problem = 'the ' + id + " block isn't a JSON object"
          else data = parsed as Record<string, unknown>
        } catch {
          problem = 'the ' + id + " block isn't JSON"
        }
      }
      out.push({ id, source, start: lineStart, end: closed ? endOffset : text.length, problem, data, schema: named ? named[1]! : null, version: named ? Number(named[2]) : null })
    }
    // Inside a fence nothing opens: skip past it.
    offset = closed ? endOffset + 1 : text.length + 1
    i = closed ? j : lines.length
  }
  return out
}

// Emoji: stored as sent, grouped in views under a canonical name.
const ALIASES: Record<string, string> = {
  '+1': 'thumbs_up', thumbsup: 'thumbs_up', '-1': 'thumbs_down', thumbsdown: 'thumbs_down',
  white_check_mark: 'check', heavy_check_mark: 'check', heavy_multiplication_x: 'x',
  tada: 'party', partying_face: 'party', laughing: 'laugh', satisfied: 'laugh', joy: 'laugh',
  slightly_smiling_face: 'smile', white_frowning_face: 'sad', sob: 'cry', zap: 'lightning', bulb: 'lightbulb', pushpin: 'pin',
  heart_eyes: 'love', red_heart: 'heart', fire: 'fire', eyes: 'eyes', rocket: 'rocket', warning: 'warning', thinking_face: 'thinking',
}
export const canonicalEmoji = (name: string) => ALIASES[name] ?? name
