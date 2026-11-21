// Docs: threads whose root holds a Markdown body, read and edited by section.
import { pairs } from '../args.mjs'
import { CHANNEL, idOf, looksLikeId, required, textOf } from '../common.mjs'
import { misuse } from '../failure.mjs'
import { columns, fitted, oneLine, when } from '../format.mjs'

/** A doc's ID, from its ID (12, #12) or its path (docs/runbooks/deploy). */
async function docId(ctx, target, command) {
  required(target, 'a doc: its path (docs/runbooks/deploy) or its ID', command)
  if (looksLikeId(target)) return idOf(target)
  const found = await ctx.board().request("couldn't find the doc at " + target, 'GET', '/docs', { query: { path: target, depth: 1 } })
  return found.doc.id
}

function splitPath(path, command) {
  const at = path.lastIndexOf('/')
  const channel = path.slice(0, at)
  const slug = path.slice(at + 1)
  if (at <= 0 || !CHANNEL.test(channel) || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(slug)) throw misuse('invalid_path', command + ' names a doc by its path, a channel and a slug: docs/runbooks/deploy, not ' + path, [['wb', ...command.split(' ').slice(1), '--help']])
  return { channel, slug }
}

const outline = (doc) => columns(doc.sections.map((section) => ['  '.repeat(section.level - 1) + section.key, section.title, 'changed ' + section.changed]), '  ')

const read = {
  usage: [
    'wb doc read <path|id> [--section <key>] [--revision <r>] [--outline]',
    '',
    "Print a doc's body, or one section of it. --outline prints its sections",
    'instead, each with its key and the revision it last changed.',
  ].join('\n'),
  flags: { section: 'string', revision: 'string', outline: 'bool' },
  async run(ctx) {
    const target = ctx.positionals[0]
    const id = await docId(ctx, target, 'wb doc read')
    const answer = await ctx.board().request("couldn't read " + target, 'GET', '/docs/' + encodeURIComponent(id), { query: { section: ctx.flags.section, revision: ctx.flags.revision, depth: ctx.flags.outline ? 6 : undefined } })
    if (ctx.json) return ctx.emit(answer)
    if (ctx.flags.outline) return ctx.print([answer.doc.path + '  revision ' + answer.doc.revision + '  ' + answer.doc.title, '', ...outline(answer.doc)])
    if (answer.section) return void process.stdout.write(answer.section.text + answer.section.subtree)
    process.stdout.write(answer.body.endsWith('\n') ? answer.body : answer.body + '\n')
  },
}

const create = {
  usage: [
    'wb doc create <channel>/<slug> [<body|->] [--from <path|id>] [--label k=v]...',
    '',
    'Make a doc from its body (or - to read it from stdin), or from another doc',
    'as a template with --from, which fills {{title}}, {{author}}, and {{date}}.',
  ].join('\n'),
  flags: { from: 'string', label: 'list' },
  async run(ctx) {
    const path = required(ctx.positionals[0], 'the new doc\'s path: docs/runbooks/deploy', 'wb doc create', { exact: true })
    const { channel, slug } = splitPath(path, 'wb doc create', { exact: true })
    const labels = pairs(ctx.flags.label, '--label')
    const words = ctx.positionals.slice(1)
    const from = ctx.flags.from ? await docId(ctx, ctx.flags.from, 'wb doc create') : undefined
    if (from && words.length) throw misuse('invalid_flag', 'a doc starts from its body or from --from, not both', [['wb', 'doc', 'create', '--help']])
    const body = from ? undefined : await textOf(ctx, words, 'the body', 'wb doc create', { exact: true })
    const answer = await ctx.board().request("couldn't create " + path, 'POST', '/docs', { body: { channel, slug, ...(body !== undefined ? { body } : { from }), ...(Object.keys(labels).length ? { labels } : {}) } })
    if (ctx.json) return ctx.emit(answer)
    const doc = answer.message.doc
    ctx.print(['made ' + doc.path + '  #' + doc.id + '  revision ' + doc.revision, ...(doc.sections.length ? ['', ...outline(doc)] : [])])
  },
}

const edit = {
  usage: [
    'wb doc edit <path|id> --section <key> [<text|->] [--title <t>] [--subtree]',
    'wb doc edit <path|id> --after <key> <text|->     (text starts with its heading)',
    'wb doc edit <path|id> --remove <key>',
    'wb doc edit <path|id> --body [<text|->] [--merge]',
    '                [--revision <r>] [--propose [--note <why>]]',
    '',
    "Change a section's own text, insert or remove a section, or replace the whole",
    'body. --revision is the revision you read: a section changed since then is',
    'refused instead of overwritten (without it, the revision is read now).',
    '--propose asks for the change as a task, for whoever may edit, to apply.',
  ].join('\n'),
  flags: { section: 'string', after: 'string', remove: 'string', title: 'string', subtree: 'bool', body: 'bool', merge: 'bool', revision: 'string', propose: 'bool', note: 'string' },
  async run(ctx) {
    const target = ctx.positionals[0]
    const id = await docId(ctx, target, 'wb doc edit')
    const words = ctx.positionals.slice(1)
    const modes = ['section', 'after', 'remove', 'body'].filter((mode) => ctx.flags[mode] !== undefined && ctx.flags[mode] !== false)
    if (modes.length !== 1) throw misuse('invalid_flag', 'say what to change: one of --section, --after, --remove, or --body', [['wb', 'doc', 'edit', '--help']])
    const revision = ctx.flags.revision ?? (await ctx.board().request("couldn't read " + target, 'GET', '/docs/' + encodeURIComponent(id), { query: { depth: 1 } })).doc.revision
    let input
    if (ctx.flags.body) input = { revision, body: await textOf(ctx, words, 'the new body', 'wb doc edit', { exact: true }), ...(ctx.flags.merge ? { merge: true } : {}) }
    else if (ctx.flags.remove !== undefined) input = { revision, edits: [{ remove: ctx.flags.remove }] }
    else if (ctx.flags.after !== undefined) input = { revision, edits: [{ after: ctx.flags.after, text: await textOf(ctx, words, "the new section, starting with its heading", 'wb doc edit', { exact: true }) }] }
    else {
      const text = words.length || !ctx.flags.title ? await textOf(ctx, words, "the section's new text", 'wb doc edit', { exact: true }) : undefined
      input = { revision, edits: [{ section: ctx.flags.section, ...(text !== undefined ? { text } : {}), ...(ctx.flags.title ? { title: ctx.flags.title } : {}), ...(ctx.flags.subtree ? { subtree: true } : {}) }] }
    }
    if (ctx.flags.propose) input = { ...input, propose: true, ...(ctx.flags.note ? { note: ctx.flags.note } : {}) }
    const answer = await ctx.board().request("couldn't edit " + target, 'POST', '/docs/' + encodeURIComponent(id) + '/edit', { body: input })
    if (ctx.json) return ctx.emit(answer)
    if (answer.proposal) return ctx.print(['proposed as task #' + answer.proposal.id + '  in ' + answer.proposal.channel])
    ctx.print([(answer.merged ? 'merged into ' : 'edited ') + answer.doc.path + '  revision ' + answer.revision])
  },
}

const history = {
  usage: 'wb doc history <path|id> [--after <r>] [--limit <n>]\n\nThe edits to a doc, oldest first: revision, when, who, which sections.',
  flags: { after: 'string', limit: 'string' },
  async run(ctx) {
    const id = await docId(ctx, ctx.positionals[0], 'wb doc history')
    const answer = await ctx.board().request("couldn't read the history of " + ctx.positionals[0], 'GET', '/docs/' + encodeURIComponent(id) + '/history', { query: { after: ctx.flags.after, limit: ctx.flags.limit } })
    if (ctx.json) return ctx.emit(answer)
    ctx.print(fitted(answer.edits.map((entry) => [entry.revision, when(entry.at), entry.by?.actor ?? '-', entry.kind === 'created' ? 'created' : entry.sections.map((change) => change.op + ' ' + change.section).join(', ') + (entry.proposedBy ? '  (proposed by ' + entry.proposedBy + ')' : '')])))
  },
}

const diff = {
  usage: 'wb doc diff <path|id> --from <r> [--to <r>]\n\nThe sections that changed between two revisions (--to: now).',
  flags: { from: 'string', to: 'string' },
  async run(ctx) {
    const id = await docId(ctx, ctx.positionals[0], 'wb doc diff')
    const from = required(ctx.flags.from, '--from <revision>', 'wb doc diff')
    const answer = await ctx.board().request("couldn't diff " + ctx.positionals[0], 'GET', '/docs/' + encodeURIComponent(id) + '/diff', { query: { from, to: ctx.flags.to } })
    if (ctx.json) return ctx.emit(answer)
    const lines = [answer.from + ' to ' + answer.to]
    for (const section of answer.sections) {
      lines.push('', section.change + ' ' + section.section)
      if (section.before !== undefined) lines.push(...section.before.trimEnd().split('\n').map((line) => '  - ' + line))
      if (section.after !== undefined) lines.push(...section.after.trimEnd().split('\n').map((line) => '  + ' + line))
    }
    ctx.print(lines)
  },
}

const move = {
  usage: 'wb doc move <path|id> <channel>/<slug>\n\nMove a doc. Its ID, its comments, and every link to it come along.',
  flags: {},
  async run(ctx) {
    const id = await docId(ctx, ctx.positionals[0], 'wb doc move')
    const to = splitPath(required(ctx.positionals[1], 'where to: docs/ops/shipping', 'wb doc move'), 'wb doc move')
    const answer = await ctx.board().request("couldn't move " + ctx.positionals[0], 'POST', '/docs/' + encodeURIComponent(id) + '/move', { body: to })
    if (ctx.json) return ctx.emit(answer)
    ctx.print(['moved to ' + answer.doc.path])
  },
}

const backlinks = {
  usage: 'wb doc backlinks <path|id>\n\nThe threads, replies, and docs that link a doc.',
  flags: {},
  async run(ctx) {
    const id = await docId(ctx, ctx.positionals[0], 'wb doc backlinks')
    const answer = await ctx.board().request("couldn't read the backlinks of " + ctx.positionals[0], 'GET', '/docs/' + encodeURIComponent(id) + '/backlinks')
    if (ctx.json) return ctx.emit(answer)
    if (answer.backlinks.length === 0) return ctx.print(['nothing links it'])
    ctx.print(fitted(answer.backlinks.map((link) => ['#' + link.id, link.kind, link.path ?? link.channel, oneLine(link.summary)])))
  },
}

const SUBCOMMANDS = { read, create, edit, history, diff, move, backlinks }

export const doc = {
  usage: [
    'wb doc <subcommand> ...',
    '',
    '  read, create, edit, history, diff, move, backlinks',
    '',
    'A doc is a thread whose root holds a Markdown body, named by its path',
    '(docs/runbooks/deploy) or its ID. wb doc <subcommand> --help says more.',
  ].join('\n'),
  pick(positionals) {
    const name = positionals[0]
    if (name && Object.hasOwn(SUBCOMMANDS, name)) return { command: SUBCOMMANDS[name], name: 'doc ' + name, rest: 1 }
    return { command: { usage: doc.usage, flags: {}, async run() { throw misuse('missing_subcommand', 'wb doc needs a subcommand: ' + Object.keys(SUBCOMMANDS).join(', '), [['wb', 'doc', '--help']]) } }, name: 'doc', rest: 0 }
  },
}

export const docs = {
  usage: 'wb docs [<channel>|<prefix/>] [--label k=v]... [--limit <n>]\n\nThe docs you can read, most recently changed last.',
  flags: { label: 'list', limit: 'string' },
  async run(ctx) {
    const where = ctx.positionals[0]
    const labels = Object.entries(pairs(ctx.flags.label, '--label')).map(([key, value]) => key + '=' + value)
    const query = new URLSearchParams()
    query.append('label', 'board.doc')
    for (const label of labels) query.append('label', label)
    if (where) query.set('channel', where)
    if (ctx.flags.limit) query.set('limit', ctx.flags.limit)
    const page = await ctx.board().request("couldn't list docs", 'GET', '/threads?' + query.toString())
    if (ctx.json) return ctx.emit({ docs: page.threads.map((thread) => thread.message.doc) })
    const rows = page.threads.slice().reverse().map((thread) => thread.message).map((message) => [message.doc.path, 'revision ' + message.doc.revision, when(message.editedAt ?? message.createdAt), message.doc.title])
    ctx.print(rows.length ? fitted(rows) : ['no docs'])
  },
}
