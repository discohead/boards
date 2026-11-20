// The protocol's field schemas: what every request is checked against before it reaches the Ledger.
import { z } from 'zod'

export const storable = (value: string) => !value.includes('\u0000') && value.isWellFormed()
export const Ref = z.string().min(1).max(128)
export const ChannelPath = z.string().max(2048).regex(/^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/, 'invalid channel path')
export const ChannelPattern = z.string().max(2049)
const INHERITED = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype'])
export const LabelKey = z
  .string()
  .max(64, { error: (issue) => JSON.stringify(issue.input) + " isn't a label key: one is 1 to 64 lowercase letters, numbers, ., _, and -, starting with a letter or number" })
  .regex(/^[a-z0-9][a-z0-9_.-]*$/, { error: (issue) => JSON.stringify(issue.input) + " isn't a label key: one is 1 to 64 lowercase letters, numbers, ., _, and -, starting with a letter or number" })
  .refine((key) => !INHERITED.has(key), 'label key is a reserved name')
export const LabelValue = z
  .string()
  .max(256, { error: (issue) => 'a label value is at most 256 characters, and this one has ' + String((issue.input as string)?.length) })
  .refine(storable, 'label value has a NUL character or a lone surrogate')
export const NewLabelValue = LabelValue.refine((value) => !/\p{Cc}/u.test(value), 'label value has a control character')
export const Labels = z.record(LabelKey, LabelValue)
export const NewLabels = z.record(LabelKey, NewLabelValue)
export const Emoji = z.string().max(64).regex(/^[a-z0-9_+-]+$/, 'invalid emoji name').refine((name) => !INHERITED.has(name) && name !== '__proto__', 'emoji name is a reserved name')
export const AttachmentId = z.string().regex(/^(?:[A-Za-z0-9_-]{22}|att_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/, 'invalid attachment id')
export const ExternalTarget = z.string().min(3).max(300)
export const SentText = z.string().refine((text) => text.trim().length > 0, 'message text is empty').refine(storable, 'message text has a NUL character or a lone surrogate')
export const ClientId = z.string().min(1).max(200).refine(storable, 'id has a NUL character or a lone surrogate')
export const QueryInt = (min: number, max: number) => z.coerce.number().int().min(min).max(max)
export const QueryBool = z.enum(['true', 'false', '1', '0']).transform((value) => value === 'true' || value === '1')
export const LabelFilter = z.string().regex(/^[a-z0-9][a-z0-9_.-]*(=.*)?$/, 'label filters look like key, key=value, or key=a|b')

export const Filters = z.object({
  channel: z.string().optional(),
  re: Ref.optional(),
  by: z.string().optional(),
  mentions: z.string().optional(),
  label: z.union([LabelFilter, z.array(LabelFilter)]).optional(),
  from: z.string().min(1).max(165).optional(),
  text: z.string().min(1).max(200).optional(),
})
