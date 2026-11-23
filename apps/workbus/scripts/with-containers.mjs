#!/usr/bin/env node
// Run a check against dev servers that run containers, and leave nothing of them running after it:
// on success, on failure, and on Ctrl-C the servers are stopped and every container and volume they
// created is removed.
//
// The servers reach Docker through a small proxy on a socket of this run's own (WRANGLER_DOCKER_HOST,
// which wrangler dev and the Vite plugin both read). The proxy does two things:
// - It binds published ports to 127.0.0.1. workerd publishes each container sidecar's port with no
//   host address, so Docker binds it on every interface, IPv4 and IPv6, and the container is on the
//   local network while it runs. workerd, Miniflare, wrangler, and the Vite plugin have no setting for
//   the host address (Docker's own "ip": "127.0.0.1" daemon setting is the other fix).
// - It records the containers and volumes this run created, so the teardown removes exactly those,
//   and never another run's.
//
//   node scripts/with-containers.mjs [--server "<command>" <ready-url>]... -- <check command>
// With no --server, the app's own: pnpm dev:bus (8832) and pnpm dev (8831).
//   node scripts/with-containers.mjs -- node scripts/sandbox-check.mjs http://127.0.0.1:8831
import { spawn, execFileSync } from 'node:child_process'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const args = process.argv.slice(2)
const split = args.indexOf('--')
if (split < 0 || split === args.length - 1) throw new Error('usage: with-containers.mjs [--server "<command>" <ready-url>]... -- <check command>')
const servers = []
for (let i = 0; i < split; i++) {
  if (args[i] !== '--server') throw new Error('unexpected ' + args[i])
  servers.push({ command: args[i + 1], ready: args[i + 2] })
  i += 2
}
if (!servers.length) servers.push({ command: 'pnpm dev:bus', ready: 'http://127.0.0.1:8832/' }, { command: 'pnpm dev', ready: 'http://127.0.0.1:8831/' })
const check = args.slice(split + 1)

const docker = (...rest) => execFileSync('docker', rest, { encoding: 'utf8' }).trim()
const upstream = (process.env.WRANGLER_DOCKER_HOST || process.env.DOCKER_HOST || docker('context', 'inspect', '--format', '{{.Endpoints.docker.Host}}')).replace(/^unix:\/\//, '')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-docker-'))
const socket = path.join(dir, 'docker.sock')
const created = { containers: new Set(), volumes: new Set() }

/** Published ports: a binding with no host address goes to 127.0.0.1 instead of every interface. */
function localPorts(spec) {
  const host = spec?.HostConfig
  if (!host) return 0
  let changed = 0
  // "Publish all exposed ports" binds each on every interface: name them, on 127.0.0.1, with Docker still picking the host port.
  if (host.PublishAllPorts) {
    host.PortBindings ??= {}
    for (const port of Object.keys(spec.ExposedPorts ?? {})) host.PortBindings[port] ??= [{ HostIp: '127.0.0.1', HostPort: '' }]
    host.PublishAllPorts = false
    changed++
  }
  const bindings = host.PortBindings
  if (!bindings) return changed
  for (const list of Object.values(bindings)) for (const binding of list ?? []) if (!binding.HostIp || binding.HostIp === '0.0.0.0' || binding.HostIp === '::') (binding.HostIp = '127.0.0.1'), changed++
  return changed
}

const debug = process.env.WB_DOCKER_DEBUG ? (...m) => console.error('docker-proxy:', ...m) : () => {}

// A raw proxy: each connection carries one request (every request but an upgrade is sent with
// "Connection: close", so a client can't put a second request on it). A container create is read
// whole and rewritten; every other request, upgrades included, is passed through as bytes.
// Half-open both ways: a client that finishes its stdin (an exec's write side) still reads the output.
const proxy = net.createServer({ allowHalfOpen: true }, (client) => {
  let buffered = Buffer.alloc(0)
  const onData = (chunk) => {
    buffered = Buffer.concat([buffered, chunk])
    const end = buffered.indexOf('\r\n\r\n')
    if (end < 0) return
    client.removeListener('data', onData)
    client.pause()
    handle(buffered.subarray(0, end).toString('latin1'), buffered.subarray(end + 4))
  }
  client.on('data', onData)
  client.on('error', () => {})

  function handle(head, rest) {
    const [requestLine, ...headerLines] = head.split('\r\n')
    const [method, target] = requestLine.split(' ')
    const route = (target ?? '').replace(/^\/v[\d.]+/, '').split('?')[0]
    const headers = headerLines.filter((line) => !/^connection:/i.test(line))
    const upgrade = headerLines.some((line) => /^upgrade:/i.test(line))
    debug(method, target, upgrade ? 'upgrade' : '')
    const upstreamSocket = net.connect({ path: upstream, allowHalfOpen: true })
    upstreamSocket.on('error', () => client.destroy())
    client.on('close', () => upstreamSocket.destroy())
    if (method === 'POST' && route === '/containers/create') {
      const length = Number(headerLines.find((line) => /^content-length:/i.test(line))?.split(':')[1] ?? 0)
      let body = rest
      const done = () => {
        let text = body.subarray(0, length).toString()
        try {
          const spec = JSON.parse(text)
          if (localPorts(spec)) text = JSON.stringify(spec)
        } catch {}
        const out = headers.filter((line) => !/^content-length:/i.test(line)).concat('Content-Length: ' + Buffer.byteLength(text), 'Connection: close')
        upstreamSocket.write(requestLine + '\r\n' + out.join('\r\n') + '\r\n\r\n' + text)
        let answer = Buffer.alloc(0)
        upstreamSocket.on('data', (chunk) => {
          answer = Buffer.concat([answer, chunk])
          client.write(chunk)
        })
        upstreamSocket.on('end', () => {
          const id = /"Id"\s*:\s*"([0-9a-f]{64})"/.exec(answer.toString('latin1'))?.[1]
          if (id) created.containers.add(id)
          client.end()
        })
      }
      if (body.length >= length) done()
      else {
        client.on('data', (chunk) => {
          body = Buffer.concat([body, chunk])
          if (body.length >= length) done()
        })
        client.resume()
      }
      return
    }
    const out = upgrade ? headerLines : headers.concat('Connection: close')
    upstreamSocket.write(requestLine + '\r\n' + out.join('\r\n') + '\r\n\r\n')
    if (rest.length) upstreamSocket.write(rest)
    if (method === 'POST' && route === '/volumes/create') {
      let answer = Buffer.alloc(0)
      upstreamSocket.on('data', (chunk) => (answer = Buffer.concat([answer, chunk])))
      upstreamSocket.on('end', () => {
        const name = /"Name"\s*:\s*"([^"]+)"/.exec(answer.toString('latin1'))?.[1]
        if (name) created.volumes.add(name)
      })
    }
    upstreamSocket.pipe(client)
    client.pipe(upstreamSocket)
    client.resume()
  }
})
await new Promise((resolve) => proxy.listen(socket, resolve))

const children = []
let cleaned = false
function cleanup() {
  if (cleaned) return
  cleaned = true
  for (const child of children) {
    try {
      process.kill(-child.pid, 'SIGTERM') // the whole process group: pnpm, vite or wrangler, workerd
    } catch {}
  }
  const until = Date.now() + 3000
  while (Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250)
  for (const child of children) {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {}
  }
  const live = new Set(docker('ps', '--all', '--quiet', '--no-trunc').split('\n').filter(Boolean))
  const containers = [...created.containers].filter((id) => live.has(id))
  if (containers.length) docker('rm', '--force', ...containers)
  const volumes = [...created.volumes].filter((name) => docker('volume', 'ls', '--quiet', '--filter', 'name=^' + name + '$'))
  if (volumes.length) docker('volume', 'rm', '--force', ...volumes)
  const left = new Set(docker('ps', '--all', '--quiet', '--no-trunc').split('\n').filter(Boolean))
  const remaining = [...created.containers].filter((id) => left.has(id))
  console.error('with-containers: this run created ' + created.containers.size + ' containers and ' + created.volumes.size + ' volumes; removed ' + containers.length + ' still there; ' + (remaining.length ? 'STILL RUNNING: ' + remaining.join(', ') : 'none left'))
  proxy.close()
  fs.rmSync(dir, { recursive: true, force: true })
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => (cleanup(), process.exit(130)))
process.on('exit', cleanup)

async function ready(url, ms = 300_000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(2000) })
      return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error('not ready: ' + url)
}

let code = 1
try {
  for (const server of servers) {
    const child = spawn(server.command, { shell: true, detached: true, stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, WRANGLER_DOCKER_HOST: 'unix://' + socket } })
    children.push(child)
    await ready(server.ready)
  }
  code = await new Promise((resolve) => spawn(check[0], check.slice(1), { stdio: 'inherit' }).on('exit', (status) => resolve(status ?? 1)))
} catch (error) {
  console.error('with-containers:', error instanceof Error ? error.message : error)
} finally {
  cleanup()
}
process.exit(code)
