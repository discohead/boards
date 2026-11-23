// The Pi adapter: the seam (types.ts) mapped onto Pi Durable (@earendil-works/pi-durable) as the
// Agents SDK hosts it (agents/harness/pi). Each tool is compiled to a Pi ToolRegistration, an
// approval parks its call in a beforeTool hook until signal() answers it, and every response's
// usage and every tool's time are kept per operation, for the run record (§8.2).
import { defineSignal, GenerationTask, hook, ToolTask, type HookRegistration, type ToolRegistration } from '@earendil-works/pi-durable'
import { bool, obj, str } from '@earendil-works/pi-schema'
import { getAgentByName } from 'agents'
import { z } from 'zod'

import type { Harness, HarnessSession, Outcome, Receipt, SeatRef, SessionEvent, SubmitOptions, Tool, ToolAnswer, ToolContext, Turn } from './types.ts'

/** The principal's answer to one held call, delivered to the call's tool task under the call's ID. */
export const Approval = defineSignal({ name: 'workbus.approval', version: 1, schema: obj({ approved: bool(), reason: str() }) })

/** Kinds no seat may make automatic (§6.2, after Cloudflare OS's autoApprovable rule). */
export const ALWAYS_ASKS = new Set(['delete', 'spend', 'permissions'])

/** The kind a call to tool waits for, or null when it runs without asking. */
export function approvalKind(tool: Tool<unknown>, seat: SeatRef): string | null {
  const kind = seat.approve?.[tool.name] ?? (tool.approval === 'never' ? null : tool.approval === 'always' ? 'approval' : tool.approval.kind)
  if (kind === null) return null
  if (!ALWAYS_ASKS.has(kind) && seat.automatic?.includes(kind)) return null
  return kind
}

/** The seat's system prompt (§5.2): its charter, its team's doc, the org's structure, and its skills' index. */
export function systemPrompt(seat: SeatRef, thread: string): string {
  const parts = [
    'You are ' + seat.name + ' (@' + seat.handle + '), a seat on the team ' + seat.team + ' in an org that works on a message board. People and other seats reach you on the board; you answer there, with your tools. What you write in this session is seen by no one: post or reply to be heard.',
    'This session is the thread ' + thread + '. Each turn is something that woke you: read it, act, and stop when it is handled.',
    '# Your charter\n\n' + seat.prompt.charter.trim(),
  ]
  if (!seat.tools.includes('board')) parts.splice(1, 0, 'You have no board tools in this session: answer in plain text.')
  if (seat.prompt.team) parts.push('# Your team\n\n' + seat.prompt.team.trim())
  if (seat.prompt.org) parts.push('# The org\n\n' + seat.prompt.org.trim())
  if (seat.prompt.skills) parts.push('# Skills\n\n' + seat.prompt.skills.trim())
  return parts.join('\n\n')
}

/** A JSON Schema for the model, without the keys providers refuse. */
function schemaOf(tool: Tool<unknown>): object {
  if (tool.schema) return tool.schema
  const { $schema: _drop, ...schema } = z.toJSONSchema(tool.input, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>
  return schema
}

/** One seam tool as Pi runs it. The seam's zod input is checked again here, so run() gets its types. */
export function compile(tool: Tool<any>, context: (callId: string, signal: AbortSignal) => ToolContext): ToolRegistration {
  return {
    name: tool.name,
    description: tool.description,
    parameters: schemaOf(tool) as ToolRegistration['parameters'],
    replay: tool.replay,
    async execute(args, api, ctx) {
      const parsed = tool.input.safeParse(args)
      if (!parsed.success) return { output: [{ type: 'text', text: z.prettifyError(parsed.error) }], isError: true }
      const result = await tool.run(parsed.data, context(api.callId, ctx.abortSignal ?? new AbortController().signal))
      return { output: [{ type: 'text', text: result.text }], isError: result.isError === true }
    },
  }
}

/** What a session does when a call needs the principal: hold a task for them, once per call. */
export type Hold = (call: { id: string; name: string; arguments: unknown }, piTask: string, kind: string) => Promise<void>

/** Parks each call that needs an approval until the principal answers (§6.2). A denial blocks it. */
export function gate(tools: () => Map<string, Tool<unknown>>, seat: () => SeatRef, hold: Hold): HookRegistration {
  return hook(ToolTask, {
    async beforeTool(call, api, context) {
      const tool = tools().get(call.name)
      const kind = tool ? approvalKind(tool, seat()) : null
      if (kind === null) return undefined
      const answer = await api.readSignal(Approval, call.id, context)
      if (answer && 'value' in answer) return answer.value.approved ? undefined : { block: 'The principal denied this call' + (answer.value.reason ? ': ' + answer.value.reason.replace(/\.?$/, '.') : '.') + ' Do not try it again.' }
      await hold({ id: call.id, name: call.name, arguments: call.arguments }, String(api.taskId), kind)
      return { sleep: { signals: [Approval.key(call.id)] } }
    },
  })
}

/** What the meter writes: one row per response, one per tool call that ran. */
export type Meter = {
  response(message: { model?: string; usage?: any; diagnostics?: readonly { type: string; details?: any }[] }): Promise<void> | void
  tool(call: string, name: string, phase: 'start' | 'end', ok?: boolean): Promise<void> | void
}

/** The gateway's log ID on a response, from the diagnostics agents/models/pi-ai records. */
export function gatewayLog(message: { diagnostics?: readonly { type: string; details?: any }[] }): string | null {
  for (const d of message.diagnostics ?? []) {
    if (d.type !== 'cloudflare') continue
    const id = d.details?.logId ?? d.details?.['cf-aig-log-id'] ?? d.details?.headers?.['cf-aig-log-id']
    if (typeof id === 'string') return id
  }
  return null
}

/**
 * Usage per response and time per tool. A tool's clock starts when its gate lets it through, so a
 * call parked for an approval isn't charged for the wait. Installed after gate(), so a held call's
 * beforeTool never reaches this one.
 */
export function meter(meter: Meter): HookRegistration[] {
  return [
    hook(GenerationTask, {
      async afterResponse(message) {
        await meter.response(message as any)
      },
    }),
    hook(ToolTask, {
      async beforeTool(call) {
        await meter.tool(call.id, call.name, 'start')
        return undefined
      },
      async afterTool(call, result) {
        await meter.tool(call.id, call.name, 'end', result.isError !== true)
        return undefined
      },
    }),
  ]
}

/** The Session object's RPC face, as the adapter calls it (seats/session.ts). */
export type SessionStub = {
  configure(seat: SeatRef): Promise<void>
  submit(input: Turn | ToolAnswer, options: SubmitOptions): Promise<Receipt>
  wait(operationId: string, timeoutMs?: number): Promise<Outcome>
  abort(operationId?: string): Promise<void>
  watch(): Promise<ReadableStream<Uint8Array>>
}

/** A session's name: one Session object per seat and thread. */
export const sessionName = (seat: string, thread: string) => seat + ':' + thread

/** The seam over Session objects: open() names the seat's session for a thread and configures it. */
export class PiHarnessAdapter implements Harness {
  #sessions: DurableObjectNamespace
  constructor(sessions: DurableObjectNamespace) {
    this.#sessions = sessions
  }

  async open(seat: SeatRef, thread: string): Promise<HarnessSession> {
    const id = sessionName(seat.key, thread)
    const stub = (await getAgentByName(this.#sessions as any, id)) as unknown as SessionStub
    await stub.configure(seat)
    return {
      id,
      submit: (input, options) => stub.submit(input, options),
      wait: (operationId, signal) => {
        const answered = stub.wait(operationId)
        if (!signal) return answered
        return Promise.race([answered, new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))])
      },
      abort: (operationId) => stub.abort(operationId),
      watch: () => events(stub),
    }
  }
}

async function* events(stub: SessionStub): AsyncIterable<SessionEvent> {
  const lines = (await stub.watch()).getReader()
  const decoder = new TextDecoder()
  let rest = ''
  for (;;) {
    const { value, done } = await lines.read()
    if (done) return
    rest += decoder.decode(value, { stream: true })
    let at: number
    while ((at = rest.indexOf('\n')) >= 0) {
      const line = rest.slice(0, at)
      rest = rest.slice(at + 1)
      if (line) yield JSON.parse(line) as SessionEvent
    }
  }
}
