// A Relay: where waits are held. A Gateway holding a long-poll, an SSE stream, or a claim's wait
// opens a WebSocket here (the Relay's side hibernates), and the board's Ledger rings every attached
// Relay when its log moves. A ring wakes the Relay for the moment it takes to tell its sockets the
// new head; nothing waits on the Ledger, which sleeps between writes.
import { DurableObject } from 'cloudflare:workers'
type Env = { LEDGER: DurableObjectNamespace<any> }

type Attached = { board: string }

export class Relay extends DurableObject<Env> {
  /** The board's head as the last ring said it. */
  private head(): number {
    return this.ctx.storage.kv.get<number>('head') ?? 0
  }

  /** A Gateway's WebSocket. The Relay attaches to its board's Ledger before it answers. */
  async fetch(request: Request): Promise<Response> {
    const board = request.headers.get('x-board-name')
    if (!board || request.headers.get('upgrade') !== 'websocket') return new Response('a Relay takes WebSockets from the Gateway', { status: 400 })
    if (!this.ctx.storage.kv.get<Attached>('attached')) {
      await (this.env.LEDGER as any).getByName(board).attachRelay(this.name())
      this.ctx.storage.kv.put('attached', { board } satisfies Attached)
    }
    const pair = new WebSocketPair()
    this.ctx.acceptWebSocket(pair[1])
    // What it knows already: a ring that came before this socket isn't missed.
    pair[1].send(JSON.stringify({ head: this.head() }))
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  private name(): string {
    return this.ctx.storage.kv.get<string>('name') ?? ''
  }

  /** Names itself once: the Gateway gets it by name, and the Ledger rings it by that name. */
  async named(name: string): Promise<void> {
    if (!this.ctx.storage.kv.get<string>('name')) this.ctx.storage.kv.put('name', name)
  }

  /** The Ledger's log moved: every socket hears the new head, in one frame each. */
  async ring(head: number): Promise<{ listening: number }> {
    if (head > this.head()) this.ctx.storage.kv.put('head', head)
    const sockets = this.ctx.getWebSockets()
    const frame = JSON.stringify({ head })
    for (const socket of sockets) {
      try {
        socket.send(frame)
      } catch {
        // A socket that closed as it rang.
      }
    }
    if (sockets.length === 0) await this.detach()
    return { listening: sockets.length }
  }

  private async detach() {
    const attached = this.ctx.storage.kv.get<Attached>('attached')
    if (!attached) return
    this.ctx.storage.kv.delete('attached')
    await (this.env.LEDGER as any).getByName(attached.board).detachRelay(this.name())
  }

  async webSocketMessage(): Promise<void> {}

  async webSocketClose(socket: WebSocket): Promise<void> {
    try {
      socket.close()
    } catch {}
    if (this.ctx.getWebSockets().length === 0) await this.detach()
  }
}
