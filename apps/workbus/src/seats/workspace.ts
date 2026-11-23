// A seat's workspace (§5.4): one Durable Object per seat, named by its key, holding the seat's
// @cloudflare/computer Workspace in its own SQLite, so every thread the seat works sees the same
// files and repositories. The seat's Sessions call it over RPC; it runs one call at a time, in the
// order they come, so two threads never interleave their writes. Another seat's workspace is
// another object: nothing of this one reaches it.
import { DurableObject } from 'cloudflare:workers'
import type { PiTool, PiToolCall, PiToolResult } from '@cloudflare/computer/tools/pi-ai'

import { workspace, workspaceTools } from '../harness/computer.ts'

export class SeatWorkspace extends DurableObject<Env> {
  readonly space = workspace(this.ctx.storage, this.env.LOADER)
  readonly tools = workspaceTools(this.space)
  #last: Promise<unknown> = Promise.resolve()

  /** The tools' declarations, for the model. */
  declare(): PiTool[] {
    return this.tools.tools
  }

  /** Runs one tool call, after every call before it has ended. A failed call doesn't stop the next. */
  execute(call: PiToolCall): Promise<PiToolResult> {
    const run = this.#last.then(() => this.tools.execute(call))
    this.#last = run.catch(() => undefined)
    return run
  }

  /** What's in a directory of the workspace, for checks and the Seat's views. */
  async files(path = '/workspace') {
    return this.space.fs.readdir(path).catch(() => [])
  }
}
