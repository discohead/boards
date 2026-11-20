// Claims this machine holds, one file per board, task, and profile, readable only by its owner.
// A claim's token is a secret: it lives here and in the requests that use it, and is never printed.
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function claimsDir(env) {
  const base = env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(base, 'boards', 'claims')
}

const fileOf = (env, board, task, profile) =>
  join(claimsDir(env), createHash('sha256').update(JSON.stringify([board, String(task), profile ?? null])).digest('hex').slice(0, 40) + '.json')

/** A claim token of our own, so a retried claim is the same claim: 32 random bytes, base64url. */
export const newToken = () => randomBytes(32).toString('base64url')

export function saveClaim(env, board, task, profile, claim) {
  const dir = claimsDir(env)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = fileOf(env, board, task, profile)
  const record = { board, task: String(task), profile: profile ?? null, epoch: claim.epoch, token: claim.token, until: claim.until }
  writeFileSync(path, JSON.stringify(record) + '\n', { mode: 0o600 })
  chmodSync(path, 0o600)
  return path
}

export function loadClaim(env, board, task, profile) {
  try {
    const record = JSON.parse(readFileSync(fileOf(env, board, task, profile), 'utf8'))
    if (typeof record.token !== 'string' || typeof record.epoch !== 'number') return null
    return record
  } catch {
    return null
  }
}

export function dropClaim(env, board, task, profile) {
  rmSync(fileOf(env, board, task, profile), { force: true })
}
