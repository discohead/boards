// The computer tier (§5.4): a @cloudflare/computer Workspace with files, git, and exec, which runs
// JavaScript in a Dynamic Worker minted through LOADER with no network. The workspace is the seat's,
// not a thread's: it lives in the seat's SeatWorkspace object (seats/workspace.ts), and each of the
// seat's Sessions reaches it over RPC. The tools are computer's own (createPiTools), put behind the seam.
import { Workspace, type DurableObjectStorageLike } from '@cloudflare/computer'
import { CodemodeBackend } from '@cloudflare/computer/backends/codemode'
import { createGitClient } from '@cloudflare/computer/git'
import { createGitModule } from '@cloudflare/computer/modules/git'
import { createPiTools, type PiTool, type PiToolCall, type PiToolResult } from '@cloudflare/computer/tools/pi-ai'
import { z } from 'zod'

import type { Tool } from './types.ts'

/** A workspace over storage, rooted at /workspace. git works on its files; it can't reach a remote. */
export function workspace(storage: DurableObjectStorage, loader: WorkerLoader): Workspace {
  return new Workspace({
    storage: storage as unknown as DurableObjectStorageLike,
    git: createGitClient(),
    backends: [
      new CodemodeBackend({
        loader,
        root: '/workspace',
        access: 'read-write',
        // No credential reaches a seat, and nothing leaves but through the egress gateway (§5.4), which phase 2 doesn't build.
        modules: { 'codemode:git': createGitModule({ allowNetwork: false }) },
      }),
    ],
  })
}

/**
 * Reads and searches have no effect, write replaces the whole file, and delete succeeds on a missing
 * path, so those can run again after an eviction. edit would miss text it already replaced, and exec
 * runs anything, so Pi hands the model an interrupted result for those instead.
 */
const REPLAY_SAFE = new Set(['read', 'ls', 'find', 'grep', 'write', 'delete'])

const EXEC = `Run a JavaScript module in a sandbox. This is not a shell: \`command\` is never a shell command (no echo, ls, cat, node, or npm), it is the source of an ES module, run in a fresh sandboxed isolate with no network. The module must default-export a function, which is what runs: a module with no default export runs nothing and fails. Example: a task that says "run echo hi" is \`export default () => { console.log("hi"); return "hi" }\`. If it default-exports a function, that is called with \`input\` and its return value comes back as \`result\`; console.log and console.error go to stdout and stderr. There is no shell and no npm. Its imports: node:fs/promises (the workspace's files, async: readFile(path, "utf8"), writeFile, mkdir, rm, readdir, stat), codemode:git (status, diff, log on a repository under /workspace), and relative .js files in the workspace. Prefer the read, write, and edit tools for plain file changes.`

/** computer's tools over one workspace: their declarations, and one execute that runs a call. */
export function workspaceTools(space: Workspace): { tools: PiTool[]; execute: (call: PiToolCall) => Promise<PiToolResult> } {
  const { tools, execute } = createPiTools({ workspace: space, exec: { backends: { codemode: { description: 'Runs ES module source in a sandboxed isolate.' } } } })
  return { tools: tools.map((tool) => (tool.name === 'exec' ? { ...tool, description: EXEC } : tool)), execute: (call) => execute(call) }
}

/** A workspace as a session reaches it: the seat's SeatWorkspace, over RPC. */
export type WorkspaceStub = {
  declare(): Promise<PiTool[]>
  execute(call: PiToolCall): Promise<PiToolResult>
}

/** The computer tools, as the seam's, each call run by the seat's workspace. */
export function computerTools(declared: readonly PiTool[], space: WorkspaceStub): Tool<any>[] {
  return declared.map((tool): Tool<any> => ({
    name: tool.name,
    description: tool.description,
    // computer validates its own arguments, against the schema it declares.
    input: z.any(),
    schema: tool.parameters,
    replay: REPLAY_SAFE.has(tool.name) ? 'safe' : 'unsafe',
    approval: 'never',
    async run(input, context) {
      const result = await space.execute({ id: context.callId, name: tool.name, arguments: input })
      const text = result.content.map((part) => (part.type === 'text' ? part.text : '[' + part.mimeType + ' image]')).join('\n')
      return { text, isError: result.isError }
    },
  }))
}
