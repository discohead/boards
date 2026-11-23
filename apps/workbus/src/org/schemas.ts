// The org's block schemas (design/workbus.md §4.4): json#seat@1 in a seat's doc, json#team@1 in a
// team's. The board checks every block against its schema on each write, so the reconciler reads
// data already in shape; what's left for it are the rules across docs (§4.5). A version never
// changes once registered, so each holds what later phases will use too (occupant, sessions,
// budget, edges), optional, beside what phase 2 reads. Registered schemas can't use pattern: the
// reconciler checks keys, channels, and tool names itself.

const PERMISSION = { enum: ['read', 'post', 'react', 'label', 'edit', 'sync', 'manage'] }
const GRANT = { anyOf: [{ const: 'all' }, { type: 'array', items: PERMISSION, maxItems: 7 }] }
const CHANNEL = { type: 'string', minLength: 1, maxLength: 200 }
const KEY = { type: 'string', minLength: 1, maxLength: 32 }

/** A wake rule, as design/registered-watchers.md names them. */
const WAKE = {
  anyOf: [
    { enum: ['mention', 'follow', 'assigned', 'dm', 'schedules'] },
    { type: 'object', additionalProperties: false, required: ['ready'], properties: { ready: CHANNEL } },
    { type: 'object', additionalProperties: false, required: ['docs'], properties: { docs: CHANNEL } },
    { type: 'object', additionalProperties: false, required: ['dm'], properties: { dm: { const: true } } },
    { type: 'object', additionalProperties: false, required: ['tail'], properties: { tail: { type: 'string', minLength: 1, maxLength: 1000 } } },
  ],
}

export const SEAT_SCHEMA = {
  name: 'seat',
  version: 1,
  description: "A seat's config (design/workbus.md §4.4): who occupies it, its tools, what it may do where, what wakes it, and its limits. The doc's prose is its charter.",
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['tools', 'can', 'wakes'],
    properties: {
      role: { type: 'string', minLength: 1, maxLength: 32, description: 'a built-in role, like operator, or a role of the org' },
      name: { type: 'string', minLength: 1, maxLength: 64, description: "its display name; the doc's title when absent" },
      handle: { type: 'string', minLength: 1, maxLength: 32, description: 'what @mentions settle to; the seat key when absent' },
      avatar: { type: 'string', format: 'uri', maxLength: 2048 },
      occupant: {
        type: 'object',
        additionalProperties: false,
        required: ['harness', 'model'],
        properties: { harness: { enum: ['pi'] }, model: { type: 'string', minLength: 1, maxLength: 200 } },
      },
      tools: { type: 'array', maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 64 } },
      can: { type: 'object', additionalProperties: GRANT },
      wakes: { type: 'array', maxItems: 16, items: WAKE },
      approve: { type: 'object', additionalProperties: { type: 'string', minLength: 1, maxLength: 64 }, description: 'tools behind an approval, by name, with the kind of hold each makes (§6.2): { "exec": "approval" }' },
      automatic: { type: 'array', maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 64 }, description: 'approval kinds the principal made automatic for this seat; delete, spend, and permissions still ask' },
      sessions: { type: 'integer', minimum: 1, maximum: 32 },
      budget: {
        type: 'object',
        additionalProperties: false,
        properties: { month: { type: 'number', minimum: 0 }, alert: { type: 'number', minimum: 0, maximum: 1 } },
      },
      state: { enum: ['active', 'paused'] },
    },
  },
}

export const TEAM_SCHEMA = {
  name: 'team',
  version: 1,
  description: 'A team (design/workbus.md §4.3): its seats, the queue it serves, and the typed edges among its seats.',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['seats'],
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 64 },
      seats: { type: 'array', minItems: 1, maxItems: 128, items: KEY },
      lead: KEY,
      queue: CHANNEL,
      teams: { type: 'array', maxItems: 64, items: KEY, description: 'teams nested in this one' },
      edges: {
        type: 'array',
        maxItems: 256,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['from', 'kind', 'to'],
          properties: { from: KEY, kind: { enum: ['delegates_to', 'escalates_to', 'reviews', 'consults'] }, to: KEY },
        },
      },
    },
  },
}

export const ORG_SCHEMAS = [SEAT_SCHEMA, TEAM_SCHEMA]
