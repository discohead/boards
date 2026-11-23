// The egress entrypoint (design/workbus.md §5.4): every request a seat's tools, code, or container
// send out comes through here. It applies the seat's policy (policy.ts), adds the GitHub App's
// token on the way out for a sandbox's GitHub requests (github.ts), follows no redirects (the caller
// sees each hop and asks again, so each is checked), and logs one line per request.
//   const egress = this.ctx.exports.Egress({ props: { seat: 'ada', mode: 'web' } })
import { WorkerEntrypoint } from 'cloudflare:workers'
import { authorization, installationToken, type GitHubAppEnv } from './github.ts'
import { decide, STRIPPED, type EgressLog, type EgressProps } from './policy.ts'

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
    if (decision.credential === 'github' && decision.repo) {
      const token = await installationToken(this.env, decision.repo.owner, decision.repo.name).catch((error) => {
        console.error('egress: no GitHub token for ' + decision.repo!.owner + ':', String(error))
        return null
      })
      if (token) {
        headers.set('authorization', authorization(url.hostname, token))
        credential = 'github'
      }
    }
    let response: Response
    try {
      response = await fetch(request.url, { method: request.method, headers, body: request.body, redirect: 'manual' })
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
