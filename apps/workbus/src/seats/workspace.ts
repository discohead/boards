// A seat's workspace (§5.4): one Durable Object per seat, named by its key, holding the seat's
// @cloudflare/computer Workspace in its own SQLite, so every thread the seat works sees the same
// files and repositories. The seat's Sessions call it over RPC; it runs one call at a time, in the
// order they come, so two threads never interleave their writes. Another seat's workspace is
// another object: nothing of this one reaches it.
import { DurableObject } from 'cloudflare:workers'
import type { PiTool, PiToolCall, PiToolResult } from '@cloudflare/computer/tools/pi-ai'

import { workspace, workspaceTools } from '../harness/computer.ts'

/** A file as a sandbox syncs it. */
export type Listed = { path: string; size: number; mtime: number }
/** What a sandbox doesn't sync: dependencies it installs itself, and caches. */
export const SYNC_SKIP = ['**/node_modules', '**/.cache', '**/.npm']
export const SYNC_MAX_FILES = 5000

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

  // -- what a sandbox syncs (harness/sandbox.ts) ------------------------------------------------

  /** Runs fn after every call before it has ended, as execute does. */
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#last.then(fn)
    this.#last = run.catch(() => undefined)
    return run
  }

  /** Every file under root but what skip leaves out (globs, as find takes them), with its size and mtime. */
  listing(root = '/workspace', skip: string[] = SYNC_SKIP): Promise<Listed[]> {
    return this.#serial(async () => {
      await this.space.fs.mkdir(root, { recursive: true })
      const found = await this.space.fs.find(root, '**', { exclude: skip, limit: SYNC_MAX_FILES + 1 })
      const files = found.filter((entry) => entry.type === 'file')
      if (files.length > SYNC_MAX_FILES) throw new Error('the workspace has more than ' + SYNC_MAX_FILES + ' files to sync (outside node_modules): too many for a sandbox')
      const out: Listed[] = []
      for (const entry of files) {
        const stat = await this.space.fs.stat(entry.path).catch(() => null)
        if (stat?.isFile) out.push({ path: entry.path, size: stat.size, mtime: stat.mtime })
      }
      return out
    })
  }

  /** Files' bytes, by path. */
  readFiles(paths: string[]): Promise<{ path: string; data: Uint8Array }[]> {
    return this.#serial(async () => {
      const out: { path: string; data: Uint8Array }[] = []
      for (const path of paths) out.push({ path, data: new Uint8Array(await new Response(await this.space.fs.readFile(path)).arrayBuffer()) })
      return out
    })
  }

  /** Writes files (making their directories), and removes paths: what a sandbox's command changed. Answers each written file's listing. */
  applyFiles(written: { path: string; data: Uint8Array }[], removed: string[] = []): Promise<Listed[]> {
    return this.#serial(async () => {
      const out: Listed[] = []
      for (const { path, data } of written) {
        await this.space.fs.mkdir(path.slice(0, path.lastIndexOf('/')) || '/', { recursive: true })
        await this.space.fs.writeFile(path, data)
        const stat = await this.space.fs.stat(path)
        out.push({ path, size: stat.size, mtime: stat.mtime })
      }
      for (const path of removed) await this.space.fs.rm(path, { force: true })
      return out
    })
  }

  /** Everything in it gone (a seat let go, §5.7): its files, its repositories, its storage. */
  async reset(): Promise<void> {
    await this.#serial(async () => {
      await this.ctx.storage.deleteAlarm()
      await this.ctx.storage.deleteAll()
    })
  }

  /** What's in a directory of the workspace, for checks and the Seat's views. */
  async files(path = '/workspace') {
    return this.space.fs.readdir(path).catch(() => [])
  }
}
