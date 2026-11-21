// GitHub Projects (v2) on a board (design/github-projects.md): an item is the thread the GitHub sync
// makes for its issue (or a thread in the Project's channel), its membership and fields are labels
// on that thread's root (project.<name>, project.<name>.<field>), and one field, Status, can drive
// the thread as a task by an explicit mapping. GitHub's webhooks say an item changed; the item is
// read through GraphQL then, so a stale or reordered delivery writes the item as it is now.
import { SyncRefused, SyncRetry, type Call } from './provider.ts'

export type ProjectStatus = { field?: string; ready?: string; claimed?: string; blocked?: string; completed?: string; canceled?: string }
export type ProjectConfig = { project: string; channel: string; status?: ProjectStatus }

type Field = { id: string; name: string; dataType: string; options?: { id: string; name: string }[]; iterations?: { id: string; title: string }[] }
type Project = { id: string; name: string; config: ProjectConfig; fields: Field[]; at: number }
type Content = { __typename: 'Issue' | 'PullRequest' | 'DraftIssue'; id: string; number?: number; title: string; url?: string; body?: string; repository?: { nameWithOwner: string }; author?: { login: string; avatarUrl?: string; databaseId?: number } | null }
export type Item = { id: string; isArchived: boolean; project: { id: string }; content: Content | null; values: Record<string, string> }

/** A field's name as a label key's last part: Target date is target-date. */
export const fieldKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'field'
const KINDS = new Set(['TEXT', 'NUMBER', 'DATE', 'SINGLE_SELECT', 'ITERATION'])
const STATES: (keyof ProjectStatus)[] = ['ready', 'claimed', 'blocked', 'completed', 'canceled']

const FIELD_COMMON = 'field { ... on ProjectV2FieldCommon { id name dataType } }'
const ITEM = 'id isArchived project { id } content { __typename ... on Issue { id number title url body repository { nameWithOwner } author { login avatarUrl ... on User { databaseId } ... on Bot { databaseId } } } ... on PullRequest { id number title url body repository { nameWithOwner } author { login avatarUrl ... on User { databaseId } ... on Bot { databaseId } } } ... on DraftIssue { id title body } } fieldValues(first: 50) { nodes { __typename ... on ProjectV2ItemFieldTextValue { text ' + FIELD_COMMON + ' } ... on ProjectV2ItemFieldNumberValue { number ' + FIELD_COMMON + ' } ... on ProjectV2ItemFieldDateValue { date ' + FIELD_COMMON + ' } ... on ProjectV2ItemFieldSingleSelectValue { name ' + FIELD_COMMON + ' } ... on ProjectV2ItemFieldIterationValue { title ' + FIELD_COMMON + ' } } }'

export type ProjectsTools = { graphql: (org: string, query: string, variables: Record<string, unknown>) => Promise<any> }

/** The Projects a GitHub sync keeps: config by name, resolved to node IDs and fields as needed. */
export function projects(configs: Record<string, ProjectConfig>, tools: ProjectsTools) {
  const byName = new Map<string, Project>()
  const orgOf = (config: ProjectConfig) => config.project.split('/')[0]!

  /** A Project by name, with its fields: read once, and again when older than ten minutes or when asked (a field or option not found). */
  const load = async (name: string, fresh = false): Promise<Project> => {
    const config = configs[name]
    if (!config) throw new SyncRefused('no Project named ' + name + ' in this sync')
    const known = byName.get(name)
    if (known && !fresh && Date.now() - known.at < 10 * 60 * 1000) return known
    const [org, number] = config.project.split('/')
    const data = await tools.graphql(org!, 'query($org: String!, $n: Int!) { organization(login: $org) { projectV2(number: $n) { id fields(first: 50) { nodes { __typename ... on ProjectV2FieldCommon { id name dataType } ... on ProjectV2SingleSelectField { options { id name } } ... on ProjectV2IterationField { configuration { iterations { id title } completedIterations { id title } } } } } } } }', { org, n: Number(number) })
    const found = data?.organization?.projectV2
    if (!found) throw new SyncRefused('no Project ' + config.project + ' that this app can read')
    const fields: Field[] = (found.fields.nodes as any[]).filter(Boolean).map((node) => ({
      id: node.id,
      name: node.name,
      dataType: node.dataType,
      ...(node.options ? { options: node.options } : {}),
      ...(node.configuration ? { iterations: [...node.configuration.iterations, ...node.configuration.completedIterations] } : {}),
    }))
    const project = { id: found.id, name, config, fields, at: Date.now() }
    byName.set(name, project)
    return project
  }

  /** The configured Project with this node ID, or null. */
  const byNode = async (id: string): Promise<Project | null> => {
    for (const name of Object.keys(configs)) {
      const project = await load(name)
      if (project.id === id) return project
    }
    return null
  }

  /** An item as it is now, its field values by label key; null when it's gone. */
  const read = async (project: Project, itemId: string): Promise<Item | null> => {
    const data = await tools.graphql(orgOf(project.config), 'query($id: ID!) { node(id: $id) { ... on ProjectV2Item { ' + ITEM + ' } } }', { id: itemId })
    const node = data?.node
    if (!node || !node.id) return null
    const values: Record<string, string> = {}
    for (const value of node.fieldValues.nodes as any[]) {
      if (!value?.field || !KINDS.has(value.field.dataType)) continue
      const text = value.text ?? (value.number !== undefined && value.number !== null ? String(value.number) : undefined) ?? value.date ?? value.name ?? value.title
      if (text !== undefined && text !== null && text !== '') values[fieldKey(value.field.name)] = String(text)
    }
    return { id: node.id, isArchived: Boolean(node.isArchived), project: node.project, content: node.content, values }
  }

  /** What GitHub takes for a field from a label's value, or why it can't. */
  const valueOf = (field: Field, value: string): Record<string, unknown> | string => {
    switch (field.dataType) {
      case 'TEXT': return { text: value }
      case 'NUMBER': return Number.isFinite(Number(value)) && value.trim() !== '' ? { number: Number(value) } : value + ' is not a number'
      case 'DATE': return /^\d{4}-\d{2}-\d{2}$/.test(value) ? { date: value } : value + ' is not a date (YYYY-MM-DD)'
      case 'SINGLE_SELECT': {
        const option = field.options?.find((entry) => entry.name.toLowerCase() === value.toLowerCase())
        return option ? { singleSelectOptionId: option.id } : field.name + ' has no option ' + JSON.stringify(value)
      }
      case 'ITERATION': {
        const iteration = field.iterations?.find((entry) => entry.title.toLowerCase() === value.toLowerCase())
        return iteration ? { iterationId: iteration.id } : field.name + ' has no iteration ' + JSON.stringify(value)
      }
      default: return field.name + " can't be set from the board"
    }
  }

  /** Sets one field (null clears it); a value it can't take is the reason, else null. */
  const setField = async (project: Project, itemId: string, key: string, value: string | null): Promise<string | null> => {
    let field = project.fields.find((entry) => fieldKey(entry.name) === key)
    if (!field || (value !== null && typeof valueOf(field, value) === 'string')) {
      project = await load(project.name, true)
      field = project.fields.find((entry) => fieldKey(entry.name) === key)
    }
    if (!field || !KINDS.has(field.dataType)) return 'the Project has no field ' + key + ' the board can set'
    const org = orgOf(project.config)
    if (value === null) {
      await tools.graphql(org, 'mutation($p: ID!, $i: ID!, $f: ID!) { clearProjectV2ItemFieldValue(input: { projectId: $p, itemId: $i, fieldId: $f }) { projectV2Item { id } } }', { p: project.id, i: itemId, f: field.id })
      return null
    }
    const input = valueOf(field, value)
    if (typeof input === 'string') return input
    await tools.graphql(org, 'mutation($p: ID!, $i: ID!, $f: ID!, $v: ProjectV2FieldValue!) { updateProjectV2ItemFieldValue(input: { projectId: $p, itemId: $i, fieldId: $f, value: $v }) { projectV2Item { id } } }', { p: project.id, i: itemId, f: field.id, v: input })
    return null
  }

  const statusKey = (project: Project) => fieldKey(project.config.status?.field ?? 'Status')

  return {
    load,
    byNode,
    read,
    setField,
    statusKey,
    names: () => Object.keys(configs),
    orgOf,
    /** Adds an issue or pull request to a Project by its node ID: the item's ID. */
    async add(project: Project, contentId: string): Promise<string> {
      const data = await tools.graphql(orgOf(project.config), 'mutation($p: ID!, $c: ID!) { addProjectV2ItemById(input: { projectId: $p, contentId: $c }) { item { id } } }', { p: project.id, c: contentId })
      const id = data?.addProjectV2ItemById?.item?.id
      if (!id) throw new SyncRetry('GitHub added no item to ' + project.config.project)
      return id
    },
    async archive(project: Project, itemId: string, archived: boolean) {
      const mutation = archived ? 'archiveProjectV2Item' : 'unarchiveProjectV2Item'
      await tools.graphql(orgOf(project.config), 'mutation($p: ID!, $i: ID!) { ' + mutation + '(input: { projectId: $p, itemId: $i }) { item { id } } }', { p: project.id, i: itemId })
    },
    /** The option a task state maps to, or null. */
    optionFor(project: Project, state: string): string | null {
      const status = project.config.status
      if (!status) return null
      const mapped = state === 'ready' || state === 'claimed' || state === 'blocked' || state === 'completed' || state === 'canceled' ? status[state] : undefined
      return mapped ?? null
    },
    /** The task change a Status option means: ready, completed, or canceled; claimed and blocked move nothing. */
    intentOf(project: Project, option: string | undefined): 'ready' | 'completed' | 'canceled' | null {
      const status = project.config.status
      if (!status || option === undefined) return null
      for (const state of ['ready', 'completed', 'canceled'] as const) if (status[state] !== undefined && status[state]!.toLowerCase() === option.toLowerCase()) return state
      return null
    },
  }
}

export type Projects = ReturnType<typeof projects>

/** The labels an item means on its thread: membership and each field, under project.<name>. */
export function labelsOf(name: string, item: Item | null): Record<string, string> {
  if (!item || item.isArchived) return {}
  const out: Record<string, string> = { ['project.' + name]: 'yes' }
  for (const [key, value] of Object.entries(item.values)) {
    out['project.' + name + '.' + key] = value.slice(0, 1000)
  }
  return out
}

/** The label write that makes a root's project.<name> labels say what an item does: null when they already do. */
export function labelChange(name: string, current: Record<string, string>, item: Item | null): { set: Record<string, string>; unset: string[] } | null {
  const want = labelsOf(name, item)
  const prefix = 'project.' + name
  const set: Record<string, string> = {}
  const unset: string[] = []
  for (const [key, value] of Object.entries(want)) if (current[key] !== value) set[key] = value
  for (const key of Object.keys(current)) if ((key === prefix || key.startsWith(prefix + '.')) && !(key in want)) unset.push(key)
  return Object.keys(set).length || unset.length ? { set, unset } : null
}

/** The task call a Status intent makes on a root, given its task now; null when there's nothing to do. */
export async function applyIntent(call: Call, root: string, task: { state: string } | null, intent: 'ready' | 'completed' | 'canceled', where: string) {
  if (intent === 'ready') {
    if (!task) return call('createTask', { re: root })
    if (task.state === 'failed') return call('reopenTask', { id: root })
    return null
  }
  if (!task || !['waiting', 'ready', 'claimed', 'blocked'].includes(task.state)) return null
  if (intent === 'canceled') return call('cancelTask', { id: root, reason: 'Moved to won’t do in ' + where })
  // Completing takes a claim: the sync claims a ready task to complete it, and never takes another's.
  if (task.state !== 'ready') return null
  const claimed = await call('claimTask', { id: root })
  return call('completeTask', { id: root, epoch: claimed.claim.epoch, token: claimed.claim.token, result: 'Done in ' + where })
}

export { STATES }
