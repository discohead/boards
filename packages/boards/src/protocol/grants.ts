// The grants routes: who may do what on the board, listed, explained, and changed. Every body and
// principal is strict: an unknown key is 400 invalid_request, never dropped.
import { z } from 'zod'
import { ChannelPath } from './fields.ts'
import { route } from './routes.ts'

const Environments = z.array(z.string().min(1).max(100)).min(1).max(16)
const ClaimValue = z.string().min(1).max(1000)

/** A principal as a grant names it. project and all-projects name the account's Workers (a Worker is a project here). */
export const PrincipalInput = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('user'), email: z.string().min(3).max(320).optional(), userId: z.string().min(1).max(200).optional() }),
  z.strictObject({ kind: z.literal('project'), project: z.string().min(1).max(200), environments: Environments.optional() }),
  z.strictObject({ kind: z.literal('worker'), script: z.string().min(1).max(200) }),
  z.strictObject({ kind: z.literal('github'), repository: z.string().min(3).max(200), workflow: z.string().min(1).max(300).optional(), branch: z.string().min(1).max(255).optional(), event: z.string().min(1).max(64).optional() }),
  z.strictObject({ kind: z.literal('oidc'), issuer: z.string().min(1).max(1000), claims: z.record(z.string().min(1).max(200), z.union([ClaimValue, z.array(ClaimValue).min(1).max(32)])) }),
  z.strictObject({ kind: z.literal('all-users') }),
  z.strictObject({ kind: z.literal('all-projects'), environments: Environments.optional() }),
  z.strictObject({ kind: z.literal('all-workers') }),
  z.strictObject({ kind: z.literal('app'), app: z.string().min(1).max(200) }),
  z.strictObject({ kind: z.literal('all-apps') }),
  z.strictObject({ kind: z.literal('everyone') }),
])

/** A grant's can on the wire: pattern to 'all' or a list of permissions, checked as written by the Ledger. */
export const GrantCan = z.record(z.string().min(1).max(2049), z.union([z.literal('all'), z.array(z.string().min(1).max(16)).max(8)]))

const Principals = z.array(PrincipalInput).max(64)
const Changes = z.array(PrincipalInput).min(1).max(32)

export const GrantBody = z.strictObject({ principals: Principals, can: GrantCan, lockMeOut: z.boolean().optional() })
export const CreateGrantsBody = z.strictObject({ grants: z.array(z.strictObject({ principals: Principals, can: GrantCan })).min(1).max(16), lockMeOut: z.boolean().optional() })
export const UpdateGrantBody = z
  .strictObject({ add: Changes.optional(), remove: Changes.optional(), can: GrantCan.optional(), lockMeOut: z.boolean().optional() })
  .refine((body) => body.add !== undefined || body.remove !== undefined || body.can !== undefined, { message: 'name principals to add or remove, or a can' })
export const RevokeGrantBody = z.strictObject({ lockMeOut: z.boolean().optional() })

export const ExplainQuery = z
  .strictObject({
    channel: ChannelPath,
    user: z.string().min(1).max(320).optional(),
    project: z.string().min(1).max(200).optional(),
    environment: z.string().min(1).max(100).optional(),
    worker: z.string().min(1).max(200).optional(),
    github: z.string().min(3).max(200).optional(),
    workflow: z.string().min(1).max(300).optional(),
    branch: z.string().min(1).max(255).optional(),
    event: z.string().min(1).max(64).optional(),
    oidc: z.string().min(1).max(1000).optional(),
    claim: z.union([z.string(), z.array(z.string())]).optional(),
    app: z.string().min(1).max(200).optional(),
  })
  .refine((query) => [query.user, query.project, query.worker, query.github, query.oidc, query.app].filter((value) => value !== undefined).length <= 1, { message: 'name one principal: user, project, worker, github, oidc, or app' })
  .refine((query) => query.environment === undefined || query.project !== undefined, { message: 'environment goes with project' })
  .refine((query) => (query.workflow === undefined && query.branch === undefined && query.event === undefined) || query.github !== undefined, { message: 'workflow, branch, and event go with github' })
  .refine((query) => query.claim === undefined || query.oidc !== undefined, { message: 'claim goes with oidc' })

route({ name: 'grants', method: 'GET', path: '/grants' })
route({ name: 'createGrant', method: 'POST', path: '/grants', body: GrantBody })
route({ name: 'createGrants', method: 'POST', path: '/grants/batch', body: CreateGrantsBody })
route({ name: 'updateGrant', method: 'PATCH', path: '/grants/:id', body: UpdateGrantBody })
route({ name: 'revokeGrant', method: 'POST', path: '/grants/:id/revoke', body: RevokeGrantBody, optionalBody: true })
route({ name: 'explainGrants', method: 'GET', path: '/grants/explain', query: ExplainQuery })
