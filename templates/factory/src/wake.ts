// Where the board's wake watcher delivers (FactoryWake), and where the sandbox's GitHub traffic gets
// its token (GitHubEgress). GitHub's own sync is the board's (worker.ts): nothing here copies to it.
import { WorkerEntrypoint } from 'cloudflare:workers'
import { getAgentByName } from 'agents'
import { AGENT_PRINCIPAL, boardCall } from './board.ts'
import { REPOS } from './config.ts'
import { repoToken } from './github-app.ts'
import type { Env } from './env.ts'

type By = { actor: string; principal: string; profile: string | null }
type Event = { cursor: string; type: string; payload: Record<string, any>; message?: { id: string; re: string | null; by: By; schedule?: unknown; labels?: Record<string, string>; task?: { state: string } | null }; actor?: { name: string } }
type Delivered = { attempt: number; match: string; board: { reply(id: string, input: string): Promise<unknown> } }

/** Whether the agent wrote it: this Worker, as itself. */
const byAgent = (by: By | undefined) => by?.principal === AGENT_PRINCIPAL && by.profile === null

export class FactoryWake extends WorkerEntrypoint<Env> {
  async onEvent(event: Event, context: Delivered): Promise<void> {
    const message = event.message
    if (!message) return
    const thread = message.re ?? message.id
    let text: string
    if (event.type === 'message.posted') {
      // Its own messages don't wake it, except the reminders it schedules for itself.
      if (byAgent(message.by) && message.schedule === undefined) return
      // What the app itself said on GitHub is in the thread already, as the agent's own.
      if (message.by.actor === 'github:user:' + this.env.GITHUB_BOT_USER_ID) return
      // A new doc isn't a request: it's read when someone asks about it.
      if (message.re === null && message.labels?.['board.doc'] !== undefined) return
      text = message.re ? 'New message #' + message.id + ' in board thread #' + thread + '.' : 'New board thread #' + thread + '.'
    } else if (event.type === 'task.ready' || (event.type === 'task.created' && event.message?.task?.state === 'ready')) {
      // A thread made a ready task (a card moved to the Project's ready column, or someone's createTask).
      if (message.re !== null) return
      text = 'Board thread #' + thread + ' is a ready task. If it’s work for you, claim it with task_claim before you start, and complete it with task_complete when it’s done.'
    } else if (event.type === 'reaction.added') {
      if (!byAgent(message.by) || byAgent(event.payload.by)) return
      text = (event.actor?.name ?? 'Someone') + ' reacted :' + event.payload.emoji + ': to your message #' + message.id + ' in board thread #' + thread + '.'
    } else return
    try {
      const agent = await getAgentByName(this.env.THREAD_AGENT, 'thread-' + thread)
      await agent.wake({ thread, key: event.cursor, text })
    } catch (error) {
      // The Mailbox tries again; on the last tries, say so in the thread.
      if (context.attempt < 3) throw error
      const reason = (error instanceof Error ? error.message : String(error)).split('\n')[0]!.slice(0, 200)
      await context.board.reply(thread, 'The agent couldn’t start: \u0060' + reason + '\u0060. Reply here to try again.')
    }
  }
}

/** The repos a thread's GitHub token covers: a GitHub thread's own repo, or every repo the factory works on. */
export function threadRepos(root: { origin?: { thread?: string } | null } | null, repos: string[]): string[] {
  if (!root) return []
  const from = root.origin?.thread?.match(/^[^:]+:([^/:]+\/[^/:]+):/)?.[1]?.toLowerCase()
  if (!from) return repos
  return repos.filter((repo) => repo.toLowerCase() === from)
}

/** The account a request to GitHub names: in its path (api.github.com/repos/<owner>/…, github.com/<owner>/…), or in a GraphQL query's owner; null when it names none. */
async function ownerOf(request: Request, url: URL): Promise<string | null> {
  const parts = url.pathname.split('/').filter(Boolean)
  if (url.hostname === 'api.github.com' && parts[0] === 'repos' && parts[1]) return parts[1].toLowerCase()
  if (url.hostname === 'github.com' && parts[0]) return parts[0].toLowerCase()
  if (url.hostname === 'api.github.com' && parts[0] === 'graphql' && request.method === 'POST') {
    const body = await request.clone().text().catch(() => '')
    const found = body.match(/"owner"\s*:\s*"([^"]+)"/) ?? body.match(/owner\s*:\s*\\?"([^"\\]+)\\?"/)
    return found ? found[1]!.toLowerCase() : null
  }
  return null
}

/** The repos a token is for: those of the account a request names, when it names one of them; else all of them (the first account's). */
const forOwner = (repos: string[], owner: string | null) => {
  if (!owner) return repos
  const mine = repos.filter((repo) => repo.split('/')[0]!.toLowerCase() === owner)
  return mine.length ? mine : repos
}

/** The thread's GitHub token, added to the sandbox's requests to GitHub as they leave it. */
export class GitHubEgress extends WorkerEntrypoint<Env, { thread: string }> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const root = await boardCall(this.env)('message', { id: this.ctx.props.thread }).then((view) => view.message).catch(() => null)
    const repos = forOwner(threadRepos(root, Object.keys(REPOS)), await ownerOf(request, url))
    const token = repos.length ? await repoToken(this.env as never, repos).catch((error: unknown) => (console.warn('[factory] no GitHub token:', error), null)) : null
    const headers = new Headers(request.headers)
    if (token) {
      if (url.hostname === 'github.com') headers.set('authorization', 'Basic ' + btoa('x-access-token:' + token))
      else headers.set('authorization', 'Bearer ' + token)
    } else headers.delete('authorization')
    return fetch(new Request(request, { headers }))
  }
}