// GET /?board=<name>: drives the board through the service binding and answers what each step did.
import type { Board, Workbus, BoardSession } from '../../src/binding.ts'

type Env = {
  WORKBUS: Service<Workbus>
  NARROW: Service<Workbus>
  PINNED: Service<Workbus>
  NOBODY: Service<Workbus>
  FORGED: Service<BoardSession>
  HTTP: Fetcher
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/b/') || url.pathname.startsWith('/issuer/')) return env.HTTP.fetch(request)
    const name = url.searchParams.get('board') ?? 'dev'
    const steps: [string, unknown][] = []
    const step = async (label: string, work: () => Promise<unknown>) => {
      try {
        steps.push([label, await work()])
      } catch (error) {
        steps.push([label, 'refused: ' + (error as Error).message])
      }
    }
    const board = env.WORKBUS.board(name) as unknown as Board

    await step('me', async () => {
      const me = (await board.me()) as { actor: string; kind: string; can: unknown }
      return me.actor + ' (' + me.kind + ') can ' + JSON.stringify(me.can)
    })
    const sha = 'abc' + Date.now()
    let first = ''
    await step('post', async () => {
      const { message } = (await board.post('deploys', { text: sha + ' is live', id: 'deploy-' + sha })) as { message: { id: string; by: { actor: string } } }
      first = message.id
      return message.id + ' by ' + message.by.actor
    })
    await step('post, same id again', async () => ((await board.post('deploys', { text: sha + ' is live', id: 'deploy-' + sha })) as { message: { id: string } }).message.id)
    await step('reply', async () => ((await board.reply(first, 'smoke tests pass')) as { message: { re: string } }).message.re)
    await step('read', async () => ((await board.read(first)) as { replies: { text: string }[] }).replies.map((reply) => reply.text))
    await step('threads in deploys', async () => ((await board.threads({ channel: 'deploys' })) as { threads: unknown[] }).threads.length)

    // A task: claim the next ready one, renew, drop the stub, see it still held, pick it back up by its token, complete.
    await step('tasks.create', async () => ((await board.tasks.create({ channel: 'jobs', text: 'rebuild the cache' })) as { task: { id: string } }).task.id)
    await step('tasks.claim + renew + dispose', async () => {
      // A token this Worker chose (32 bytes, base64url), so a later call can present it again.
      const token = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
      const claim = await board.tasks.claim({ channel: 'jobs' }, { lease: 60, token })
      if (!claim) return 'nothing ready'
      const sturdy = await claim.sturdy()
      const claimedUntil = await claim.until
      const until = await claim.renew(120)
      ;(claim as unknown as Disposable)[Symbol.dispose]()
      const held = ((await board.read(sturdy.id)) as { message: { task: { state: string; claim: { actor: string } | null } } }).message.task
      const again = await board.tasks.claim({ id: sturdy.id }, { token: sturdy.token })
      const done = (await again!.complete('cache rebuilt')) as { task: { task: { state: string; result: string } } }
      return { epoch: sturdy.epoch, claimedUntil, renewedUntil: until, afterDispose: held.state + ' by ' + held.claim?.actor, completed: done.task.task.state + ': ' + done.task.task.result }
    })
    await step('tasks.claim, none ready', async () => (await board.tasks.claim({ channel: 'jobs' })) === null ? 'null' : 'a claim')

    // Attenuation: a channel's Board, and the binding's own can.
    const deploys = board.channel('deploys')
    await step('channel(deploys).post deploys', async () => ((await deploys.post('deploys', 'inside')) as { message: { channel: string } }).message.channel)
    await step('channel(deploys).post jobs', async () => deploys.post('jobs', 'outside'))
    await step('channel(deploys).narrow(*=all).post jobs', async () => deploys.narrow('*=all').post('jobs', 'still outside'))
    await step('channel(deploys).threads in jobs', async () => deploys.threads({ channel: 'jobs' }))
    const narrow = env.NARROW.board(name) as unknown as Board
    await step('props.can: post deploys', async () => ((await narrow.post('deploys', 'as deployer')) as { message: { by: { actor: string } } }).message.by.actor)
    await step('props.can: post jobs', async () => narrow.post('jobs', 'no'))
    await step('props.can: react in deploys', async () => narrow.react(first, 'rocket'))
    await step('props.can: me.can', async () => ((await narrow.me()) as { can: unknown }).can)

    // Bindings that reach nothing.
    await step('props.board: another board', async () => (env.PINNED.board(name) as unknown as Board).me())
    await step('no props.principal', async () => (env.NOBODY.board(name) as unknown as Board).me())
    await step('forged BoardSession props', async () => ((await env.FORGED.board()) as unknown as Board).me())
    await step('a board never served', async () => (env.WORKBUS.board('never-served-' + Date.now()) as unknown as Board).me())

    return new Response(steps.map(([label, value]) => label.padEnd(42) + ' ' + (typeof value === 'string' ? value : JSON.stringify(value))).join('\n') + '\n')
  },
}
