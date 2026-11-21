// Grants: who may do what in which channels, beyond the board's own people.
import { misuse } from '../failure.mjs'
import { columns, when } from '../format.mjs'
import { required } from '../common.mjs'

const PERMISSIONS = ['read', 'post', 'react', 'label', 'edit', 'sync', 'manage']

/** A principal in a few words: user ada, github acme/web, everyone. */
function principalText(p) {
  switch (p.kind) {
    case 'user':
      return 'user ' + (p.email ?? p.userId)
    case 'github':
      return 'github ' + p.repository + [p.workflow && 'workflow ' + p.workflow, p.branch && 'branch ' + p.branch, p.event && 'event ' + p.event].filter(Boolean).map((part) => ' ' + part).join('')
    case 'oidc':
      return 'oidc ' + p.issuer + ' ' + Object.entries(p.claims ?? {}).map(([k, v]) => k + '=' + [].concat(v).join('|')).join(' ')
    case 'all-users':
      return 'all users'
    case 'all-apps':
      return 'all apps'
    case 'everyone':
      return 'everyone'
    default: {
      const main = Object.entries(p).find(([key, value]) => key !== 'kind' && typeof value === 'string')
      const envs = Array.isArray(p.environments) ? ' (' + p.environments.join(', ') + ')' : ''
      return p.kind.replace(/-/g, ' ') + (main ? ' ' + main[1] : '') + envs
    }
  }
}

const canText = (permissions) => (permissions === 'all' ? 'all' : permissions.length ? permissions.join(', ') : 'nothing')

function grantBlock(grant) {
  const lines = [grant.id + '  ' + grant.principals.map(principalText).join(', ')]
  lines.push(...columns(Object.entries(grant.can).map(([pattern, permissions]) => [pattern, canText(permissions)]), '  '))
  if (grant.by) lines.push('  changed by ' + grant.by + ' ' + when(grant.at))
  return lines
}

/** The principals the flags name, in the order they were given. */
function principalsOf(ctx, argv) {
  const out = []
  let lastGithub = null
  let lastOidc = null
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const [flag, inline] = arg.startsWith('--') ? [arg.slice(2).split('=')[0], arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : undefined] : [null]
    const take = () => inline ?? argv[++i]
    switch (flag) {
      case 'user': {
        const who = take()
        out.push(who.includes('@') ? { kind: 'user', email: who } : { kind: 'user', userId: who })
        break
      }
      case 'github':
        out.push((lastGithub = { kind: 'github', repository: take() }))
        break
      case 'workflow':
      case 'branch':
      case 'event':
        if (!lastGithub) throw misuse('invalid_flag', '--' + flag + ' goes after the --github it narrows', [['boards', 'grants', 'create', '--help']])
        lastGithub[flag] = take()
        break
      case 'oidc':
        out.push((lastOidc = { kind: 'oidc', issuer: take(), claims: {} }))
        break
      case 'claim': {
        if (!lastOidc) throw misuse('invalid_flag', '--claim goes after the --oidc issuer it narrows', [['boards', 'grants', 'create', '--help']])
        const pair = take()
        const eq = pair.indexOf('=')
        if (eq <= 0) throw misuse('invalid_flag', '--claim takes name=value, not ' + pair)
        const [name, value] = [pair.slice(0, eq), pair.slice(eq + 1)]
        lastOidc.claims[name] = lastOidc.claims[name] === undefined ? value : [].concat(lastOidc.claims[name], value)
        break
      }
      case 'app':
        out.push({ kind: 'app', app: take() })
        break
      case 'all-users':
        out.push({ kind: 'all-users' })
        break
      case 'everyone':
        out.push({ kind: 'everyone' })
        break
      case 'principal': {
        const text = take()
        try {
          out.push(JSON.parse(text))
        } catch {
          throw misuse('invalid_flag', '--principal takes a JSON object, like {"kind":"user","userId":"ada"}')
        }
        break
      }
      default:
        if (flag === 'can' || flag === 'url' || flag === 'token' || flag === 'as') i += inline === undefined ? 1 : 0
    }
  }
  return out
}

/** --can dev/=read,post as { 'dev/': ['read', 'post'] }; all stays all; empty is nothing. */
function canOf(list) {
  const can = {}
  for (const item of list ?? []) {
    const eq = item.lastIndexOf('=')
    if (eq <= 0) throw misuse('invalid_can', '--can takes pattern=permissions, like dev/=read,post or *=all, not ' + item)
    const pattern = item.slice(0, eq).trim()
    const value = item.slice(eq + 1).trim()
    if (value === 'all') can[pattern] = 'all'
    else {
      const permissions = value === '' ? [] : value.split(',').map((p) => p.trim())
      for (const p of permissions) if (!PERMISSIONS.includes(p)) throw misuse('invalid_can', 'unknown permission ' + p + ' in --can: use ' + PERMISSIONS.join(', ') + ', or all')
      can[pattern] = permissions
    }
  }
  return can
}

const create = {
  usage: [
    'boards grants create <who>... --can <pattern=permissions>... [--lock-me-out]',
    '',
    'who   --user <id or email>',
    '      --github <owner/name> [--workflow <w>] [--branch <b>] [--event <e>]',
    '      --oidc <issuer> --claim <name=value>...',
    '      --app <id>, --all-users, --everyone, or --principal <json>',
    'can   a pattern (* every channel, dev one, dev/ it and its subtree) and its',
    '      permissions (read, post, react, label, edit, sync, manage, or all), like',
    '      --can dev/=read,post',
  ].join('\n'),
  flags: { user: 'list', github: 'list', workflow: 'list', branch: 'list', event: 'list', oidc: 'list', claim: 'list', app: 'list', 'all-users': 'bool', everyone: 'bool', principal: 'list', can: 'list', 'lock-me-out': 'bool' },
  async run(ctx) {
    const principals = principalsOf(ctx, ctx.argv)
    if (!principals.length) throw misuse('missing_principal', 'boards grants create needs whom to grant: --user, --github, --oidc, --app, --all-users, or --everyone', [['boards', 'grants', 'create', '--help']])
    const can = canOf(ctx.flags.can)
    if (!Object.keys(can).length) throw misuse('missing_can', 'boards grants create needs --can pattern=permissions, like --can dev/=read,post', [['boards', 'grants', 'create', '--help']])
    const answer = await ctx.board().request("couldn't make the grant", 'POST', '/grants', { body: { principals, can, ...(ctx.flags['lock-me-out'] ? { lockMeOut: true } : {}) } })
    if (ctx.json) return ctx.emit(answer)
    ctx.print(['granted ' + answer.grant.id, ...grantBlock(answer.grant).slice(1)])
  },
}

const revoke = {
  usage: 'boards grants revoke <id> [--lock-me-out]\n\nRevoke a grant: its principals are judged without it from their next request.',
  flags: { 'lock-me-out': 'bool' },
  async run(ctx) {
    const id = required(ctx.positionals[0], 'a grant ID', 'boards grants revoke')
    const answer = await ctx.board().request("couldn't revoke " + id, 'POST', '/grants/' + encodeURIComponent(id) + '/revoke', { body: ctx.flags['lock-me-out'] ? { lockMeOut: true } : {} })
    if (ctx.json) return ctx.emit({ revoked: answer.revoked, id })
    ctx.print([answer.revoked ? 'revoked ' + id : 'no grant ' + id + ' to revoke'])
  },
}

const explain = {
  usage: 'boards grants explain <channel> [--user <id>|--github <owner/name>|--app <id>]\n\nWhat a principal (you, without one) may do in a channel, and which grant\nsays so.',
  flags: { user: 'string', github: 'string', app: 'string', workflow: 'string', branch: 'string', event: 'string' },
  async run(ctx) {
    const channel = required(ctx.positionals[0], 'a channel', 'boards grants explain')
    const answer = await ctx.board().request("couldn't explain " + channel, 'GET', '/grants/explain', {
      query: { channel, user: ctx.flags.user, github: ctx.flags.github, app: ctx.flags.app, workflow: ctx.flags.workflow, branch: ctx.flags.branch, event: ctx.flags.event },
    })
    if (ctx.json) return ctx.emit({ explanation: answer })
    ctx.print(
      columns([
        ['channel', answer.channel],
        ['can', answer.can.length ? answer.can.join(', ') : 'nothing'],
        ['pattern', answer.pattern ?? 'none'],
        ['grants', answer.grants.length ? answer.grants.map((g) => g.id).join(', ') : '-'],
      ]),
    )
  },
}

const list = {
  usage: 'boards grants\n\nThe board\'s grants. Listing them needs manage at *.',
  flags: {},
  async run(ctx) {
    const answer = await ctx.board().request("couldn't list grants", 'GET', '/grants')
    if (ctx.json) return ctx.emit({ grants: answer.grants })
    if (!answer.grants.length) return ctx.print(['no grants'])
    const lines = []
    for (const grant of answer.grants) lines.push(...(lines.length ? [''] : []), ...grantBlock(grant))
    ctx.print(lines)
  },
}

const SUBCOMMANDS = { create, revoke, explain }

export const grants = {
  usage: [list.usage, '', create.usage, '', revoke.usage.split('\n')[0], explain.usage.split('\n')[0]].join('\n'),
  pick(positionals) {
    const name = positionals[0]
    if (name && Object.hasOwn(SUBCOMMANDS, name)) return { command: SUBCOMMANDS[name], name: 'grants ' + name, rest: 1 }
    return { command: list, name: 'grants', rest: 0 }
  },
}
