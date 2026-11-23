// The sandbox tier (§5.4): a Linux container per session, the Session Durable Object's own
// (this.ctx.container, Sandbox SDK 1.0's model: the object starts it and runs commands; the
// package's Files moves bytes in and out). Basic size, asleep after 5 idle minutes, no Internet of
// its own: HTTP and HTTPS leave only through the egress entrypoint, which decides and logs each
// request. The seat's Workspace stays the source of truth. Before a command, the files that
// changed in the workspace since the container last had them are pushed in (node_modules and
// caches stay in the container, rebuilt there); after it, what the command changed or removed
// under /workspace is pulled back. Push and pull, not a DirectoryBackup: the workspace is already
// the seat's durable copy, shared by every thread, and a backup to R2 would be a second copy
// of it to keep in step; a sleeping container loses only what it can install again.
import { Files } from '@cloudflare/sandbox'
import { z } from 'zod'

import type { Tool } from './types.ts'

/** Where a command runs, and the CA HTTPS interception re-signs with (exec doesn't inherit start()'s env). */
const ROOT = '/workspace'
const CA = '/etc/cloudflare/certs/cloudflare-containers-ca.crt'
const TRUST = { CURL_CA_BUNDLE: CA, SSL_CERT_FILE: CA, NODE_EXTRA_CA_CERTS: CA, GIT_SSL_CAINFO: CA, HOME: '/root', npm_config_cache: '/root/.npm' }
export const INSTANCE = 'basic' as const
export const SLEEP_MS = 5 * 60_000
const OUTPUT_MAX = 16_000
const PULL_MAX_BYTES = 32 * 1024 * 1024
const FILE_MAX_BYTES = 8 * 1024 * 1024
/** What isn't synced either way: what a command installs (node_modules) and caches. */
const PRUNE = ['node_modules', '.cache', '.npm']
const FIND_PRUNE = ['(', ...PRUNE.flatMap((name, i) => (i ? ['-o', '-name', name] : ['-name', name])), ')', '-prune', '-o']

export type Listed = { path: string; size: number; mtime: number }
export type WorkspaceSync = {
  listing(root?: string): Promise<Listed[]>
  readFiles(paths: string[]): Promise<{ path: string; data: Uint8Array }[]>
  applyFiles(written: { path: string; data: Uint8Array }[], removed?: string[]): Promise<Listed[]>
}
/** What the container holds of the workspace, as of the workspace's own listing: kept by the Session, cleared when a container starts. */
export type Manifest = { all(): Map<string, Listed>; set(files: Listed[]): void; remove(paths: string[]): void; clear(): void }

/** ms: the whole call (start, sync, command, sync); commandMs: the command alone. */
export type SandboxResult = { exitCode: number; stdout: string; stderr: string; ms: number; commandMs: number; started: boolean; pushed: number; pulled: number; removed: number; skipped: string[] }

const tail = (bytes: ArrayBuffer) => {
  const text = new TextDecoder().decode(bytes)
  return text.length > OUTPUT_MAX ? '[… ' + (text.length - OUTPUT_MAX) + ' characters cut]\n' + text.slice(-OUTPUT_MAX) : text
}

export class SessionSandbox {
  #container: Container
  #files: Files
  #last: Promise<unknown> = Promise.resolve()
  readonly egress: () => Fetcher
  readonly workspace: () => WorkspaceSync
  readonly manifest: Manifest
  readonly labels: Record<string, string>
  constructor(container: Container, egress: () => Fetcher, workspace: () => WorkspaceSync, manifest: Manifest, labels: Record<string, string>) {
    this.#container = container
    this.#files = new Files(container)
    this.egress = egress
    this.workspace = workspace
    this.manifest = manifest
    this.labels = labels
  }

  get running(): boolean {
    return this.#container.running
  }

  /** Starts the container if it sleeps: no Internet but through the egress, and asleep after 5 idle minutes. */
  async #ensure(): Promise<boolean> {
    if (this.#container.running) return false
    this.manifest.clear()
    this.#container.start({ image: this.#container.images.sandbox!, instance: INSTANCE, enableInternet: false, labels: this.labels })
    const egress = this.egress()
    await this.#container.interceptAllOutboundHttp(egress)
    await this.#container.interceptOutboundHttps('*', egress)
    await this.#container.setInactivityTimeout(SLEEP_MS)
    return true
  }

  async #exec(argv: string[], signal?: AbortSignal): Promise<ExecOutput> {
    const process = await this.#container.exec(argv, { cwd: ROOT, env: TRUST, ...(signal ? { signal } : {}) })
    return process.output()
  }

  /** Files under /workspace in the container: all of them, or those changed since the mark. */
  async #found(newer: boolean): Promise<{ path: string; size: number }[]> {
    const out = await this.#exec(['find', ROOT, ...FIND_PRUNE, '-type', 'f', ...(newer ? ['-newer', '/tmp/.wb-mark'] : []), '-printf', '%p\t%s\n'])
    if (out.exitCode !== 0) throw new Error('listing the sandbox failed: ' + tail(out.stderr))
    return new TextDecoder().decode(out.stdout).split('\n').filter(Boolean).map((line) => {
      const at = line.lastIndexOf('\t')
      return { path: line.slice(0, at), size: Number(line.slice(at + 1)) }
    })
  }

  /** One command, after the commands before it: the workspace in, the command, its changes out. */
  run(command: string, timeoutS: number): Promise<SandboxResult> {
    const run = this.#last.then(() => this.#run(command, timeoutS))
    this.#last = run.catch(() => undefined)
    return run
  }

  async #run(command: string, timeoutS: number): Promise<SandboxResult> {
    const t0 = Date.now()
    const started = await this.#ensure()
    const space = this.workspace()
    // In: what the container doesn't have as the workspace has it now.
    const listing = await space.listing(ROOT)
    const held = this.manifest.all()
    const stale = listing.filter((file) => {
      const had = held.get(file.path)
      return !had || had.size !== file.size || had.mtime !== file.mtime
    })
    const gone = [...held.keys()].filter((path) => !listing.some((file) => file.path === path))
    for (let i = 0; i < stale.length; i += 50) {
      for (const { path, data } of await space.readFiles(stale.slice(i, i + 50).map((file) => file.path))) {
        await this.#files.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true })
        await this.#files.writeFile(path, data)
      }
    }
    if (gone.length) await this.#exec(['rm', '-f', '--', ...gone])
    this.manifest.set(stale)
    this.manifest.remove(gone)
    // The command, after a mark its changes are newer than.
    await this.#exec(['touch', '/tmp/.wb-mark'])
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), timeoutS * 1000)
    let output: ExecOutput
    const ran = Date.now()
    try {
      output = await this.#exec(['bash', '-lc', command], abort.signal)
    } finally {
      clearTimeout(timer)
    }
    const commandMs = Date.now() - ran
    // Out: what it changed, and what it removed of what the container had.
    const changed = await this.#found(true)
    const now = new Set((await this.#found(false)).map((file) => file.path))
    const removed = [...this.manifest.all().keys()].filter((path) => !now.has(path))
    const skipped: string[] = []
    const written: { path: string; data: Uint8Array }[] = []
    let bytes = 0
    for (const file of changed) {
      if (file.size > FILE_MAX_BYTES || bytes + file.size > PULL_MAX_BYTES) {
        skipped.push(file.path)
        continue
      }
      bytes += file.size
      written.push({ path: file.path, data: new Uint8Array(await (await this.#files.readFile(file.path)).arrayBuffer()) })
    }
    const applied = written.length || removed.length ? await space.applyFiles(written, removed) : []
    this.manifest.set(applied)
    this.manifest.remove(removed)
    return { exitCode: output.exitCode, stdout: tail(output.stdout), stderr: tail(output.stderr), ms: Date.now() - t0, commandMs, started, pushed: stale.length, pulled: written.length, removed: removed.length, skipped }
  }
}

/** The sandbox tier's tool: a shell command in the session's container. */
export function sandboxTools(run: (command: string, timeoutS: number) => Promise<SandboxResult>): Tool<any>[] {
  return [
    {
      name: 'sandbox_exec',
      description:
        "Run a shell command (bash) in your Linux sandbox: a container with node 24, npm, git, and curl, in /workspace. /workspace holds your workspace's files: they're copied in before the command, and what it changes or removes there is copied back after (node_modules and caches stay in the sandbox; files over 8 MB, or past 32 MB in all, stay there too). The network is HTTP and HTTPS only, through an egress that allows some hosts and refuses others (403). The sandbox sleeps after 5 idle minutes and forgets all but your workspace's files. Answers the exit code, stdout, and stderr.",
      input: z.object({ command: z.string().min(1).max(8000), timeout: z.number().int().min(1).max(600).optional().describe('seconds; default 120') }),
      replay: 'unsafe',
      approval: 'never',
      async run({ command, timeout }) {
        try {
          const r = await run(command, timeout ?? 120)
          const notes = [r.started ? 'the sandbox started' : null, r.pushed ? r.pushed + ' file(s) in' : null, r.pulled ? r.pulled + ' file(s) back to the workspace' : null, r.removed ? r.removed + ' removed from the workspace' : null, r.skipped.length ? 'not copied back (too large): ' + r.skipped.join(', ') : null].filter(Boolean)
          return { text: JSON.stringify({ exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, ...(notes.length ? { sync: notes.join('; ') } : {}) }, null, 1), isError: r.exitCode !== 0 }
        } catch (error) {
          return { text: error instanceof Error ? error.message : String(error), isError: true }
        }
      },
    },
  ]
}
