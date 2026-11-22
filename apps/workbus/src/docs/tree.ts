// The docs tree (design/workbus.md §9.3): every doc by its path, nested like Notion's pages. A path's
// segments are folders; a doc at a path that's also a folder (docs/specs/api beside
// docs/specs/api/v1) is that folder's page. A doc whose root is also a task is an issue, and shows
// as one, not here.
import type { Doc } from '@/data/types'

export type TreeNode = {
  /** The path to here: "docs/runbooks". */
  path: string
  /** The last segment: "runbooks". */
  name: string
  doc: Doc | null
  children: TreeNode[]
}

/** A doc whose root is also a task. */
export const isIssue = (doc: Doc) => doc.labels?.['board.task'] !== undefined

export function buildTree(docs: Iterable<Doc>): TreeNode[] {
  const root: TreeNode = { path: '', name: '', doc: null, children: [] }
  const at = new Map<string, TreeNode>([['', root]])
  const node = (path: string): TreeNode => {
    const had = at.get(path)
    if (had) return had
    const cut = path.lastIndexOf('/')
    const parent = node(cut < 0 ? '' : path.slice(0, cut))
    const made: TreeNode = { path, name: path.slice(cut + 1), doc: null, children: [] }
    parent.children.push(made)
    at.set(path, made)
    return made
  }
  for (const doc of docs) if (!isIssue(doc)) node(doc.path).doc = doc
  const order = (nodes: TreeNode[]) => {
    // Folders before pages, then by title or name.
    nodes.sort((a, b) => Number(a.children.length === 0) - Number(b.children.length === 0) || label(a).localeCompare(label(b)))
    for (const child of nodes) order(child.children)
  }
  order(root.children)
  return root.children
}

export const label = (node: TreeNode) => node.doc?.title ?? node.name

/** The folders on the way to a path, so the tree opens to it. */
export const ancestors = (path: string) => path.split('/').slice(0, -1).map((_, index, all) => all.slice(0, index + 1).join('/'))
