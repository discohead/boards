// The schedules routes: post a message later, once or repeating; list them; cancel one.
import { z } from 'zod'
import { AttachmentId, ChannelPath, NewLabels, QueryBool, Ref } from './fields.ts'
import { route } from './routes.ts'

const Duration = z.string().regex(/^\d+(\.\d+)?(s|m|h|d)$/, 'durations look like 30s, 30m, 12h, or 1d')
const Instant = z.string().datetime({ offset: true })

export const ScheduleBody = z
  .object({
    channel: ChannelPath.optional(),
    re: Ref.optional(),
    text: z.string().default(''),
    labels: NewLabels.optional(),
    noSync: z.boolean().optional(),
    attachments: z.array(AttachmentId).optional(),
    in: Duration.optional(),
    at: Instant.optional(),
    every: Duration.optional(),
    until: Instant.optional(),
    for: Duration.optional(),
    times: z.number().int().positive().optional(),
  })
  .refine((body) => body.text.trim().length > 0 || (body.attachments?.length ?? 0) > 0, { path: ['text'], message: 'message text is empty' })
  .refine((body) => (body.channel === undefined) !== (body.re === undefined), { message: 'a schedule needs \u0060channel\u0060 for a new thread, or \u0060re\u0060 for a reply' })
  .refine((body) => body.in !== undefined || body.at !== undefined || body.every !== undefined, { message: 'say when: \u0060in\u0060, \u0060at\u0060, or \u0060every\u0060' })
  .refine((body) => !(body.in !== undefined && body.at !== undefined), { message: '\u0060in\u0060 and \u0060at\u0060 contradict each other' })
  .refine((body) => [body.until, body.for, body.times].filter((value) => value !== undefined).length <= 1, { message: 'pick one stop: \u0060until\u0060, \u0060for\u0060, or \u0060times\u0060' })
  .refine((body) => body.every !== undefined || (body.until === undefined && body.for === undefined && body.times === undefined), { message: '\u0060until\u0060, \u0060for\u0060, and \u0060times\u0060 stop a repeat: add \u0060every\u0060' })

export const SchedulesQuery = z.object({ re: Ref.optional(), channel: z.string().optional(), by: z.string().optional(), all: QueryBool.optional() })

route({ name: 'schedule', method: 'POST', path: '/schedules', body: ScheduleBody, status: 201 })
route({ name: 'schedules', method: 'GET', path: '/schedules', query: SchedulesQuery })
// The body is not read: clients send {}.
route({ name: 'cancelSchedule', method: 'POST', path: '/schedules/:id/cancel' })
