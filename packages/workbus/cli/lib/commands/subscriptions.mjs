// Subscriptions: registered watchers the board delivers to a service sink its deployment declares
// (design/registered-watchers.md). wb subscribes as the token, its --as profile, and its narrowing.
import { misuse } from '../failure.mjs'
import { columns, when } from '../format.mjs'
import { required } from '../common.mjs'

const NAMED = ['mention', 'follow', 'assigned', 'dm', 'schedules']

/** A rule as wb takes it: mention, follow, assigned, dm, schedules, ready=<channel>, docs=<channel>, tail=<expression>. */
function ruleOf(text) {
  if (NAMED.includes(text)) return text
  const eq = text.indexOf('=')
  const kind = eq < 0 ? text : text.slice(0, eq)
  const value = eq < 0 ? '' : text.slice(eq + 1)
  if ((kind === 'ready' || kind === 'docs') && value) return { [kind]: value }
  if (kind === 'tail') return { tail: value }
  throw misuse('invalid_rule', 'a rule is ' + NAMED.join(', ') + ', ready=<channel>, docs=<channel>, or tail=<expression>, not ' + text, [['wb', 'subscribe', '--help']])
}

/** Rules by id: [id:]rule, the id its kind when none is given (ready, ready-2, ...). */
function rulesOf(list) {
  const rules = {}
  for (const item of list ?? []) {
    const named = /^([A-Za-z][A-Za-z0-9-]{0,31}):(.+)$/.exec(item)
    const rule = ruleOf(named ? named[2] : item)
    let id = named ? named[1] : typeof rule === 'string' ? rule : Object.keys(rule)[0]
    if (!named) for (let n = 2; Object.hasOwn(rules, id); n++) id = id.replace(/-\d+$/, '') + '-' + n
    rules[id] = rule
  }
  return rules
}

const ruleText = (rule) => (typeof rule === 'string' ? rule : Object.entries(rule).map(([k, v]) => (v === true ? k : k + '=' + v)).join(''))

function block(sub) {
  return [
    sub.key + '  ' + sub.actor + ' -> ' + sub.sink + (sub.revision !== null ? '  revision ' + sub.revision : ''),
    ...columns(Object.entries(sub.rules).map(([id, rule]) => [id, ruleText(rule)]), '  '),
    ...(sub.can ? ['  narrowed to ' + sub.can] : []),
    '  changed ' + when(sub.updatedAt),
  ]
}

const revisionOf = (value) => {
  if (value === undefined) return undefined
  if (!/^\d{1,15}$/.test(value)) throw misuse('invalid_flag', '--revision takes a whole number, not ' + value)
  return Number(value)
}

const subscribe = {
  usage: [
    'wb subscribe <key> --sink <name> --rule <rule>... [--revision <n>] [--as <profile>]',
    '',
    'Subscribe as yourself (your --as profile too) to a sink the board\'s',
    'deployment declares: the board delivers each event your rules match there, in order',
    'per thread. The same key again replaces it; an older --revision changes nothing.',
    '',
    'rule  mention, follow, assigned, dm, schedules, ready=<channel>, docs=<channel>,',
    '      or tail=<expression>; name one with id:rule (queue:ready=work/)',
  ].join('\n'),
  flags: { sink: 'string', rule: 'list', revision: 'string' },
  async run(ctx) {
    const key = required(ctx.positionals[0], 'a key', 'wb subscribe')
    const sink = required(ctx.flags.sink, 'a --sink', 'wb subscribe')
    const rules = rulesOf(ctx.flags.rule)
    if (!Object.keys(rules).length) throw misuse('missing_rule', 'wb subscribe needs at least one --rule, like --rule mention', [['wb', 'subscribe', '--help']])
    const revision = revisionOf(ctx.flags.revision)
    const answer = await ctx.board().request("couldn't subscribe " + key, 'POST', '/subscriptions', { body: { key, sink, rules, ...(revision !== undefined ? { revision } : {}) } })
    if (ctx.json) return ctx.emit(answer)
    const said = answer.stale ? 'unchanged (revision ' + answer.subscription.revision + ' is newer)' : answer.created ? 'subscribed' : answer.changed ? 'changed' : 'unchanged'
    ctx.print([said + ' ' + block(answer.subscription)[0], ...block(answer.subscription).slice(1)])
  },
}

const unsubscribe = {
  usage: 'wb unsubscribe <key> [--revision <n>]\n\nRemove a subscription, unless --revision is older than the one it holds.',
  flags: { revision: 'string' },
  async run(ctx) {
    const key = required(ctx.positionals[0], 'a key', 'wb unsubscribe')
    const revision = revisionOf(ctx.flags.revision)
    const answer = await ctx.board().request("couldn't unsubscribe " + key, 'POST', '/subscriptions/' + encodeURIComponent(key) + '/delete', { body: revision !== undefined ? { revision } : {} })
    if (ctx.json) return ctx.emit({ key, ...answer })
    ctx.print([answer.removed ? 'unsubscribed ' + key : answer.stale ? key + ' holds a newer revision: kept' : 'no subscription ' + key])
  },
}

const list = {
  usage: 'wb subscriptions [--prefix <key prefix>]\n\nYour principal\'s subscriptions (every one, with manage at *).',
  flags: { prefix: 'string' },
  async run(ctx) {
    const answer = await ctx.board().request("couldn't list subscriptions", 'GET', '/subscriptions', { query: { prefix: ctx.flags.prefix } })
    if (ctx.json) return ctx.emit({ subscriptions: answer.subscriptions })
    if (!answer.subscriptions.length) return ctx.print(['no subscriptions'])
    const lines = []
    for (const sub of answer.subscriptions) lines.push(...(lines.length ? [''] : []), ...block(sub))
    ctx.print(lines)
  },
}

export const subscriptions = list
export { subscribe, unsubscribe }
