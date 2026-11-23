// Tasks: threads with a state. A claim's token stays in the claims directory, never on screen.
import { count, duration, pairs } from '../args.mjs'
import { channelOf, idOf, looksLikeId, mentionNotes, required, textOf } from '../common.mjs'
import { dropClaim, loadClaim, newToken, saveClaim } from '../claims.mjs'
import { Failure, failure, misuse } from '../failure.mjs'
import { fitted, messageBlock, oneLine, ref, taskState, when, who } from '../format.mjs'
import { uploadFile } from './files.mjs'

const STATES = ['open', 'all', 'waiting', 'ready', 'claimed', 'blocked', 'completed', 'failed', 'canceled']

const leaseOf = (ctx) => (ctx.flags.lease === undefined ? undefined : duration(ctx.flags.lease, '--lease') / 1000)

/** What the board answered for a claim, without its token. */
const shown = (claim) => (claim ? { epoch: claim.epoch, until: claim.until } : claim)

const path = (id, verb) => '/tasks/' + encodeURIComponent(id) + (verb ? '/' + verb : '')

function remember(ctx, id, claim) {
  saveClaim(ctx.env, ctx.board().url, id, ctx.board().profile, claim)
}

/** The claim this machine holds on a task, as this profile. */
function held(ctx, id, verb) {
  const claim = loadClaim(ctx.env, ctx.board().url, id, ctx.board().profile)
  if (!claim)
    throw failure('no_claim', "can't " + verb + ' ' + ref(id) + ': no claim on it is kept here' + (ctx.board().profile ? ' for ' + ctx.board().profile : ''), [
      ['wb', 'tasks', 'claim', id, ...(ctx.board().profile ? ['--as', ctx.board().profile] : [])],
    ])
  return claim
}

/** A write by a claim: a lost claim is forgotten, and said plainly. */
async function byClaim(ctx, id, verb, doing, body = {}) {
  const claim = held(ctx, id, verb)
  try {
    return await ctx.board().request(doing, 'POST', path(id, verb), { body: { epoch: claim.epoch, token: claim.token, ...body } })
  } catch (error) {
    if (error instanceof Failure && error.board?.code === 'claim_lost') {
      dropClaim(ctx.env, ctx.board().url, id, ctx.board().profile)
      throw new Failure({ reason: 'claim_lost', headline: doing + ': the claim is over', origin: 'board', board: error.board, ways: [['wb', 'tasks', 'claim', id]] })
    }
    throw error
  }
}

const list = {
  usage: [
    'wb tasks [<channel>|<prefix/>] [--state <state>] [--label k=v]...',
    '             [--by <who>] [--owner <who>] [--for <actor>] [--needs <id>]',
    '             [--latest] [--limit <n>] [--after <cursor>]',
    '',
    'List tasks, oldest first; --latest lists the last active, latest last. --state',
    'is open (the default), all, waiting, ready, claimed, blocked, completed, failed,',
    'or canceled.',
  ].join('\n'),
  flags: { state: 'string', label: 'list', by: 'string', owner: 'string', for: 'string', needs: 'string', latest: 'bool', limit: 'string', after: 'string' },
  async run(ctx) {
    const target = ctx.positionals[0]
    if (ctx.positionals.length > 1) throw misuse('extra_argument', 'wb tasks takes one channel or prefix', [['wb', 'tasks', '--help']])
    const channel = target === undefined ? undefined : channelOf(target, 'tasks', { subtree: true })
    if (ctx.flags.state && !STATES.includes(ctx.flags.state)) throw misuse('invalid_state', '--state is one of ' + STATES.join(', ') + ', not ' + ctx.flags.state)
    if (ctx.flags.latest && ctx.flags.after) throw misuse('invalid_flag', '--latest reads every task to find the last active: it takes no --after')
    const page = await ctx.board().request("couldn't list tasks", 'GET', '/tasks', {
      query: {
        channel,
        state: ctx.flags.state,
        label: ctx.flags.label,
        by: ctx.flags.by?.replace(/^@/, ''),
        owner: ctx.flags.owner,
        for: ctx.flags.for,
        needs: ctx.flags.needs && idOf(ctx.flags.needs),
        latest: ctx.flags.latest ? 'true' : undefined,
        limit: count(ctx.flags.limit, '--limit'),
        after: ctx.flags.after && idOf(ctx.flags.after),
      },
    })
    if (ctx.json) return ctx.emit({ tasks: page.tasks, cursor: page.cursor })
    if (!page.tasks.length) return ctx.print(['no ' + (ctx.flags.state && ctx.flags.state !== 'all' ? ctx.flags.state + ' ' : ctx.flags.state ? '' : 'open ') + 'tasks' + (channel ? ' in ' + channel : '')])
    const subtree = !channel || channel.endsWith('/')
    ctx.print(fitted(page.tasks.map(({ message }) => [ref(message.id), ...(subtree ? [message.channel] : []), message.task?.state ?? '-', who(message), oneLine(message.text) || '(files)'])))
  },
}

const create = {
  usage: [
    'wb tasks create <channel> <text|-> [--label k=v]... [--needs <id>]...',
    '                    [--for <actor>] [--claim [--lease 15m]] [--attach <file>]...',
    '                    [--id <client id>]',
    '',
    'Start a thread as a task. It waits until every --needs task completes.',
    '--claim also claims it, in the same write.',
  ].join('\n'),
  flags: { label: 'list', needs: 'list', for: 'string', claim: 'bool', lease: 'string', attach: 'list', id: 'string' },
  async run(ctx) {
    const channel = channelOf(required(ctx.positionals[0], 'a channel', 'wb tasks create'), 'tasks')
    if (ctx.flags.lease && !ctx.flags.claim) throw misuse('invalid_flag', '--lease goes with --claim', [['wb', 'tasks', 'create', '--help']])
    const attachments = []
    for (const file of ctx.flags.attach ?? []) attachments.push((await uploadFile(ctx, file)).id)
    const words = ctx.positionals.slice(1)
    const text = words.length === 0 && attachments.length ? '' : await textOf(ctx, words, 'text', 'wb tasks create')
    const labels = pairs(ctx.flags.label, '--label')
    const token = ctx.flags.claim ? newToken() : undefined
    const lease = leaseOf(ctx)
    const answer = await ctx.board().request("couldn't make a task in " + channel, 'POST', '/tasks', {
      body: {
        channel,
        text,
        ...(Object.keys(labels).length ? { labels } : {}),
        ...(attachments.length ? { attachments } : {}),
        ...(ctx.flags.needs ? { needs: ctx.flags.needs.map(idOf) } : {}),
        ...(ctx.flags.for ? { for: ctx.flags.for } : {}),
        ...(ctx.flags.id ? { id: ctx.flags.id } : {}),
        ...(token ? { claim: true, token, ...(lease !== undefined ? { lease } : {}) } : {}),
      },
    })
    const id = answer.task.id
    if (answer.claim) remember(ctx, id, answer.claim)
    if (ctx.json) return ctx.emit({ task: answer.task, ...(answer.claim ? { claim: shown(answer.claim) } : {}), ...(answer.mentions ? { mentions: answer.mentions } : {}) })
    const lines = ['made task ' + ref(id) + ' in ' + answer.task.channel + '  ' + (answer.task.task?.state ?? '')]
    if (answer.claim) lines.push('claimed ' + ref(id) + ' until ' + when(answer.claim.until))
    ctx.print([...lines, ...mentionNotes(answer.mentions)])
  },
}

const claim = {
  usage: [
    'wb tasks claim <id> [--lease 15m]',
    'wb tasks claim --ready <channel>|<prefix/> [--label k=v]...',
    '                   [--from <owner>]... [--wait 10m] [--lease 15m]',
    '',
    'Claim a task, or the oldest ready one in a channel. The claim is kept on this',
    'machine for this board and profile, so renew, release, complete, fail, and block',
    'find it. --ready exits 1 when no task was ready in time.',
  ].join('\n'),
  flags: { ready: 'string', label: 'list', from: 'list', wait: 'string', lease: 'string' },
  async run(ctx) {
    const lease = leaseOf(ctx)
    const token = newToken()
    const board = ctx.board()
    if (ctx.flags.ready !== undefined) {
      if (ctx.positionals.length) throw misuse('extra_argument', 'wb tasks claim takes an ID or --ready <channel>, not both', [['wb', 'tasks', 'claim', '--help']])
      const channel = channelOf(ctx.flags.ready, 'tasks', { subtree: true })
      const labels = pairs(ctx.flags.label, '--label')
      const waitMs = ctx.flags.wait === undefined ? 0 : duration(ctx.flags.wait, '--wait')
      const deadline = Date.now() + waitMs
      if (waitMs) ctx.interruptible()
      let answer
      for (;;) {
        const left = Math.max(0, Math.ceil((deadline - Date.now()) / 100) / 10)
        answer = await board.request("couldn't claim a task in " + channel, 'POST', '/tasks/claim', {
          body: { channel, ...(Object.keys(labels).length ? { label: labels } : {}), ...(ctx.flags.from ? { from: ctx.flags.from } : {}), ...(lease !== undefined ? { lease } : {}), token, wait: Math.min(25, left) },
        })
        if (answer.task || Date.now() >= deadline - 20) break
      }
      if (!answer.task) {
        if (ctx.json) return ctx.emit({ task: null }, 1)
        throw failure('none_ready', 'no task was ready in ' + channel + (waitMs ? ' in ' + ctx.flags.wait : ''))
      }
      const id = answer.task.id
      remember(ctx, id, answer.claim)
      if (ctx.json) return ctx.emit({ task: answer.task, claim: shown(answer.claim) })
      return ctx.print(['claimed ' + ref(id) + ' in ' + answer.task.channel + ' until ' + when(answer.claim.until), '', ...messageBlock(answer.task)])
    }
    if (ctx.flags.label || ctx.flags.from || ctx.flags.wait) throw misuse('invalid_flag', '--label, --from, and --wait go with --ready', [['wb', 'tasks', 'claim', '--help']])
    const id = idOf(required(ctx.positionals[0], 'a task ID, or --ready <channel>', 'wb tasks claim'))
    // A claim kept here is asked for again with its own token: the board answers it as it is.
    const kept = loadClaim(ctx.env, board.url, id, board.profile)
    const answer = await board.request("couldn't claim " + ref(id), 'POST', path(id, 'claim'), { body: { token: kept?.token ?? token, ...(lease !== undefined ? { lease } : {}) } })
    remember(ctx, id, answer.claim)
    if (ctx.json) return ctx.emit({ task: answer.task, claim: shown(answer.claim) })
    ctx.print(['claimed ' + ref(id) + ' until ' + when(answer.claim.until)])
  },
}

const renew = {
  usage: 'wb tasks renew <id> [--lease 15m]\n\nExtend your claim: the lease runs from now.',
  flags: { lease: 'string' },
  async run(ctx) {
    const id = idOf(required(ctx.positionals[0], 'a task ID', 'wb tasks renew'))
    const lease = leaseOf(ctx)
    const answer = await byClaim(ctx, id, 'renew', "couldn't renew " + ref(id), lease !== undefined ? { lease } : {})
    const kept = held(ctx, id, 'renew')
    remember(ctx, id, { ...kept, until: answer.until })
    if (ctx.json) return ctx.emit({ task: answer.task, until: answer.until })
    ctx.print(['renewed ' + ref(id) + ' until ' + when(answer.until)])
  },
}

function finishing(verb, past, { note, needsNote = false, usage }) {
  return {
    usage: usage + '\n\nWith --owner, as the task\'s owner (or with manage in its channel) and no claim:\nwhoever holds it, their claim is over.',
    flags: { owner: 'bool' },
    async run(ctx) {
      const id = idOf(required(ctx.positionals[0], 'a task ID', 'wb tasks ' + verb))
      const words = ctx.positionals.slice(1)
      let body = {}
      if (note) {
        if (needsNote || words.length) body = { [note]: await textOf(ctx, words, 'a ' + note, 'wb tasks ' + verb) }
      } else if (words.length) throw misuse('extra_argument', 'wb tasks ' + verb + ' takes only a task ID', [['wb', 'tasks', verb, '--help']])
      const doing = "couldn't " + verb + ' ' + ref(id)
      const answer = ctx.flags.owner ? await ctx.board().request(doing, 'POST', path(id, verb), { body }) : await byClaim(ctx, id, verb, doing, body)
      dropClaim(ctx.env, ctx.board().url, id, ctx.board().profile)
      if (ctx.json) return ctx.emit({ task: answer.task })
      ctx.print([past + ' ' + ref(id)])
    },
  }
}

const block = {
  usage: [
    'wb tasks block <id> <reason|-> [--kind <kind>]',
    '',
    'Hold a task for a person. With a claim kept here, the claim holds it (and ends);',
    'without one, you hold it as its owner.',
  ].join('\n'),
  flags: { kind: 'string' },
  async run(ctx) {
    const id = idOf(required(ctx.positionals[0], 'a task ID', 'wb tasks block'))
    const reason = await textOf(ctx, ctx.positionals.slice(1), 'a reason', 'wb tasks block')
    const body = { reason, ...(ctx.flags.kind ? { kind: ctx.flags.kind } : {}) }
    const kept = loadClaim(ctx.env, ctx.board().url, id, ctx.board().profile)
    const answer = kept ? await byClaim(ctx, id, 'block', "couldn't block " + ref(id), body) : await ctx.board().request("couldn't block " + ref(id), 'POST', path(id, 'block'), { body })
    if (kept) dropClaim(ctx.env, ctx.board().url, id, ctx.board().profile)
    if (ctx.json) return ctx.emit({ task: answer.task })
    ctx.print(['blocked ' + ref(id)])
  },
}

/** An owner's write: no claim, the task's ID and maybe a body. */
function owners(verb, past, { usage, body }) {
  return {
    usage,
    flags: verb === 'assign' ? { anyone: 'bool' } : {},
    async run(ctx) {
      const id = idOf(required(ctx.positionals[0], 'a task ID', 'wb tasks ' + verb))
      const sent = body ? await body(ctx, ctx.positionals.slice(1)) : {}
      if (!body && ctx.positionals.length > 1) throw misuse('extra_argument', 'wb tasks ' + verb + ' takes only a task ID', [['wb', 'tasks', verb, '--help']])
      const answer = await ctx.board().request("couldn't " + verb + ' ' + ref(id), 'POST', path(id, verb), { body: sent })
      if (verb === 'cancel') dropClaim(ctx.env, ctx.board().url, id, ctx.board().profile)
      if (ctx.json) return ctx.emit({ task: answer.task })
      ctx.print([past(id, answer.task)])
    },
  }
}

/** Answers a hold, with an optional note: the task is given back, and the answer is on it for whoever held it. */
function answering(decision) {
  const verb = decision === 'approved' ? 'approve' : 'decline'
  return owners('unblock', (id, task) => decision + ' ' + ref(id) + '  ' + (task?.task?.state ?? ''), {
    usage: [
      'wb tasks ' + verb + ' <id> [note|-]',
      '',
      (decision === 'approved' ? 'Approve' : 'Decline') + " what a held task asks. It's given back either way, with your answer",
      'on it. A hold its claim placed is answered with manage in its channel, or by its',
      'owner as themselves.',
    ].join('\n'),
    body: async (ctx, words) => ({ decision, ...(words.length ? { note: await textOf(ctx, words, 'a note', 'wb tasks ' + verb) } : {}) }),
  })
}

const SUBCOMMANDS = {
  create,
  claim,
  renew,
  release: finishing('release', 'released', { usage: 'wb tasks release <id> [--owner]\n\nGive your claim up: the task is ready again.' }),
  complete: finishing('complete', 'completed', { note: 'result', usage: 'wb tasks complete <id> [result|-] [--owner]\n\nComplete the task you claimed, with an optional result.' }),
  fail: finishing('fail', 'failed', { note: 'reason', needsNote: true, usage: 'wb tasks fail <id> <reason|-> [--owner]\n\nFail the task you claimed. Its owner may reopen it.' }),
  block,
  unblock: owners('unblock', (id, task) => 'unblocked ' + ref(id) + '  ' + (task?.task?.state ?? ''), { usage: 'wb tasks unblock <id>\n\nLift a hold on a task you own.' }),
  approve: answering('approved'),
  decline: answering('declined'),
  reopen: owners('reopen', (id) => 'reopened ' + ref(id), { usage: 'wb tasks reopen <id>\n\nMake a failed task ready again.' }),
  cancel: owners('cancel', (id) => 'canceled ' + ref(id), {
    usage: 'wb tasks cancel <id> <reason|->\n\nCancel a task you own. Tasks that wait for it keep waiting.',
    body: async (ctx, words) => ({ reason: await textOf(ctx, words, 'a reason', 'wb tasks cancel') }),
  }),
  assign: owners('assign', (id, task) => (task?.task?.for ? 'assigned ' + ref(id) + ' to ' + task.task.for : 'assigned ' + ref(id) + ' to anyone'), {
    usage: 'wb tasks assign <id> <actor>|--anyone\n\nLet one actor claim it (a person, a seat: an actor ID), or anyone.',
    body: async (ctx, words) => {
      if (ctx.flags.anyone) return { for: null }
      return { for: required(words[0], 'an actor ID, or --anyone', 'wb tasks assign') }
    },
  }),
  needs: owners('needs', (id, task) => (task?.task?.needs?.length ? ref(id) + ' needs ' + task.task.needs.map(ref).join(', ') : ref(id) + ' needs nothing'), {
    usage: 'wb tasks needs <id> [<id>...]\n\nReplace what a task waits for. No IDs: it waits for nothing.',
    body: async (_ctx, words) => ({ needs: words.map(idOf) }),
  }),
}

export const tasks = {
  usage: [
    list.usage,
    '',
    'wb tasks <subcommand> ...',
    '',
    '  create, claim, renew, release, complete, fail, block, unblock, approve,',
    '  decline, reopen, cancel, assign, needs',
    '',
    'wb tasks <subcommand> --help says more about each.',
  ].join('\n'),
  /** The subcommand an argv names, or the list. */
  pick(positionals) {
    const name = positionals[0]
    if (name && Object.hasOwn(SUBCOMMANDS, name)) return { command: SUBCOMMANDS[name], name: 'tasks ' + name, rest: 1 }
    return { command: list, name: 'tasks', rest: 0 }
  },
}
