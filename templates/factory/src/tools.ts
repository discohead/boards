// The agent's tools: the board, one protocol call each, and bash and files in the thread's sandbox.
import type { BoardCall } from './board.ts'
import type { Sandbox } from './sandbox.ts'
import { SKILLS } from './skills.ts'
import type { ToolDef } from './claude.ts'

const OUTPUT_MAX = 24_000
export const clip = (text: string, max = OUTPUT_MAX) => (text.length <= max ? text : text.slice(0, max / 2) + '\n… (' + (text.length - max) + ' characters cut) …\n' + text.slice(-max / 2))
const object = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false })
const str = { type: 'string' }
const labels = { type: 'object', additionalProperties: { type: 'string' } }

export const TOOLS: ToolDef[] = [
  { name: 'board_read', description: 'Reads a whole thread by any of its message IDs: the root, then each reply, with author, labels, reactions, files, and the thread’s pending schedules.', input_schema: object({ id: str }, ['id']) },
  { name: 'board_search', description: 'Finds threads, most recently active last. channel is a channel, or a subtree with a trailing slash (project-factory/). text is words a message says; label is key or key=value; by is a handle or actor ID.', input_schema: object({ channel: str, text: str, label: str, by: str, limit: { type: 'integer', minimum: 1, maximum: 50 } }, []) },
  { name: 'board_reply', description: 'Replies in a thread. after is the newest message you read: the reply is refused (newer_message) if someone posted since. attach is paths in your sandbox, each at most 4 MB.', input_schema: object({ id: str, text: str, after: str, attach: { type: 'array', items: str } }, ['id', 'text']) },
  { name: 'doc_read', description: 'Reads a doc on the board by its path (project-factory/factory/how-we-work). Without section: its outline (each section’s key and the revision it last changed) and its body. With section (a key from the outline): that section only. Read a doc by section.', input_schema: object({ path: str, section: str }, ['path']) },
  { name: 'doc_edit', description: 'Edits a doc by section. revision is the doc’s revision when you read it. edits: [{ section, text }] replaces a section’s own text (its heading stays); [{ after, text }] inserts a section after one (text starts with its heading, like "## Reviews"). If that section changed since your revision the edit is refused with section_conflict: read the section again, fold its new text and yours together, and edit again with the new revision.', input_schema: object({ path: str, revision: str, edits: { type: 'array', items: { type: 'object' } } }, ['path', 'revision', 'edits']) },
  { name: 'board_post', description: 'Starts a thread in a channel.', input_schema: object({ channel: str, text: str, labels }, ['channel', 'text']) },
  { name: 'board_react', description: 'Reacts to a message with a short emoji name (eyes, thumbs_up, white_check_mark); remove: true takes it back.', input_schema: object({ id: str, emoji: str, remove: { type: 'boolean' } }, ['id', 'emoji']) },
  { name: 'task_claim', description: 'Claims a thread that is a ready task (its root’s ID), so it’s yours while you work it: on the team’s Project the card moves to In Progress. The claim is kept for you and renewed while you work; you never see its token.', input_schema: object({ id: str }, ['id']) },
  { name: 'task_complete', description: 'Completes a task you claimed, with a one-line result (the PR, the answer). On the Project the card moves to Done.', input_schema: object({ id: str, result: str }, ['id']) },
  { name: 'task_release', description: 'Gives back a task you claimed and won’t finish, so someone else can: it’s ready again.', input_schema: object({ id: str }, ['id']) },
  { name: 'task_block', description: 'Marks a task you claimed as blocked, with why (waiting on a person, a missing permission).', input_schema: object({ id: str, reason: str }, ['id', 'reason']) },
  { name: 'board_follow', description: 'Follows a thread (or, by a comment’s ID, one discussion on a doc), so what lands there wakes you though you haven’t replied and no one mentions you. on: false unfollows: what lands there stops waking you, except a mention. Replying or being mentioned follows on its own.', input_schema: object({ id: str, on: { type: 'boolean' } }, ['id']) },
  { name: 'board_label', description: 'Sets and unsets labels on a message. if makes it conditional: each key must have that value now (null: not set), or nothing changes (label_conflict).', input_schema: object({ id: str, set: labels, unset: { type: 'array', items: str }, if: { type: 'object', additionalProperties: { type: ['string', 'null'] } } }, ['id']) },
  { name: 'board_typing', description: 'Shows that you are working on a thread, in a few words (at most 50 characters).', input_schema: object({ id: str, status: str }, ['id']) },
  { name: 'board_schedule', description: 'Posts a message as you later, and wakes you when it does: in a thread (re) or as a new thread (channel). Durations look like 10m, 2h, 1d. Once with in or at; repeating with every, ended by times, for, or until. noSync keeps it off other platforms.', input_schema: object({ re: str, channel: str, text: str, in: str, at: str, every: str, times: { type: 'integer', minimum: 1 }, for: str, until: str, noSync: { type: 'boolean' } }, ['text']) },
  { name: 'board_schedules', description: 'Lists pending schedules: a thread’s (re) or a channel’s.', input_schema: object({ re: str, channel: str }, []) },
  { name: 'board_cancel_schedule', description: 'Cancels a schedule by its ID (s12).', input_schema: object({ id: str }, ['id']) },
  { name: 'board_download', description: 'Saves a file attached to a message into your sandbox, at path.', input_schema: object({ attachment: str, path: str }, ['attachment', 'path']) },
  { name: 'bash', description: 'Runs a bash script in your sandbox, in /workspace unless you cd: git, gh, node, npm, pnpm, and rg are there. gh and git reach GitHub as the factory’s app with no token of yours. Each call is its own shell. Output is stdout and stderr together, cut in the middle past 24,000 characters.', input_schema: object({ script: str, timeout_seconds: { type: 'integer', minimum: 1, maximum: 1800 } }, ['script']) },
  { name: 'read_file', description: 'Reads a text file in the sandbox with line numbers: offset is the first line, limit how many (500 by default).', input_schema: object({ path: str, offset: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 5000 } }, ['path']) },
  { name: 'write_file', description: 'Writes a whole file in the sandbox, making its directories.', input_schema: object({ path: str, content: str }, ['path', 'content']) },
  { name: 'edit_file', description: 'Replaces old_string with new_string in a file. old_string must appear exactly once unless replace_all; copy it from the file exactly.', input_schema: object({ path: str, old_string: str, new_string: str, replace_all: { type: 'boolean' } }, ['path', 'old_string', 'new_string']) },
  { name: 'grep', description: 'Searches files in the sandbox with ripgrep: pattern is a regular expression, path a file or directory (/workspace by default), glob narrows the files.', input_schema: object({ pattern: str, path: str, glob: str }, ['pattern']) },
  { name: 'read_skill', description: 'Reads one of your skills in full: read it before you follow it.', input_schema: object({ name: { type: 'string', enum: SKILLS.map((skill) => skill.name) } }, ['name']) },
  { name: 'end_turn', description: 'Ends your turn. Call it once your last reply is posted, or when the message needs nothing from you.', input_schema: object({}, []) },
]

const shell = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'"

type View = Record<string, any>
const line = (message: View) => {
  const who = message.author ? message.author.name + (message.author.via ? ' via ' + message.author.via.name : '') + ' (' + message.by.actor + ')' : message.by.actor
  const tags = Object.entries(message.labels ?? {}).map(([key, value]) => key + '=' + value)
  const reactions = Object.entries(message.reactions ?? {}).map(([emoji, actors]) => ':' + emoji + ': ' + (actors as string[]).length)
  const files = (message.attachments ?? []).map((file: View) => 'file ' + file.name + ' (' + file.type + ', ' + file.size + ' bytes) id ' + file.id)
  const meta = [...tags, ...reactions].join(' ')
  return '#' + message.id + '  ' + who + '  ' + message.createdAt + (meta ? '  [' + meta + ']' : '') + (message.deleted ? '  (deleted)' : '') + '\n' + (message.text || '').split('\n').map((text: string) => '    ' + text).join('\n') + (files.length ? '\n    ' + files.join('\n    ') : '')
}

export function threadText(view: View): string {
  const root = view.message
  const head = 'thread #' + root.id + ' in ' + root.channel + (root.task ? '  task ' + root.task.state : '')
  const schedules = (view.schedules ?? []).map((schedule: View) => 'pending schedule ' + schedule.id + ': ' + schedule.text.split('\n')[0] + ' (next ' + schedule.next + ')')
  return [head, line(root), ...view.replies.map(line), ...schedules].join('\n')
}

/** The claims this thread's agent holds: their tokens stay here, never in what the model reads. */
export type Claims = { keep(id: string, epoch: number, token: string, until: number): void; of(id: string): { epoch: number; token: string; until: number } | null; drop(id: string): void }
export type ToolContext = { board: BoardCall; sandbox: Sandbox; files: { get(id: string): Promise<{ bytes: Uint8Array; name: string } | null>; put(name: string, type: string, bytes: Uint8Array): Promise<string> }; claims: Claims }

/** A claim's lease, the most the board gives (an hour): renewed while a turn runs (agent.ts). */
export const LEASE_S = 3600

const typeOf = (path: string) => {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', txt: 'text/plain', log: 'text/plain', md: 'text/markdown', json: 'application/json', mp4: 'video/mp4', pdf: 'application/pdf' } as Record<string, string>)[ext] ?? 'application/octet-stream'
}

export async function runTool(context: ToolContext, name: string, input: Record<string, any>): Promise<{ content: string; isError?: boolean; endTurn?: boolean }> {
  const { board, sandbox } = context
  try {
    switch (name) {
      case 'board_read':
        return { content: clip(threadText(await board('message', { id: String(input.id) }))) }
      case 'board_search': {
        const query: Record<string, unknown> = { limit: input.limit ?? 20 }
        for (const key of ['channel', 'text', 'label', 'by']) if (input[key]) query[key] = input[key]
        const page = await board('threads', query)
        const out = page.threads.map((thread: View) => '#' + thread.message.id + ' in ' + thread.message.channel + ' (' + thread.replies + ' replies): ' + (thread.message.text || '').split('\n')[0].slice(0, 160))
        return { content: out.join('\n') || 'no threads' }
      }
      case 'board_reply':
      case 'board_post': {
        const attachments: string[] = []
        for (const path of input.attach ?? []) {
          const bytes = await sandbox.readFile(path)
          if (bytes === null) return { content: path + ' does not exist in the sandbox', isError: true }
          attachments.push(await context.files.put(path.split('/').pop()!, typeOf(path), bytes))
        }
        const body: Record<string, unknown> = { text: input.text, ...(attachments.length ? { attachments } : {}) }
        if (name === 'board_reply') {
          body.re = String(input.id)
          if (input.after) body.after = String(input.after)
        } else {
          body.channel = input.channel
          if (input.labels) body.labels = input.labels
        }
        const posted = await board('post', body)
        return { content: (name === 'board_reply' ? 'replied' : 'posted') + ' #' + posted.message.id }
      }
      case 'doc_read': {
        const read = await board('docAt', { path: String(input.path), ...(input.section ? { section: String(input.section) } : {}), depth: 6 })
        const outline = read.doc.sections.map((section: View) => '  '.repeat(section.level - 1) + section.key + '  (' + section.title + ', changed ' + section.changed + ')').join('\n')
        const head = read.doc.path + '  revision ' + read.doc.revision + '\n' + outline
        return { content: clip(read.section ? head + '\n\nsection ' + read.section.key + ':\n' + read.section.text + read.section.subtree : head + '\n\n' + read.body) }
      }
      case 'doc_edit': {
        const found = await board('docAt', { path: String(input.path), depth: 1 })
        const done = await board('editDoc', { id: found.doc.id, revision: String(input.revision), edits: input.edits })
        return { content: 'edited ' + done.doc.path + ', now at revision ' + done.revision }
      }
      case 'board_react':
        await board('react', { id: String(input.id), emoji: String(input.emoji).replace(/^:|:$/g, ''), ...(input.remove ? { remove: true } : {}) })
        return { content: (input.remove ? 'removed :' : 'reacted :') + input.emoji + ':' }
      case 'task_claim': {
        const done = await board('claimTask', { id: String(input.id), lease: LEASE_S })
        context.claims.keep(String(input.id), done.claim.epoch, done.claim.token, Date.parse(done.claim.until))
        return { content: 'claimed #' + input.id + ' until ' + done.claim.until + ' (renewed while you work)' }
      }
      case 'task_complete':
      case 'task_release':
      case 'task_block': {
        const id = String(input.id)
        const claim = context.claims.of(id)
        if (!claim) return { content: 'you hold no claim on #' + id + ': claim it with task_claim first', isError: true }
        const proof = { id, epoch: claim.epoch, token: claim.token }
        if (name === 'task_complete') await board('completeTask', { ...proof, ...(input.result ? { result: String(input.result).slice(0, 1000) } : {}) })
        else if (name === 'task_release') await board('releaseTask', proof)
        else await board('blockTask', { ...proof, reason: String(input.reason).slice(0, 1000) })
        context.claims.drop(id)
        return { content: (name === 'task_complete' ? 'completed #' : name === 'task_release' ? 'released #' : 'blocked #') + id }
      }
      case 'board_follow': {
        const done = await board('follow', { id: String(input.id), ...(input.on === false ? { on: false } : {}) })
        const what = done.discussion ? 'the discussion #' + done.discussion + ' in #' + done.thread : '#' + done.thread
        return { content: (done.following ? 'following ' : 'unfollowed ') + what }
      }
      case 'board_label':
        await board('label', { id: String(input.id), ...(input.set ? { set: input.set } : {}), ...(input.unset ? { unset: input.unset } : {}), ...(input.if ? { if: input.if } : {}) })
        return { content: 'labeled #' + input.id }
      case 'board_typing': {
        const typed = await board('typing', { id: String(input.id), ...(input.status ? { status: String(input.status).slice(0, 50) } : {}) })
        return { content: 'typing shown' + (typed.targets?.length ? ' on ' + typed.targets.join(', ') : ' on the board') }
      }
      case 'board_schedule': {
        const body: Record<string, unknown> = { text: input.text }
        for (const key of ['re', 'channel', 'in', 'at', 'every', 'times', 'for', 'until', 'noSync']) if (input[key] !== undefined) body[key] = input[key]
        const made = await board('schedule', body)
        return { content: 'scheduled ' + made.schedule.id + ', next ' + made.schedule.next }
      }
      case 'board_schedules': {
        const listed = await board('schedules', { ...(input.re ? { re: input.re } : {}), ...(input.channel ? { channel: input.channel } : {}) })
        return { content: listed.schedules.map((schedule: View) => schedule.id + '  ' + schedule.state + '  next ' + schedule.next + '  ' + schedule.text.split('\n')[0]).join('\n') || 'none pending' }
      }
      case 'board_cancel_schedule':
        await board('cancelSchedule', { id: String(input.id) })
        return { content: 'canceled ' + input.id }
      case 'board_download': {
        const file = await context.files.get(String(input.attachment))
        if (!file) return { content: 'no attachment ' + input.attachment + ' that you can read', isError: true }
        await sandbox.writeFile(String(input.path), file.bytes)
        return { content: 'saved ' + file.name + ' to ' + input.path }
      }
      case 'bash': {
        const ran = await sandbox.run(String(input.script), { timeoutSeconds: Number(input.timeout_seconds ?? 600) })
        return { content: clip(ran.output + (ran.exitCode === 0 ? '' : '\n(exit ' + ran.exitCode + ')')) || '(no output)', isError: ran.exitCode !== 0 }
      }
      case 'read_file': {
        const offset = Number(input.offset ?? 1)
        const limit = Number(input.limit ?? 500)
        const ran = await sandbox.run('awk -v a=' + offset + ' -v b=' + (offset + limit - 1) + " 'NR>=a && NR<=b { printf \"%6d\\t%s\\n\", NR, $0 } END { if (NR > b) printf \"… %d more lines\\n\", NR - b }' " + shell(String(input.path)))
        return { content: clip(ran.output || '(empty file)'), isError: ran.exitCode !== 0 }
      }
      case 'write_file':
        await sandbox.writeFile(String(input.path), String(input.content))
        return { content: 'wrote ' + input.path }
      case 'edit_file': {
        const path = String(input.path)
        const bytes = await sandbox.readFile(path)
        if (bytes === null) return { content: path + ' does not exist', isError: true }
        const text = new TextDecoder().decode(bytes)
        const old = String(input.old_string)
        const count = old === '' ? 0 : text.split(old).length - 1
        if (count === 0) return { content: 'old_string is not in ' + path + ': read it and copy the text exactly', isError: true }
        if (count > 1 && !input.replace_all) return { content: 'old_string is in ' + path + ' ' + count + ' times: give more of the text around it, or set replace_all', isError: true }
        const next = input.replace_all ? text.split(old).join(String(input.new_string)) : text.replace(old, () => String(input.new_string))
        await sandbox.writeFile(path, next)
        return { content: 'edited ' + path + (count > 1 ? ' (' + count + ' places)' : '') }
      }
      case 'grep': {
        const glob = input.glob ? ' --glob ' + shell(String(input.glob)) : ''
        const ran = await sandbox.run('rg --line-number --max-columns 300 --max-count 200' + glob + ' -e ' + shell(String(input.pattern)) + ' ' + shell(String(input.path ?? '/workspace')) + ' || [ $? = 1 ]')
        return { content: clip(ran.output || 'no matches'), isError: ran.exitCode !== 0 }
      }
      case 'read_skill': {
        const skill = SKILLS.find((candidate) => candidate.name === input.name)
        return skill ? { content: skill.body } : { content: 'no skill named ' + input.name, isError: true }
      }
      case 'end_turn':
        return { content: 'turn ended', endTurn: true }
      default:
        return { content: 'no tool named ' + name, isError: true }
    }
  } catch (error) {
    return { content: String((error as Error)?.message ?? error), isError: true }
  }
}
