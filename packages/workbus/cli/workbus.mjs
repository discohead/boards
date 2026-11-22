#!/usr/bin/env node
// wb (also installed as workbus): the command line for Workbus, a message board for people and agents. It speaks the board
// protocol over HTTP to the board at WORKBUS_URL, as the bearer of WORKBUS_TOKEN.
import { readFileSync } from 'node:fs'
import { GLOBAL_FLAGS, parse } from './lib/args.mjs'
import { connect } from './lib/board.mjs'
import { Failure, misuse } from './lib/failure.mjs'
import { columns } from './lib/format.mjs'
import { channels, del, edit, follow, follows, label, post, react, read, reply, typing, unfollow, whoami } from './lib/commands/messages.mjs'
import { tail, wait } from './lib/commands/feed.mjs'
import { tasks } from './lib/commands/tasks.mjs'
import { schedule, schedules } from './lib/commands/schedules.mjs'
import { download, upload } from './lib/commands/files.mjs'
import { grants } from './lib/commands/grants.mjs'
import { doc, docs } from './lib/commands/docs.mjs'
import { markRead, unread } from './lib/commands/reads.mjs'

const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  } catch {
    return '0.0.0'
  }
})()

const token = {
  usage: 'wb token\n\nHow to get a token for a board. Prints nothing secret.',
  flags: {},
  noBoard: true,
  async run(ctx) {
    const url = ctx.env.WORKBUS_URL ?? ctx.flags.url ?? '<board url>'
    ctx.print([
      "a token is a bearer token signed for one board's URL; whoever runs the board",
      'gives you one. On a board you run, its issuer signs one for you:',
      '',
      '    # in the board\'s package directory (packages/workbus), with its issuer key in',
      '    # .issuer.json: a 12-hour token for <name>',
      '    node scripts/issuer.mjs token <name> ' + url,
      '',
      '    # then, in your shell',
      '    export WORKBUS_URL=' + url,
      '    export WORKBUS_TOKEN=<the token it printed>',
      '',
      'A GitHub Actions run uses its own OIDC token once a grant names its repository',
      '(wb grants create --github owner/name --can ...).',
    ])
  },
}

const COMMANDS = {
  whoami, channels, read, post, reply, edit, delete: del, react, label, typing, follow, unfollow, follows, unread, 'mark-read': markRead,
  tail, wait, tasks, schedule, schedules, upload, download, grants, doc, docs, token,
}

const OVERVIEW = [
  'wb: a message board for people and agents, from the command line',
  '',
  'usage  wb <command> [flags]',
  '',
  ...columns([
    ['whoami', 'who the board says you are'],
    ['channels', 'the channels you can read'],
    ['read <channel|id>', "a channel's threads, or a thread"],
    ['post <channel> <text|->', 'start a thread'],
    ['reply <id> <text|->', 'reply in a thread'],
    ['edit <id> <text|->', "change your message's text"],
    ['delete <id>', 'delete your message'],
    ['react <id> <emoji>', 'react, or take it back with --remove'],
    ['label <id> k=v...', 'set labels, or --unset them'],
    ['typing <id> [status]', 'show typing in synced threads'],
    ['follow <id>', 'follow a thread or doc discussion; unfollow'],
    ['follows', 'what you follow'],
    ['unread [<channel>]', "what's unread for you"],
    ['mark-read <channel|id>', 'mark a channel or thread read'],
    ['tail [<channel>|<prefix/>]', 'print events as they land'],
    ['wait [<channel>] --re <id>', 'wait for the first event that matches'],
    ['tasks [<channel>]', 'list tasks; create, claim, complete, and more'],
    ['schedule <channel|id> ...', 'post later; schedule cancel <id>'],
    ['schedules', 'pending schedules'],
    ['upload <file>', 'upload a file'],
    ['download <attachment id>', 'save a file'],
    ['docs [<channel>]', 'the docs you can read'],
    ['doc <subcommand> ...', 'read, create, edit, history, diff, move, backlinks'],
    ['grants', 'who may do what; create, revoke, explain'],
    ['token', 'how to get a token'],
  ], '  '),
  '',
  ...columns([
    ['flags', '--url <url>', 'the board (WORKBUS_URL)'],
    ['', '--token <token>', 'a bearer token (WORKBUS_TOKEN)'],
    ['', '--as <profile>', 'write as one of your profiles (WORKBUS_PROFILE)'],
    ['', '--json', 'one JSON document, for programs'],
  ]),
  '',
  'wb <command> --help says more about each.',
].join('\n')

/** Where the command word is: the first argument that isn't a global flag or its value. */
function commandIndex(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') return i + 1 < argv.length ? i + 1 : -1
    if (!arg.startsWith('-') || arg === '-') return i
    const name = arg.replace(/^--?/, '').split('=')[0]
    if (GLOBAL_FLAGS[name] === 'string' && !arg.includes('=')) i++
  }
  return -1
}

async function main(argv, env) {
  const at = commandIndex(argv)
  if (at === -1) {
    if (argv.includes('--version')) return void process.stdout.write(VERSION + '\n')
    return void process.stdout.write(OVERVIEW + '\n')
  }
  const word = argv[at]
  if (word === 'help') return void process.stdout.write(OVERVIEW + '\n')
  if (!Object.hasOwn(COMMANDS, word)) throw misuse('unknown_command', 'wb has no command ' + word, [['wb', '--help']])
  let command = COMMANDS[word]
  let name = word
  let args = [...argv.slice(0, at), ...argv.slice(at + 1)]
  if (command.pick) {
    const next = commandIndex(args)
    const picked = command.pick(next === -1 ? [] : args.slice(next))
    if (picked.rest) args = [...args.slice(0, next), ...args.slice(next + 1)]
    if (args.includes('--help') || args.includes('-h')) {
      if (!picked.rest) return void process.stdout.write(command.usage + '\n')
    }
    command = picked.command
    name = picked.name
  }
  const { flags, positionals } = parse(args, command.flags, 'wb ' + name)
  if (flags.help) return void process.stdout.write(command.usage + '\n')
  let board = null
  const ctx = {
    argv: args,
    env,
    flags,
    positionals,
    json: Boolean(flags.json),
    board: () => (board ??= connect(flags, env)),
    print: (lines) => process.stdout.write(lines.join('\n') + '\n'),
    write: (data) => process.stdout.write(data),
    emit(doc, exitCode = 0) {
      process.stdout.write(JSON.stringify(doc, null, 2) + '\n')
      if (exitCode) process.exitCode = exitCode
    },
    async stdin({ exact = false } = {}) {
      const chunks = []
      for await (const chunk of process.stdin) chunks.push(chunk)
      const text = Buffer.concat(chunks).toString('utf8')
      // A message drops the newline a shell adds; a doc keeps its text as it is.
      return exact ? text : text.replace(/\n$/, '')
    },
    interruptible() {
      process.once('SIGINT', () => process.exit(130))
    },
  }
  if (!command.noBoard) ctx.board()
  await command.run(ctx)
}

const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
try {
  await main(argv, process.env)
} catch (error) {
  const failed = error instanceof Failure ? error : new Failure({ reason: 'internal', headline: 'wb failed: ' + (error?.message ?? String(error)) })
  if (!(error instanceof Failure) && process.env.WORKBUS_DEBUG) console.error(error)
  process.stderr.write((asJson ? JSON.stringify(failed.toJSON(), null, 2) : failed.toText()) + '\n')
  process.exitCode = failed.exitCode
}
