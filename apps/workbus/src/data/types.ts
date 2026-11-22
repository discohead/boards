// The board's shapes, as far as the app reads them (protocol v1: packages/workbus/src/protocol).

export type By = { actor: string; principal: string; profile: string | null }

export type TaskFacet = {
  state: string
  owner: string | null
  by: string
  for: string | null
  needs: string[]
  epoch: number
  claim: { actor: string; until: string } | null
  blocked: unknown
  result: unknown
  reason: string | null
}

export type DocFacet = {
  id: string
  path: string
  title: string
  revision: string
  size: number
  sections: { key: string; title: string; level: number; changed: string; subtree: string }[]
  createdAt: string
  proposals?: unknown[]
}

export type Message = {
  id: string
  channel: string
  text: string
  re: string | null
  replyTo: string | null
  thread: string
  labels: Record<string, string>
  reactions: Record<string, unknown>
  by: By
  createdAt: string
  editedAt: string | null
  deleted: boolean
  version: number
  revision: number
  author?: { kind: string; handle: string; name: string; avatar: string | null; verified: boolean }
  task?: TaskFacet
  doc?: DocFacet
  /** Set on a write the board hasn't answered yet: the client ID it was sent with. */
  pending?: string
  [key: string]: unknown
}

export type Actor = { id: string; kind: string; handle: string; name: string; avatar: string | null; verified?: boolean }

export type BoardEvent = { cursor: string; type: string; createdAt: string; payload: Record<string, unknown>; message?: Message; actor?: Actor }

/** A thread in a list: its root, how many replies, and the newest. */
export type Thread = { id: string; channel: string; root: Message; replies: number; last: Message | null }

/** A doc in the tree: its facet and where it is, without its body. */
export type Doc = DocFacet & { channel: string; thread: string }

/** An open doc's body, at a revision. */
export type DocBody = { id: string; revision: string; body: string }

export type Follow = { thread: string; discussion: string | null; channel: string; cause: string; at: string }
