// Running the CLI as a subprocess, against a board on the dev server or a stand-in.
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CLI = fileURLToPath(new URL('../boards.mjs', import.meta.url))
export const PACKAGE = fileURLToPath(new URL('../..', import.meta.url))

/** The dev server's origin: BOARDS_TEST_ORIGIN, or wrangler dev on port 8805. */
export const ORIGIN = (process.env.BOARDS_TEST_ORIGIN ?? 'http://127.0.0.1:8805').replace(/\/+$/, '')

/** A token the board's issuer signs for sub on the board at url (scripts/issuer.mjs). */
export function mint(sub, url) {
  return execFileSync(process.execPath, ['scripts/issuer.mjs', 'token', sub, url], { cwd: PACKAGE, encoding: 'utf8' }).trim()
}

/** A fresh board on the dev server, so each run starts empty, and a token for it. */
export async function freshBoard() {
  try {
    await fetch(ORIGIN + '/b/probe/')
  } catch {
    throw new Error('no board at ' + ORIGIN + ': start one with  cd packages/boards && npx wrangler dev --port 8805 --ip 127.0.0.1')
  }
  const url = ORIGIN + '/b/cli-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  return { url, token: mint('tester', url) }
}

export const configHome = () => mkdtempSync(join(tmpdir(), 'boards-cli-'))

/** Run the CLI to its end: its exit code, stdout, and stderr. */
export function run(args, { env = {}, input, timeout = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    const timer = setTimeout(() => (child.kill('SIGKILL'), reject(new Error('boards ' + args.join(' ') + ' ran over ' + timeout + ' ms'))), timeout)
    child.on('close', (code, signal) => (clearTimeout(timer), resolve({ code: code ?? (signal ? 128 : null), stdout, stderr })))
    child.stdin.end(input ?? '')
  })
}

const running = new Set()

/** Kill whatever start() left running (a test that failed before it stopped its tail). */
export function stopAll() {
  for (const child of running) child.kill('SIGKILL')
}

/** Start the CLI and leave it running: its output so far, a way to wait for a line, and stop. */
export function start(args, { env = {} } = {}) {
  const child = spawn(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  running.add(child)
  child.on('close', () => running.delete(child))
  const state = { stdout: '', stderr: '', code: undefined }
  const watchers = []
  child.stdout.on('data', (chunk) => {
    state.stdout += chunk
    for (const watcher of [...watchers]) watcher()
  })
  child.stderr.on('data', (chunk) => (state.stderr += chunk))
  const closed = new Promise((resolve) => child.on('close', (code) => resolve((state.code = code))))
  return {
    state,
    child,
    /** Resolves once stdout has a line that test(line) accepts. */
    line(test, timeout = 15_000) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const found = state.stdout.split('\n').find((line) => test(line))
          if (found === undefined) return false
          clearTimeout(timer)
          watchers.splice(watchers.indexOf(check), 1)
          resolve(found)
          return true
        }
        const timer = setTimeout(() => (watchers.splice(watchers.indexOf(check), 1), reject(new Error('no such line in ' + timeout + ' ms; stdout so far:\n' + state.stdout + '\nstderr:\n' + state.stderr))), timeout)
        watchers.push(check)
        check()
      })
    },
    /** Ctrl-C, then its exit code. */
    async interrupt() {
      child.kill('SIGINT')
      return closed
    },
    closed,
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Resolves once check() is true, or fails after timeout ms saying what it waited for. */
export async function until(check, what, timeout = 10_000) {
  const deadline = Date.now() + timeout
  while (!check()) {
    if (Date.now() > deadline) throw new Error('waited ' + timeout + ' ms for ' + what)
    await sleep(50)
  }
}
