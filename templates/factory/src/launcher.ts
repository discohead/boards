// The factory's page: what it's connected to, checked live, and what it's working on.
import { boardCall, mountOf } from './board.ts'
import { HOME, NAME, REPOS } from './config.ts'
import { installedRepos } from './github-app.ts'
import type { Env } from './env.ts'

const escape = (text: string) => text.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!)
type Check = { name: string; ok: boolean; detail: string }

export async function status(env: Env) {
  const board = boardCall(env)
  const checks: Check[] = []
  const me = await board('me', {}).catch((error: Error) => error)
  checks.push(me instanceof Error ? { name: 'Board', ok: false, detail: me.message } : { name: 'Board', ok: true, detail: 'the agent is ' + me.actor + ' on ' + mountOf(env).url })
  const installed = await installedRepos(env as never).catch(() => [] as string[])
  const missing = Object.keys(REPOS).filter((repo) => !installed.some((name) => name.toLowerCase() === repo.toLowerCase()))
  checks.push({ name: 'GitHub', ok: installed.length > 0 && missing.length === 0, detail: installed.length ? env.GITHUB_APP_SLUG + ' is on ' + installed.join(', ') + (missing.length ? '; not yet on ' + missing.join(', ') : '') : env.GITHUB_APP_SLUG + ' is on no repo yet' })
  checks.push({ name: 'Model', ok: Boolean(env.AI_GATEWAY_ID), detail: (env.MODEL || 'claude-haiku-5-5') + ' through AI Gateway ' + env.AI_GATEWAY_ID + (env.AI_GATEWAY_BYOK_ALIAS ? ' (key ' + env.AI_GATEWAY_BYOK_ALIAS + ')' : '') })
  const threads = me instanceof Error ? [] : (await board('threads', { channel: HOME + '/', limit: 10 }).catch(() => ({ threads: [] }))).threads as { message: { id: string; channel: string; text: string }; replies: number }[]
  return { checks, threads }
}

export async function launcher(request: Request, env: Env): Promise<Response> {
  const { checks, threads } = await status(env)
  if (!(request.headers.get('accept') ?? '').includes('text/html')) {
    const lines = ['# ' + NAME, '', ...checks.map((check) => '- ' + (check.ok ? '[x] ' : '[ ] ') + check.name + ': ' + check.detail), '', '## Threads', ...threads.map((thread) => '- #' + thread.message.id + ' ' + thread.message.channel + ': ' + thread.message.text.split('\n')[0]!.slice(0, 100) + ' (' + thread.replies + ' replies)')]
    return new Response(lines.join('\n') + '\n', { headers: { 'content-type': 'text/markdown; charset=utf-8' } })
  }
  const html = '<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width"><title>' + escape(NAME) + '</title>' +
    '<style>body{font:15px/1.5 system-ui;max-width:46em;margin:3em auto;padding:0 1em;color:#111}h1{font-size:1.6em}li{margin:.3em 0}.ok{color:#137333}.no{color:#b3261e}code{background:#f3f3f3;padding:.1em .3em;border-radius:3px}</style>' +
    '<h1>' + escape(NAME) + '</h1><p>An agent on this factory’s board that takes bugs, features, and questions to pull requests.</p><h2>Setup</h2><ul>' +
    checks.map((check) => '<li><b class=' + (check.ok ? 'ok' : 'no') + '>' + (check.ok ? '✓' : '✗') + '</b> <b>' + escape(check.name) + '</b>: ' + escape(check.detail) + '</li>').join('') +
    '</ul><h2>Threads</h2><ul>' + (threads.length ? threads.map((thread) => '<li><b>#' + escape(thread.message.id) + '</b> <code>' + escape(thread.message.channel) + '</code> ' + escape(thread.message.text.split('\n')[0]!.slice(0, 120)) + ' · ' + thread.replies + ' replies</li>').join('') : '<li>none yet</li>') +
    '</ul><p>Talk to it on the board: <code>WORKBUS_URL=' + escape(mountOf(env).url) + ' wb read ' + escape(HOME) + '/</code>, or open an issue on one of its repos.</p>'
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
}
