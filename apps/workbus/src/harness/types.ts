// The harness seam (design/workbus.md §5.3): our own interface, copied from the Agents SDK's draft
// AgentHarness (agents/experimental/channels), so a second harness is a second adapter. A seat's
// sessions, its tools, and its run records see only these types; pi.ts maps them onto Pi.
import type { z } from 'zod'

/** The tool tiers a seat doc grants (§5.4). Phase 2 builds board and computer. */
export type ToolTier = 'board' | 'computer'

/** A seat, as a session needs it: who it is, what it may do, and what its prompt is made of. */
export type SeatRef = {
  /** The seat's key: its actor is worker:workbus-app+<key>, and its Seat object is named by it. */
  key: string
  name: string
  handle: string
  avatar?: string
  team: string
  /** The seat doc's can: the narrowing its Board gets. It never widens. */
  can: Record<string, string | readonly string[]> | string
  tools: readonly ToolTier[]
  /** The system prompt's parts (§5.2): the charter, the team's doc, the org's structure, the skills' index. */
  prompt: { charter: string; team?: string; org?: string; skills?: string }
  /** Tools the seat doc puts behind an approval, by name, with the kind each holds for: { exec: 'approval' }. */
  approve?: Readonly<Record<string, string>>
  /** Approval kinds the principal made automatic for this seat. Deletes, spending, and permissions still ask (§6.2). */
  automatic?: readonly string[]
  /** The seat doc's revision, for the run record's charter. */
  revision: string
}

export interface Harness {
  open(seat: SeatRef, thread: string): Promise<HarnessSession>
}

export type InputPart = { type: 'text'; text: string }

/** A wake-up, as the model reads it. */
export type Turn = { type: 'turn'; parts: readonly InputPart[] }

/** The principal's answer to an approval (§6.2): approvalId is the held task's ID on the board. */
export type ToolAnswer = { type: 'approval'; approvalId: string; approved: boolean; reason?: string }

export type SubmitOptions = {
  /** The wake-up's event cursor: submitting it twice returns the same receipt and runs once. */
  operationId: string
  whenBusy?: 'followUp' | 'steer'
}

export type Receipt = { operationId: string; session: string; accepted: boolean }

/** What one operation cost and did: the run record's measured half (§8.2). */
export type Usage = {
  model: string | null
  /** Model responses. */
  steps: number
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }
  /** USD, as the model's price list gives it; the gateway's logs are the bill. */
  cost: number
  tools: { name: string; ms: number; ok: boolean }[]
  /** AI Gateway log IDs (cf-aig-log-id), one per response, to join the gateway's logs. */
  logs: string[]
  started: string
  ended: string | null
}

export type Outcome = {
  operationId: string
  session: string
  status: 'done' | 'unanswered'
  /** Why an unanswered operation ended, in the harness's words. */
  reason?: string
  /** The final answer's text. */
  text?: string
  usage: Usage
}

export type TranscriptMessage = {
  id: string
  role: 'user' | 'assistant' | 'tool'
  text: string
  tool?: { name: string; call: string; ok?: boolean }
}

export type OperationStatus = { operationId: string; status: 'queued' | 'running' | 'done' | 'unanswered'; reason?: string }

export type SessionEvent =
  | { type: 'operation'; status: OperationStatus }
  | { type: 'run-start'; operations: string[] }
  | { type: 'run-end'; operations: string[] }
  | { type: 'message'; message: TranscriptMessage }
  | { type: 'approval'; approvalId: string; tool: string; state: 'held' | 'approved' | 'denied' }

export interface HarnessSession {
  readonly id: string
  submit(input: Turn | ToolAnswer, options: SubmitOptions): Promise<Receipt>
  wait(operationId: string, signal?: AbortSignal): Promise<Outcome>
  abort(operationId?: string): Promise<void>
  /** The transcript so far, then every change, in order. */
  watch(): AsyncIterable<SessionEvent>
}

/** Where a tool runs: its seat, its thread, and the call. */
export type ToolContext = {
  seat: SeatRef
  thread: string
  callId: string
  signal: AbortSignal
}

export type ToolResult = { text: string; isError?: boolean }

export type Tool<I> = {
  name: string
  description: string
  input: z.ZodType<I>
  /** A JSON Schema to offer the model instead of the one input makes, for tools written against one. */
  schema?: object
  replay: 'safe' | 'unsafe' // only Pi reads it today; we keep it for every harness
  approval: 'never' | 'always' | { kind: string } // §6.2
  run(input: I, context: ToolContext): Promise<ToolResult>
}
