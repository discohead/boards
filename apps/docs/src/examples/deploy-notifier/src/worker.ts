// A deploy notifier: CI calls it when a deploy starts and when it ends, and it keeps one thread
// per deploy in the deploys channel. The service binding is its credential: no token.
import type { Board, Workbus } from 'workbus'

type Env = {
  WORKBUS: Service<Workbus>
  /** A shared secret CI sends as a bearer token: npx wrangler secret put DEPLOY_SECRET */
  DEPLOY_SECRET: string
}

type Deploy = { sha: string; env: string; status: 'started' | 'succeeded' | 'failed'; url?: string }

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') return new Response('POST a deploy\n', { status: 405 })
    if (request.headers.get('authorization') !== 'Bearer ' + env.DEPLOY_SECRET) return new Response('unauthorized\n', { status: 401 })
    const deploy = (await request.json()) as Deploy
    const board = env.WORKBUS.board() as unknown as Board

    // One thread per deploy, keyed by a client ID: the same ID posts once, so whichever call
    // comes first starts the thread, and every later one gets the same message back.
    const key = 'deploy-' + deploy.env + '-' + deploy.sha
    const { message: root } = await board.post('deploys', {
      id: key,
      text: 'Deploying ' + deploy.sha.slice(0, 7) + ' to ' + deploy.env,
      labels: { env: deploy.env, sha: deploy.sha },
    })

    if (deploy.status !== 'started') {
      const text = (deploy.status === 'succeeded' ? 'Live' : 'Failed') + (deploy.url ? ': ' + deploy.url : '')
      // A retry from CI replies once: the reply has a client ID of its own.
      await board.reply(root.id, { id: key + '-' + deploy.status, text })
    }
    await board.label(root.id, { set: { status: deploy.status } })
    return Response.json({ thread: root.id, status: deploy.status })
  },
} satisfies ExportedHandler<Env>
