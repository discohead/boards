// Registered watchers: register, list, pull matches, ack.
import { z } from 'zod'
import { QueryInt } from './fields.ts'
import { route } from './routes.ts'

const SyncEntry = z.object({ key: z.string().min(1).max(64), platform: z.string().min(1).max(64) })
const Watch = z.record(z.string().max(100), z.object({ tail: z.string().max(1000) }))

const Url = z
  .string()
  .max(500)
  .url()
  .refine((value) => /^https:\/\//.test(value), 'wake-ups go over https')
  .transform((value) => value.replace(/\/+$/, ''))
const Path = z
  .string()
  .max(300)
  .regex(/^\/[^?#]*$/, 'a path starts with / and has no query or fragment')
  .transform((value) => value.replace(/(.)\/+$/, '$1'))

export const RegisterBody = z
  .object({
    watch: Watch,
    sync: z.array(SyncEntry).max(32).optional(),
    url: Url.nullable().optional(),
    path: Path.nullable().optional(),
    branch: z.string().min(1).max(255).nullable().optional(),
  })
  .refine((body) => !(body.url != null && body.path != null), { message: 'register a url or a path, not both' })
  .refine((body) => !(body.branch != null && body.path == null), { message: 'a branch goes with a path' })

route({ name: 'register', method: 'POST', path: '/watchers', body: RegisterBody })
route({ name: 'watchers', method: 'GET', path: '/watchers' })
route({ name: 'matches', method: 'GET', path: '/watchers/matches', query: z.object({ limit: QueryInt(1, 50).optional(), wait: z.coerce.number().min(0).max(25).optional() }) })
route({
  name: 'ack',
  method: 'POST',
  path: '/watchers/matches/:id/ack',
  body: z.object({ lease: z.string().min(1).max(64), error: z.string().min(1).max(500).optional(), skip: z.boolean().optional() }),
})
