// One agent per board thread, as an Agents SDK Agent. It keeps the thread's conversation in its own
// SQLite, owns the thread's sandbox (its container), and takes wake-ups one at a time from its
// durable queue.
import { Agent } from 'agents'
import { INSTRUCTIONS } from './instructions.ts'
import { NAME } from './config.ts'
import { boardCall } from './board.ts'
import { filesFor } from './files.ts'
import { claude, type Block, type Message } from './claude.ts'
import { Sandbox } from './sandbox.ts'
import { skillIndex } from './skills.ts'
import { TOOLS, runTool, clip } from './tools.ts'
import type { Env } from './env.ts'

export type Wake = { thread: string; key: string; text: string }

const STEPS_MAX = 60
const HISTORY_MAX = 120
const SKILLS_NOTE = 'Your skills, each read in full with read_skill before you follow it:\n' + skillIndex()

export class ThreadAgent extends Agent<Env> {
  private sandboxFor(thread: string) {
    return new Sandbox(this.ctx as never, thread, { name: NAME, email: NAME + '@users.noreply.github.com' })
  }

  private tables() {
    this.sql`create table if not exists factory_wakes (key text primary key, at integer not null)`
    this.sql`create table if not exists factory_history (seq integer primary key autoincrement, message text not null)`
    this.sql`create table if not exists factory_turns (seq integer primary key autoincrement, key text, at integer, steps integer, outcome text)`
  }

  /** A wake-up from the board's watcher. Each runs once (its key is its board event), in order, after the turn before it. */
  async wake(wake: Wake): Promise<{ queued: boolean }> {
    this.tables()
    const seen = this.sql<{ key: string }>`select key from factory_wakes where key = ${wake.key}`
    if (seen.length > 0) return { queued: false }
    this.sql`insert into factory_wakes (key, at) values (${wake.key}, ${Date.now()})`
    await this.queue('turn', wake, { retry: { maxAttempts: 2 } } as never)
    return { queued: true }
  }

  /** What this thread's agent has done: its turns, for the page and tests. */
  async turns(): Promise<{ key: string; at: number; steps: number; outcome: string }[]> {
    this.tables()
    return this.sql`select key, at, steps, outcome from factory_turns order by seq desc limit 20` as never
  }

  private history(): Message[] {
    const rows = this.sql<{ message: string }>`select message from factory_history order by seq desc limit ${HISTORY_MAX}`
    const messages = rows.reverse().map((row) => JSON.parse(row.message) as Message)
    // Start where a person spoke: never on a tool result whose call was cut off.
    while (messages.length && !(messages[0]!.role === 'user' && typeof messages[0]!.content === 'string')) messages.shift()
    return messages
  }

  private remember(message: Message) {
    this.sql`insert into factory_history (message) values (${JSON.stringify(message)})`
  }

  /** One turn: the wake-up, then Claude and its tools until it ends the turn or stops calling them. */
  async turn(wake: Wake): Promise<void> {
    this.tables()
    await this.keepAliveWhile(async () => {
      const board = boardCall(this.env)
      const files = filesFor(this.env)
      const sandbox = this.sandboxFor(wake.thread)
      const system = INSTRUCTIONS + '\n\nOn the board you’re ' + NAME + ', working on thread #' + wake.thread + ' only. Other threads have agents of their own.\n\n' + SKILLS_NOTE
      const messages = this.history()
      const user: Message = { role: 'user', content: wake.text }
      messages.push(user)
      this.remember(user)
      let steps = 0
      let outcome = 'stopped'
      try {
        for (; steps < STEPS_MAX; steps++) {
          const reply = await claude(this.env as never, { system, messages, tools: TOOLS })
          const assistant: Message = { role: 'assistant', content: reply.content }
          messages.push(assistant)
          this.remember(assistant)
          const calls = reply.content.filter((block): block is Extract<Block, { type: 'tool_use' }> => block.type === 'tool_use')
          if (reply.stop_reason !== 'tool_use' || calls.length === 0) {
            outcome = 'answered without tools'
            break
          }
          const results: Block[] = []
          let ended = false
          for (const call of calls) {
            const result = await runTool({ board, sandbox, files }, call.name, call.input)
            results.push({ type: 'tool_result', tool_use_id: call.id, content: clip(result.content), ...(result.isError ? { is_error: true } : {}) })
            if (result.endTurn) ended = true
          }
          const back: Message = { role: 'user', content: results }
          messages.push(back)
          this.remember(back)
          if (ended) {
            outcome = 'ended'
            break
          }
        }
      } catch (error) {
        outcome = 'failed: ' + String((error as Error)?.message ?? error).slice(0, 300)
        console.error('[factory] turn failed on thread', wake.thread, error)
        throw error
      } finally {
        this.sql`insert into factory_turns (key, at, steps, outcome) values (${wake.key}, ${Date.now()}, ${steps}, ${outcome})`
      }
    })
  }
}
