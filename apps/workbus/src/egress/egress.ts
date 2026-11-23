// The egress entrypoint (design/workbus.md §5.4): every request a seat's tools, code, or container
// send out comes through here. It applies the seat's policy (policy.ts), adds the GitHub App's
// token on the way out for a sandbox's GitHub requests (github.ts), follows no redirects (the caller
// sees each hop and asks again, so each is checked), and logs one line per request.
//   const egress = this.ctx.exports.Egress({ props: { seat: 'ada', mode: 'web' } })
import { WorkerEntrypoint } from 'cloudflare:workers'
import { appLogin, authorization, installationToken, pullAuthor, type GitHubAppEnv } from './github.ts'
import { decide, pullHeadAllowed, pushAllowed, PULL_EDIT_FIELDS, STRIPPED, type EgressLog, type EgressProps } from './policy.ts'
import { readCommands } from './push.ts'

export function logEgress(line: EgressLog): void {
  console.log(JSON.stringify(line))
}

export class Egress extends WorkerEntrypoint<GitHubAppEnv, EgressProps> {
  async fetch(request: Request): Promise<Response> {
    const props = this.ctx.props
    const started = Date.now()
    const url = new URL(request.url)
    const base = { egress: 1 as const, seat: props.seat, ...(props.thread ? { thread: props.thread } : {}), mode: props.mode, method: request.method, host: url.hostname, path: url.pathname.slice(0, 200) }
    const decision = decide(request.method, request.url, props)
    if (!decision.ok) {
      logEgress({ ...base, status: decision.status, bytes: 0, ms: Date.now() - started, credential: null, refused: decision.reason })
      return new Response('blocked by the egress: ' + decision.reason + '\n', { status: decision.status, headers: { 'x-workbus-egress': 'refused' } })
    }
    const headers = new Headers(request.headers)
    for (const name of STRIPPED) headers.delete(name)
    let credential: 'github' | null = null
    let token: string | null = null
    if (decision.credential === 'github' && decision.repo) {
      token = await installationToken(this.env, decision.repo.owner, decision.repo.name).catch((error) => {
        console.error('egress: no GitHub token for ' + decision.repo!.owner + ':', String(error))
        return null
      })
      if (token) {
        headers.set('authorization', authorization(url.hostname, token))
        credential = 'github'
      }
    }
    const refuse = (status: number, reason: string) => {
      logEgress({ ...base, status, bytes: 0, ms: Date.now() - started, credential: null, refused: reason })
      return new Response('blocked by the egress: ' + reason + '\n', { status, headers: { 'x-workbus-egress': 'refused' } })
    }
    let body: BodyInit | null = request.body
    // The writes that need more than the URL to decide: a push's ref updates, a new pull request's head, and whose pull request an edit is.
    if (decision.write === 'receive-pack' || decision.write === 'pull-edit' || decision.write === 'pull-create') {
      if (!token || !decision.repo) return refuse(403, 'a GitHub write needs the app’s token, and there is none for ' + decision.repo?.owner)
      const { owner, name } = decision.repo
      try {
        if (decision.write === 'receive-pack') {
          const read = await readCommands(request.body)
          if (!read) return refuse(400, 'a push whose ref updates could not be read')
          const allowed = pushAllowed(read.updates, props.seat)
          if (!allowed.ok) return refuse(403, allowed.reason)
          body = read.body
        } else if (decision.write === 'pull-create') {
          const text = await request.text()
          const allowed = pullHeadAllowed((JSON.parse(text || '{}') as { head?: unknown }).head, owner, props.seat)
          if (!allowed.ok) return refuse(403, allowed.reason)
          body = text
        } else {
          const text = await request.text()
          const fields = Object.keys(JSON.parse(text || '{}') as object)
          const other = fields.filter((field) => !PULL_EDIT_FIELDS.has(field))
          if (other.length) return refuse(403, 'a seat may change only the title and body of a pull request, not ' + other.join(', '))
          const number = url.pathname.split('/')[5]!
          const [author, self] = await Promise.all([pullAuthor(owner, name, number, token), appLogin(this.env)])
          if (author !== self) return refuse(403, 'pull request #' + number + ' is ' + author + '’s, not the seats’ (' + self + ')')
          body = text
        }
      } catch (error) {
        return refuse(403, 'the egress could not check this write: ' + String(error).slice(0, 160))
      }
    }
    let response: Response
    try {
      response = await fetch(request.url, { method: request.method, headers, body, redirect: 'manual' })
    } catch (error) {
      logEgress({ ...base, status: 502, bytes: 0, ms: Date.now() - started, credential, refused: 'network: ' + String(error).slice(0, 120) })
      return new Response('the egress could not reach ' + url.hostname + '\n', { status: 502 })
    }
    const done = (bytes: number) => logEgress({ ...base, status: response.status, bytes, ms: Date.now() - started, credential })
    if (!response.body) {
      done(0)
      return response
    }
    let bytes = 0
    const counted = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength
        controller.enqueue(chunk)
      },
      flush() {
        done(bytes)
      },
    }))
    return new Response(counted, response)
  }
}
