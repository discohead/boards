// Wakes (design/registered-watchers.md): registered watchers the board delivers to a
// service sink its deployment declares. Not in protocol v1: Workbus' own, beside /watchers.
import { z } from 'zod'
import { route } from './routes.ts'

const Channel = z.string().min(1).max(200)
export const Rule = z.union([
  z.enum(['mention', 'follow', 'assigned', 'dm', 'schedules']),
  z.object({ ready: Channel }).strict(),
  z.object({ docs: Channel }).strict(),
  z.object({ dm: z.literal(true) }).strict(),
  z.object({ tail: z.string().max(1000) }).strict(),
])
const Revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)

route({
  name: 'setWake',
  method: 'POST',
  path: '/wakes',
  status: 'created',
  body: z.object({ key: z.string().min(1).max(64), sink: z.string().min(1).max(64), rules: z.record(z.string().max(32), Rule), revision: Revision.optional() }).strict(),
})
route({ name: 'wakes', method: 'GET', path: '/wakes', query: z.object({ prefix: z.string().max(64).optional() }) })
route({ name: 'deleteWake', method: 'POST', path: '/wakes/:key/delete', body: z.object({ revision: Revision.optional() }).strict(), optionalBody: true })
