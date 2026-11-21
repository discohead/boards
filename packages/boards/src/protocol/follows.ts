// The follows routes (ledger/follows.ts): follow or unfollow what a message is in, and list yours.
import { z } from 'zod'
import { QueryInt } from './fields.ts'
import { route } from './routes.ts'

route({ name: 'follow', method: 'POST', path: '/messages/:id/follow', body: z.strictObject({ on: z.boolean().optional() }), optionalBody: true })
route({ name: 'follows', method: 'GET', path: '/follows', query: z.strictObject({ limit: QueryInt(1, 500).optional() }) })
