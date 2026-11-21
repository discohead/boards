// GitHub Projects on a board (design/github-projects.md), against a fake GraphQL API: which item
// webhooks are kept, an item imported onto its issue's thread or a new one with its fields as
// labels, Status moving the thread's task, and labels and task states written back.
//   node --test test/sync/github-projects.node-test.ts
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { test } from 'node:test'
import { githubProvider } from '../../src/sync/github.ts'

const SECRET = 'gh-secret'
const PROJECT = 'PVT_1'
type ItemState = { id: string; archived: boolean; content: any; values: Record<string, string> }
const items = new Map<string, ItemState>()
const fields = [
  { id: 'F_title', name: 'Title', dataType: 'TITLE' },
  { id: 'F_status', name: 'Status', dataType: 'SINGLE_SELECT', options: [{ id: 'o_todo', name: 'Todo' }, { id: 'o_ready', name: 'Ready for agent' }, { id: 'o_prog', name: 'In progress' }, { id: 'o_done', name: 'Done' }, { id: 'o_wont', name: "Won't do" }] },
  { id: 'F_pri', name: 'Priority', dataType: 'SINGLE_SELECT', options: [{ id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }] },
  { id: 'F_due', name: 'Target date', dataType: 'DATE' },
]
const mutations: { name: string; variables: any }[] = []
const last = (): { name: string; variables: any } | undefined => mutations[mutations.length - 1]
let added = 0

const fieldValue = (name: string, value: string) => {
  const field = fields.find((entry) => entry.name === name)!
  const common = { field: { id: field.id, name: field.name, dataType: field.dataType } }
  return field.dataType === 'DATE' ? { __typename: 'ProjectV2ItemFieldDateValue', date: value, ...common } : field.dataType === 'TITLE' ? { __typename: 'ProjectV2ItemFieldTextValue', text: value, ...common } : { __typename: 'ProjectV2ItemFieldSingleSelectValue', name: value, ...common }
}

globalThis.fetch = (async (input: string, init: RequestInit = {}) => {
  const url = new URL(input)
  if (url.pathname !== '/graphql') return new Response('{}', { status: 404 })
  const { query, variables } = JSON.parse(String(init.body))
  const data = (value: unknown) => Response.json({ data: value })
  if (query.includes('organization(login:')) return data({ organization: { projectV2: { id: PROJECT, fields: { nodes: fields.map((field) => ({ __typename: 'X', ...field, ...(field.options ? { options: field.options } : {}) })) } } } })
  if (query.includes('node(id:')) {
    const item = items.get(variables.id)
    if (!item) return data({ node: null })
    return data({ node: { id: item.id, isArchived: item.archived, project: { id: PROJECT }, content: item.content, fieldValues: { nodes: Object.entries(item.values).map(([name, value]) => fieldValue(name, value)) } } })
  }
  if (query.includes('repository(owner:')) return data({ repository: { issueOrPullRequest: { id: 'I_' + variables.num } } })
  const name = query.match(/mutation[^{]*\{\s*(\w+)/)?.[1]
  mutations.push({ name, variables })
  if (name === 'updateProjectV2ItemFieldValue') {
    const field = fields.find((entry) => entry.id === variables.f)!
    const item = items.get(variables.i)!
    const v = variables.v
    item.values[field.name] = v.singleSelectOptionId ? field.options!.find((option) => option.id === v.singleSelectOptionId)!.name : v.date ?? v.text ?? String(v.number)
    return data({ updateProjectV2ItemFieldValue: { projectV2Item: { id: item.id } } })
  }
  if (name === 'clearProjectV2ItemFieldValue') {
    const field = fields.find((entry) => entry.id === variables.f)!
    delete items.get(variables.i)!.values[field.name]
    return data({ clearProjectV2ItemFieldValue: { projectV2Item: { id: variables.i } } })
  }
  if (name === 'addProjectV2ItemById') {
    const id = 'PVTI_new' + ++added
    items.set(id, { id, archived: false, content: { __typename: 'Issue', id: variables.c }, values: {} })
    return data({ addProjectV2ItemById: { item: { id } } })
  }
  if (name === 'archiveProjectV2Item' || name === 'unarchiveProjectV2Item') {
    items.get(variables.i)!.archived = name === 'archiveProjectV2Item'
    return data({ [name]: { item: { id: variables.i } } })
  }
  return new Response('{"errors":[{"message":"unknown"}]}')
}) as typeof fetch

const STATUS = { field: 'Status', ready: 'Ready for agent', claimed: 'In progress', completed: 'Done', canceled: "Won't do" }
const provider = githubProvider({ webhookSecret: { get: async () => SECRET }, repos: { 'acme/web': 'web' }, token: async () => 'repo-token', orgToken: async () => 'org-token', botUserId: '42', apiBase: 'https://api.test', projects: { roadmap: { project: 'acme/7', channel: 'roadmap', status: STATUS } } })

function itemWebhook(item: string, action = 'edited', sender = 7, project = PROJECT) {
  const body = JSON.stringify({ action, projects_v2_item: { node_id: item, project_node_id: project, content_type: 'Issue' }, sender: { id: sender, login: 'ada' }, organization: { login: 'acme' } })
  return new Request('https://board.test/webhooks/github', { method: 'POST', headers: { 'x-github-event': 'projects_v2_item', 'x-github-delivery': 'd-' + item + action, 'x-hub-signature-256': 'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex') }, body })
}

/** A board, as the sync calls it: threads by root, targets, labels, and tasks. */
function board() {
  const calls: [string, any][] = []
  const roots = new Map<string, { labels: Record<string, string>; task: { state: string } | null; targets: string[] }>()
  roots.set('10', { labels: { issue: 'acme/web#5' }, task: null, targets: ['github:acme/web:5'] })
  let next = 20
  const byTarget = (target: string) => [...roots.entries()].find(([, root]) => root.targets.includes(target))?.[0] ?? null
  const call = async (method: string, input: any): Promise<any> => {
    calls.push([method, input])
    switch (method) {
      case 'syncFind': { const root = byTarget(input.thread); return root ? { thread: 't' + root } : {} }
      case 'syncThread': return { root: input.thread.slice(1) }
      case 'sync': roots.get(input.id)!.targets.push(input.target); return { attached: true }
      case 'syncImport':
        if (input.op === 'post') {
          const id = String(next++)
          roots.set(id, { labels: { ...input.labels }, task: null, targets: [input.origin.thread] })
          return { message: id }
        }
        if (input.op === 'labels') {
          const root = roots.get(byTarget(input.origin.thread)!)!
          Object.assign(root.labels, input.set)
          for (const key of input.unset) delete root.labels[key]
          return {}
        }
        throw new Error('unexpected import ' + input.op)
      case 'message': return { message: { id: input.id, labels: roots.get(input.id)!.labels, task: roots.get(input.id)!.task } }
      case 'createTask': roots.get(input.re)!.task = { state: 'ready' }; return {}
      case 'reopenTask': roots.get(input.id)!.task = { state: 'ready' }; return {}
      case 'claimTask': roots.get(input.id)!.task = { state: 'claimed' }; return { claim: { epoch: 1, token: 'tok' } }
      case 'completeTask': roots.get(input.id)!.task = { state: 'completed' }; return {}
      case 'cancelTask': roots.get(input.id)!.task = { state: 'canceled' }; return {}
    }
    throw new Error('unexpected ' + method)
  }
  return { call, calls, roots }
}
const tools = (b: ReturnType<typeof board>) => ({ key: 'github', call: b.call, rootOf: async (thread: string) => { const found = await b.call('syncFind', { thread }); return found.thread ? found.thread.slice(1) : null }, attempt: 1, last: false })
const receive = async (request: Request) => (await provider.receive(request, { key: 'github' })).events

test("a change to an item in a Project it keeps is one event; another Project's, or the app's own, is none", async () => {
  items.set('PVTI_a', { id: 'PVTI_a', archived: false, content: { __typename: 'Issue', id: 'I_5', number: 5, title: 'Fix it', url: 'https://github.com/acme/web/issues/5', repository: { nameWithOwner: 'acme/web' } }, values: {} })
  const [event] = await receive(itemWebhook('PVTI_a'))
  assert.deepEqual([event!.thread, (event!.event as any).project, (event!.event as any).item], ['github:project:roadmap:PVTI_a', 'roadmap', 'PVTI_a'])
  assert.deepEqual(await receive(itemWebhook('PVTI_a', 'edited', 7, 'PVT_other')), [])
  assert.deepEqual(await receive(itemWebhook('PVTI_a', 'edited', 42)), [])
})

test("an issue item lands on its issue's thread, its fields as labels (not its title)", async () => {
  items.set('PVTI_a', { id: 'PVTI_a', archived: false, content: { __typename: 'Issue', id: 'I_5', number: 5, title: 'Fix it', url: 'u', repository: { nameWithOwner: 'acme/web' } }, values: { Title: 'Fix it', Priority: 'P1', 'Target date': '2026-12-01' } })
  const b = board()
  const [event] = await receive(itemWebhook('PVTI_a'))
  await provider.import(event!.event, tools(b))
  assert.ok(b.roots.get('10')!.targets.includes('github:project:roadmap:PVTI_a'))
  assert.deepEqual(b.roots.get('10')!.labels, { issue: 'acme/web#5', 'project.roadmap': 'yes', 'project.roadmap.priority': 'P1', 'project.roadmap.target-date': '2026-12-01' })
  // Archived: the Project's labels go; the thread stays.
  items.get('PVTI_a')!.archived = true
  await provider.import(event!.event, tools(b))
  assert.deepEqual(b.roots.get('10')!.labels, { issue: 'acme/web#5' })
})

test("a draft item is a thread in the Project's channel", async () => {
  items.set('PVTI_d', { id: 'PVTI_d', archived: false, content: { __typename: 'DraftIssue', id: 'DI_1', title: 'Try caching', body: 'Maybe Redis.' }, values: { Status: 'Todo' } })
  const b = board()
  const [event] = await receive(itemWebhook('PVTI_d', 'created'))
  await provider.import(event!.event, tools(b))
  const post = b.calls.find(([method, input]) => method === 'syncImport' && input.op === 'post')![1]
  assert.deepEqual([post.channel, post.text, post.origin.thread], ['roadmap', '**Try caching**\n\nMaybe Redis.', 'github:project:roadmap:PVTI_d'])
  assert.equal(b.roots.get('20')!.labels['project.roadmap.status'], 'Todo')
  assert.equal(b.roots.get('20')!.task, null)
})

test("an item in a repo the app can't read (GitHub hides its content) makes no thread", async () => {
  items.set('PVTI_hidden', { id: 'PVTI_hidden', archived: false, content: null, values: {} })
  const b = board()
  const [event] = await receive(itemWebhook('PVTI_hidden'))
  await provider.import(event!.event, tools(b))
  assert.deepEqual(b.calls.filter(([method]) => method === 'syncImport' || method === 'sync'), [])
})

test('Status moves the task: ready makes one, Done completes a ready one but never takes a claim, Won’t do cancels', async () => {
  const item = { id: 'PVTI_s', archived: false, content: { __typename: 'Issue', id: 'I_5', number: 5, title: 'x', url: 'u', repository: { nameWithOwner: 'acme/web' } }, values: { Status: 'Ready for agent' } }
  items.set('PVTI_s', item)
  const b = board()
  const [event] = await receive(itemWebhook('PVTI_s'))
  await provider.import(event!.event, tools(b))
  assert.deepEqual(b.roots.get('10')!.task, { state: 'ready' })
  item.values.Status = 'Done'
  await provider.import(event!.event, tools(b))
  assert.deepEqual(b.calls.filter(([method]) => method === 'claimTask' || method === 'completeTask').map(([method]) => method), ['claimTask', 'completeTask'])
  // A task someone holds stays theirs.
  b.roots.get('10')!.task = { state: 'claimed' }
  const before = b.calls.length
  await provider.import(event!.event, tools(b))
  assert.equal(b.calls.slice(before).some(([method]) => method === 'claimTask' || method === 'completeTask'), false)
  item.values.Status = "Won't do"
  await provider.import(event!.event, tools(b))
  assert.deepEqual(b.roots.get('10')!.task, { state: 'canceled' })
})

test('a field label set on the board sets the field; one the field cannot take is rewritten from the item', async () => {
  items.set('PVTI_l', { id: 'PVTI_l', archived: false, content: null, values: { Priority: 'P1' } })
  const b = board()
  b.roots.get('10')!.targets.push('github:project:roadmap:PVTI_l')
  b.roots.get('10')!.labels = { 'project.roadmap': 'yes', 'project.roadmap.priority': 'P2' }
  mutations.length = 0
  await provider.labels!({ targets: b.roots.get('10')!.targets, root: { id: '10', labels: { ...b.roots.get('10')!.labels } }, set: { 'project.roadmap.priority': 'P2' }, unset: [] }, { key: 'github', call: b.call })
  assert.deepEqual(mutations.map((entry) => [entry.name, entry.variables.v]), [['updateProjectV2ItemFieldValue', { singleSelectOptionId: 'p2' }]])
  b.roots.get('10')!.labels['project.roadmap.priority'] = 'P9'
  mutations.length = 0
  await provider.labels!({ targets: b.roots.get('10')!.targets, root: { id: '10', labels: { ...b.roots.get('10')!.labels } }, set: { 'project.roadmap.priority': 'P9' }, unset: [] }, { key: 'github', call: b.call })
  assert.deepEqual(mutations, [])
  assert.equal(b.roots.get('10')!.labels['project.roadmap.priority'], 'P2')
  await provider.labels!({ targets: b.roots.get('10')!.targets, root: { id: '10', labels: { ...b.roots.get('10')!.labels } }, set: {}, unset: ['project.roadmap.priority'] }, { key: 'github', call: b.call })
  assert.equal(last()!.name, 'clearProjectV2ItemFieldValue')
})

test('project.<name> set on an issue thread adds its issue, with the fields it carries; unset archives it', async () => {
  const b = board()
  b.roots.get('10')!.labels = { issue: 'acme/web#5', 'project.roadmap': 'yes', 'project.roadmap.priority': 'P1' }
  mutations.length = 0
  await provider.labels!({ targets: b.roots.get('10')!.targets, root: { id: '10', labels: { ...b.roots.get('10')!.labels } }, set: { 'project.roadmap': 'yes', 'project.roadmap.priority': 'P1' }, unset: [] }, { key: 'github', call: b.call })
  assert.deepEqual(mutations.map((entry) => entry.name), ['addProjectV2ItemById', 'updateProjectV2ItemFieldValue'])
  const target = b.roots.get('10')!.targets.find((entry) => entry.startsWith('github:project:roadmap:'))!
  assert.ok(target)
  delete b.roots.get('10')!.labels['project.roadmap']
  await provider.labels!({ targets: b.roots.get('10')!.targets, root: { id: '10', labels: { ...b.roots.get('10')!.labels } }, set: {}, unset: ['project.roadmap'] }, { key: 'github', call: b.call })
  assert.equal(last()!.name, 'archiveProjectV2Item')
  // Its fields go with it.
  assert.deepEqual(b.roots.get('10')!.labels, { issue: 'acme/web#5' })
})

test("a task's state sets Status, once: the label says so after, and an unmapped state sets nothing", async () => {
  items.set('PVTI_t', { id: 'PVTI_t', archived: false, content: null, values: { Status: 'Ready for agent' } })
  const b = board()
  b.roots.get('10')!.targets.push('github:project:roadmap:PVTI_t')
  b.roots.get('10')!.labels = { 'project.roadmap': 'yes', 'project.roadmap.status': 'Ready for agent' }
  b.roots.get('10')!.task = { state: 'claimed' }
  mutations.length = 0
  await provider.task!({ targets: b.roots.get('10')!.targets, root: { id: '10', labels: { ...b.roots.get('10')!.labels }, task: { state: 'claimed' } } }, { key: 'github', call: b.call })
  assert.deepEqual(mutations.map((entry) => [entry.name, entry.variables.v]), [['updateProjectV2ItemFieldValue', { singleSelectOptionId: 'o_prog' }]])
  assert.equal(b.roots.get('10')!.labels['project.roadmap.status'], 'In progress')
  mutations.length = 0
  await provider.task!({ targets: b.roots.get('10')!.targets, root: { id: '10', labels: { ...b.roots.get('10')!.labels }, task: { state: 'claimed' } } }, { key: 'github', call: b.call })
  b.roots.get('10')!.task = { state: 'waiting' }
  await provider.task!({ targets: b.roots.get('10')!.targets, root: { id: '10', labels: { ...b.roots.get('10')!.labels }, task: { state: 'waiting' } } }, { key: 'github', call: b.call })
  assert.deepEqual(mutations, [])
})

test('a claim and a completion in one write leave the card at Done, not In progress', async () => {
  // A person moved the card to Done; the sync claimed and completed the task; the courier sees task.claimed, then task.completed.
  items.set('PVTI_c', { id: 'PVTI_c', archived: false, content: null, values: { Status: 'Done' } })
  const b = board()
  b.roots.get('10')!.targets.push('github:project:roadmap:PVTI_c')
  b.roots.get('10')!.labels = { 'project.roadmap': 'yes', 'project.roadmap.status': 'Done' }
  b.roots.get('10')!.task = { state: 'completed' }
  mutations.length = 0
  await provider.task!({ targets: b.roots.get('10')!.targets, root: { id: '10', labels: { ...b.roots.get('10')!.labels }, task: { state: 'claimed' } } }, { key: 'github', call: b.call })
  await provider.task!({ targets: b.roots.get('10')!.targets, root: { id: '10', labels: { ...b.roots.get('10')!.labels }, task: { state: 'completed' } } }, { key: 'github', call: b.call })
  assert.deepEqual(mutations, [])
  assert.equal(items.get('PVTI_c')!.values.Status, 'Done')
  assert.equal(b.roots.get('10')!.labels['project.roadmap.status'], 'Done')
})

test('an item target carries no messages: a reply posts nothing to GitHub', async () => {
  const copy = await provider.post({ target: 'github:project:roadmap:PVTI_a', thread: 'github:project:roadmap:PVTI_a', message: { id: '33', re: '10', thread: 't', text: 'hello', author: null } }, { key: 'github' })
  assert.equal(copy.message, 'board-only:33')
})
