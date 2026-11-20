// The archive's routes: where a board's history stands (hot, sealed, cold), its settings, and a
// bench fill. Each takes manage everywhere; the fill only runs where ARCHIVE_BENCH is 1.
import { z } from 'zod'
import { ChannelPath, QueryBool } from './fields.ts'
import { route } from './routes.ts'

const Ms = z.number().int().min(0)

route({ name: 'archive', method: 'GET', path: '/archive', query: z.strictObject({ live: QueryBool.optional() }) })
route({
  name: 'configureArchive',
  method: 'POST',
  path: '/archive',
  body: z.strictObject({
    enabled: z.boolean().optional(),
    sealAfterMs: Ms.optional(),
    coldAfterMs: Ms.optional(),
    segment: z.number().int().min(16).max(100_000).optional(),
    keep: z.number().int().min(1).optional(),
    everyMs: z.number().int().min(50).optional(),
    stepThreads: z.number().int().min(1).max(1000).optional(),
    pauseMs: Ms.optional(),
    freezeAfterMs: Ms.optional(),
    pageThreads: z.number().int().min(1).max(4096).optional(),
    run: z.boolean().optional(),
    reset: z.boolean().optional(),
    forget: z.boolean().optional(),
  }),
  optionalBody: true,
})
route({
  name: 'fillArchive',
  method: 'POST',
  path: '/archive/fill',
  body: z.strictObject({
    channel: ChannelPath,
    threads: z.number().int().min(1).max(10_000),
    replies: z.number().int().min(0).max(1000),
    at: z.number().int().min(0).optional(),
    spanMs: Ms.optional(),
    text: z.number().int().min(1).max(10_000).optional(),
    keyed: z.boolean().optional(),
    prefix: z.string().max(40).optional(),
  }),
})