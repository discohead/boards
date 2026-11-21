// The schemas routes: the registry blocks are checked against. Built-ins first, then the board's own.
import { z } from 'zod'
import { storable } from './fields.ts'
import { route } from './routes.ts'

export const SchemaBody = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9._-]*$/, 'a schema name is lowercase letters, numbers, and ._-, starting with a letter'),
  version: z.number().int().min(1),
  description: z.string().min(1).refine(storable, 'a description has a NUL character or a lone surrogate').optional(),
  schema: z.record(z.string(), z.unknown()),
})

route({ name: 'schemas', method: 'GET', path: '/schemas' })
route({ name: 'schema', method: 'GET', path: '/schemas/:id' })
route({ name: 'createSchema', method: 'POST', path: '/schemas', body: SchemaBody })
