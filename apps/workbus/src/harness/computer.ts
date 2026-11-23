// The computer tier (§5.4): a @cloudflare/computer Workspace in the session's own SQLite, with
// files, git, and exec, which runs JavaScript in a Dynamic Worker minted through LOADER with no
// network. The tools are computer's own (createPiTools), each paired with its execute and put
// behind the seam, as the Agents SDK's pi example does.
import { Workspace, type DurableObjectStorageLike } from '@cloudflare/computer'
import { CodemodeBackend } from '@cloudflare/computer/backends/codemode'
import { createGitClient } from '@cloudflare/computer/git'
import { createGitModule } from '@cloudflare/computer/modules/git'
import { createPiTools } from '@cloudflare/computer/tools/pi-ai'
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

const EXEC = `Run JavaScript in the workspace. \`command\` is the source of an ES module, run in a fresh sandboxed isolate with no network. If it default-exports a function, that is called with \`input\` and its return value comes back as \`result\`; console.log and console.error go to stdout and stderr. There is no shell and no npm. Its imports: node:fs/promises (the workspace's files, async: readFile(path, "utf8"), writeFile, mkdir, rm, readdir, stat), codemode:git (status, diff, log on a repository under /workspace), and relative .js files in the workspace. Prefer the read, write, and edit tools for plain file changes.`

export function computerTools(space: Workspace): Tool<any>[] {
  const { tools, execute } = createPiTools({ workspace: space, exec: { backends: { codemode: { description: 'Runs ES module source in a sandboxed isolate.' } } } })
  return tools.map((declared): Tool<any> => ({
    name: declared.name,
    description: declared.name === 'exec' ? EXEC : declared.description,
    // computer validates its own arguments, against the schema it declares.
    input: z.any(),
    schema: declared.parameters,
    replay: REPLAY_SAFE.has(declared.name) ? 'safe' : 'unsafe',
    approval: 'never',
    async run(input, context) {
      const result = await execute({ id: context.callId, name: declared.name, arguments: input }, { abortSignal: context.signal })
      const text = result.content.map((part) => (part.type === 'text' ? part.text : '[' + part.mimeType + ' image]')).join('\n')
      return { text, isError: result.isError }
    },
  }))
}
