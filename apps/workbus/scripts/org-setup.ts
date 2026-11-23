// What an owner sets up on the board once, before the app seeds the org (design/workbus.md §4.4,
// §5.1): the org's block schemas (json#seat@1, json#team@1), and the grant that gives
// worker:workbus-app the most any seat may have, plus edit in org/ to seed it (each seat is
// narrowed to post there). Idempotent: a schema already registered the same is left; the app's
// grant is updated in place.
//
//   node scripts/org-setup.ts <board url> <owner token>      e.g. http://127.0.0.1:8972/b/bus
import { ORG_SCHEMAS } from '../src/org/schemas.ts'
import { APP_CAN } from '../src/org/grant.ts'

const [url, token] = process.argv.slice(2)
if (!url || !token) throw new Error('usage: node scripts/org-setup.ts <board url> <owner token>')
const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' }
async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(url!.replace(/\/+$/, '') + path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  const answer = (await response.json()) as any
  if (!response.ok) throw new Error(method + ' ' + path + ': ' + response.status + ' ' + JSON.stringify(answer))
  return answer
}

for (const schema of ORG_SCHEMAS) {
  const answer = await call('POST', '/schemas', schema)
  console.log(schema.name + '@' + schema.version + ': ' + (answer.created ? 'registered' : 'already registered'))
}

const app = { kind: 'worker', script: 'workbus-app' }
const { grants } = await call('GET', '/grants')
const named = (grants as any[]).filter((grant) => grant.principals.some((principal: any) => principal.kind === 'worker' && principal.script === 'workbus-app'))
if (named.length > 1) throw new Error('more than one grant names worker:workbus-app (' + named.map((grant) => grant.id).join(', ') + '): merge them by hand')
if (named.length === 0) console.log('grant ' + (await call('POST', '/grants', { principals: [app], can: APP_CAN })).grant.id + ' made for worker:workbus-app')
else {
  await call('PATCH', '/grants/' + named[0].id, { can: APP_CAN })
  console.log('grant ' + named[0].id + ' for worker:workbus-app updated')
}
