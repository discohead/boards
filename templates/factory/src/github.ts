// GitHub, synced with the factory's board as the board's own sync: issues and pull requests come in
// as threads (GitHub's webhooks at /b/<board>/webhooks/github, kept by the sync's Inbox), and what's
// written on the board in those threads goes back as comments, as this factory's app, by its courier.
import { githubProvider } from 'boards/sync/github.ts'
import { DOCS, REPOS } from './config.ts'
import { repoToken } from './github-app.ts'
import type { Env } from './env.ts'

export const github = (env: Env) =>
  githubProvider({
    webhookSecret: env.GITHUB_WEBHOOK_SECRET,
    repos: REPOS,
    // The repos' Markdown docs, kept in step with the board's: a push merges in, a board edit commits.
    docs: DOCS,
    // Comments go back as the app: an installation token for the thread's repo.
    token: async (repo) => {
      const token = await repoToken(env, [repo])
      if (!token) throw new Error('the app has no token for ' + repo)
      return token
    },
    // The app's own comments come back as GitHub's echo: each waits for its receipt.
    botUserId: env.GITHUB_BOT_USER_ID,
    ...(env.GITHUB_API_BASE ? { apiBase: env.GITHUB_API_BASE } : {}),
    // A thread for each issue and pull request people open; not for the app's own pull requests,
    // which belong to the thread that asked for them, nor for a fork's.
    starts: (event) => event.kind === 'root' && event.author.id !== 'github:user:' + env.GITHUB_BOT_USER_ID && !(event.pr && (event.raw as any)?.pull_request?.head?.repo?.fork),
  })