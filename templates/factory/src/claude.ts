// Claude, through your Cloudflare AI Gateway: the Worker's AI binding, the gateway's stored
// Anthropic key, and the Messages API as Anthropic documents it. No model SDK.
import type { Env } from './env.ts'

export type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
export type Message = { role: 'user' | 'assistant'; content: string | Block[] }
export type ToolDef = { name: string; description: string; input_schema: Record<string, unknown> }
export type Reply = { content: Block[]; stop_reason: string; usage?: Record<string, number> }

export const DEFAULT_MODEL = 'claude-haiku-5-5'

export async function claude(env: Env, request: { system: string; messages: Message[]; tools: ToolDef[]; maxTokens?: number }): Promise<Reply> {
  const body = {
    model: env.MODEL || DEFAULT_MODEL,
    max_tokens: request.maxTokens ?? 8192,
    // The instructions and tools are the same every step of every turn: cached.
    system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
    tools: request.tools.map((tool, i) => (i === request.tools.length - 1 ? { ...tool, cache_control: { type: 'ephemeral' } } : tool)),
    messages: request.messages,
  }
  // No x-api-key: the gateway adds the Anthropic key it keeps, under the alias named here. The binding is the gateway's credential.
  const headers = { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', ...(env.AI_GATEWAY_BYOK_ALIAS ? { 'cf-aig-byok-alias': env.AI_GATEWAY_BYOK_ALIAS } : {}) }
  const response = await env.AI.gateway(env.AI_GATEWAY_ID).run({ provider: 'anthropic', endpoint: 'v1/messages', headers, query: body })
  const text = await response.text()
  if (!response.ok) throw new Error('Claude answered ' + response.status + ': ' + text.slice(0, 500))
  return JSON.parse(text) as Reply
}
