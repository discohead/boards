// TEMPORARY: a stand-in for scout's egress (app/egress), so the sandbox runs locally until it's merged.
import { WorkerEntrypoint } from 'cloudflare:workers'

const ALLOWED = ['registry.npmjs.org']

export class Egress extends WorkerEntrypoint<Env, { seat: string; thread: string }> {
  async fetch(request: Request): Promise<Response> {
    const host = new URL(request.url).hostname
    const allowed = ALLOWED.includes(host)
    console.log(JSON.stringify({ event: 'egress', seat: this.ctx.props.seat, thread: this.ctx.props.thread, method: request.method, url: request.url, allowed }))
    if (!allowed) return new Response('egress: ' + host + ' is not allowed\n', { status: 403 })
    return fetch(request)
  }
}
