// A provider's credentials: a Secrets Store binding (its get() reads the value) or a plain Worker
// secret, so a deployment keeps them in either. The board log never holds one.
//
//   "secrets_store_secrets": [{ "binding": "SLACK_SIGNING_SECRET", "store_id": "…", "secret_name": "slack-signing-secret" }]
//   slackSync({ …, options: { signingSecret: env.SLACK_SIGNING_SECRET, … } })   // either kind

/** A Secrets Store binding: what `secrets_store_secrets` puts in env. */
export type SecretBinding = { get(): Promise<string> }
/** A credential as a deployment holds it: a Worker secret's string, or a Secrets Store binding. */
export type Secret = string | SecretBinding

/** Whether a value is a credential this accessor reads. */
export const isSecret = (value: unknown): value is Secret => typeof value === 'string' || (typeof value === 'object' && value !== null && typeof (value as SecretBinding).get === 'function')

/** The credential's value; throws, naming it, when there's none to read. */
export async function readSecret(secret: Secret | undefined, name = 'secret'): Promise<string> {
  if (secret === undefined || secret === null) throw new Error(name + ' is not configured')
  let value: unknown
  if (typeof secret === 'string') value = secret
  else if (typeof secret.get === 'function') {
    try {
      value = await secret.get()
    } catch (error) {
      throw new Error(name + ": Secrets Store couldn't read it: " + String((error as Error)?.message ?? error))
    }
  } else throw new Error(name + ' is neither a string nor a Secrets Store binding')
  if (typeof value !== 'string' || value.length === 0) throw new Error(name + ' is empty')
  return value
}

/** A reader that asks the store once and keeps the value for this isolate's request. */
export function secretReader(secret: Secret | undefined, name?: string): () => Promise<string> {
  let value: Promise<string> | null = null
  return () => {
    value ??= readSecret(secret, name).catch((error) => {
      value = null
      throw error
    })
    return value
  }
}

const encoder = new TextEncoder()

/** The lowercase hex HMAC-SHA256 of a message under a key. */
export async function hmacHex(key: string, message: string): Promise<string> {
  const imported = await crypto.subtle.importKey('raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', imported, encoder.encode(message)))
  return [...signature].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Equal strings, compared in time that doesn't depend on where they differ. */
export function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
