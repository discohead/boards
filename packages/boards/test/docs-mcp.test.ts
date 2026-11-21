// Docs over MCP: the doc_* tools, which act through the Board capability's docs.
import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { boardUrl, freshBoard, tokenFor } from './helpers.ts'

async function mcp(name: string, method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const response = await SELF.fetch(boardUrl(name) + '/mcp', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + (await tokenFor(name)), 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  return (await response.json()) as { result?: any; error?: any }
}
const tool = async (name: string, tool: string, args: Record<string, unknown>, headers: Record<string, string> = {}) => {
  const answer = await mcp(name, 'tools/call', { name: tool, arguments: args }, headers)
  const text = answer.result.content[0].text as string
  return { isError: Boolean(answer.result.isError), text, json: (() => { try { return JSON.parse(text) } catch { return null } })() }
}

const BODY = '# Deploy\n\nHow we ship.\n\n## Canary\n\nShip to 1% first.\n\n# Monitoring\n\nWatch the dashboards.\n'

describe('docs over MCP', () => {
  it('lists the doc tools, and an agent creates, reads by section, and edits by section', async () => {
    const name = freshBoard('mcp-docs')
    const listed = (await mcp(name, 'tools/list')).result.tools as { name: string; description: string }[]
    const tools = listed.map((entry) => entry.name)
    // run_code's Board types show follows, so a model knows it can follow and read what reaches it.
    expect(listed.find((entry) => entry.name === 'run_code')!.description).toMatch(/follow\(id: string[\s\S]*follows\(query\?[\s\S]*for\?: string; roots\?: boolean/)
    expect(tools).toEqual(expect.arrayContaining(['doc_read', 'doc_edit', 'doc_create', 'doc_search']))
    expect((await mcp(name, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })).result.instructions).toMatch(/doc_read, doc_edit, doc_create, and doc_search/)
    const made = await tool(name, 'doc_create', { channel: 'docs/runbooks', slug: 'deploy', body: BODY })
    expect(made.isError, made.text).toBe(false)
    const outline = await tool(name, 'doc_read', { path: 'docs/runbooks/deploy' })
    expect(outline.json.doc.sections.map((section: { key: string }) => section.key)).toEqual(['deploy', 'deploy/canary', 'monitoring'])
    const revision = outline.json.doc.revision
    const section = await tool(name, 'doc_read', { path: 'docs/runbooks/deploy', section: 'deploy/canary' })
    expect(section.json.section.text).toBe('\nShip to 1% first.\n\n')
    const edited = await tool(name, 'doc_edit', { path: 'docs/runbooks/deploy', revision, edits: [{ section: 'deploy/canary', text: '\nShip to 5% first.\n\n' }] })
    expect(edited.isError, edited.text).toBe(false)
    const stale = await tool(name, 'doc_edit', { path: 'docs/runbooks/deploy', revision, edits: [{ section: 'deploy/canary', text: '\nlate\n\n' }] })
    expect(stale.isError).toBe(true)
    expect(stale.text).toMatch(/^section_conflict: /)
    // A whole body merged from the copy it started from: base, no revision.
    const merged = await tool(name, 'doc_edit', { path: 'docs/runbooks/deploy', base: BODY, body: BODY.replace('How we ship.', 'How we ship, from main.'), merge: true })
    expect(merged.isError, merged.text).toBe(false)
    expect((await tool(name, 'doc_read', { path: 'docs/runbooks/deploy' })).json.body).toBe(BODY.replace('How we ship.', 'How we ship, from main.').replace('Ship to 1% first.', 'Ship to 5% first.'))
    const found = await tool(name, 'doc_search', { channel: 'docs/' })
    expect(found.json.docs.map((doc: { path: string }) => doc.path)).toEqual(['docs/runbooks/deploy'])
  })

  it('an agent without edit proposes instead, and the proposal is a task', async () => {
    const name = freshBoard('mcp-propose')
    await tool(name, 'doc_create', { channel: 'docs', slug: 'deploy', body: BODY })
    const revision = (await tool(name, 'doc_read', { path: 'docs/deploy' })).json.doc.revision
    const narrowed = { 'x-board-can': '*=read,post' }
    const refused = await tool(name, 'doc_edit', { path: 'docs/deploy', revision, edits: [{ section: 'monitoring', text: '\nWatch p99.\n' }] }, narrowed)
    expect(refused.isError).toBe(true)
    expect(refused.text).toMatch(/^forbidden: /)
    const proposed = await tool(name, 'doc_edit', { path: 'docs/deploy', revision, edits: [{ section: 'monitoring', text: '\nWatch p99.\n' }], propose: true, note: 'p99 is what pages us' }, narrowed)
    expect(proposed.isError, proposed.text).toBe(false)
    expect(proposed.json.proposal.task.state).toBe('ready')
    expect(proposed.json.proposal.text).toContain('p99 is what pages us')
  })
})
