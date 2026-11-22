// Markdown as the app renders it (design/workbus.md §9.1): TanStack Markdown for the body, TanStack
// Highlight for fenced code, bare URLs as links, and [[path]] / [[path#section]] doc links
// (design/docs.md §6) resolved against the docs the app has.
import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import type { InlineComponentNode, MarkdownExtension } from '@tanstack/markdown'
import { autolinksExtension } from '@tanstack/markdown/extensions/autolinks'
import { Markdown as TanStackMarkdown, type MarkdownComponents } from '@tanstack/markdown/react'
import { createHighlighter } from '@tanstack/highlight/core'
import { createTanStackMarkdownHighlighter } from '@tanstack/highlight/markdown'
import { css } from '@tanstack/highlight/languages/css'
import { diff } from '@tanstack/highlight/languages/diff'
import { go } from '@tanstack/highlight/languages/go'
import { html } from '@tanstack/highlight/languages/html'
import { js } from '@tanstack/highlight/languages/js'
import { json } from '@tanstack/highlight/languages/json'
import { jsx } from '@tanstack/highlight/languages/jsx'
import { markdown } from '@tanstack/highlight/languages/markdown'
import { plaintext } from '@tanstack/highlight/languages/plaintext'
import { python } from '@tanstack/highlight/languages/python'
import { rust } from '@tanstack/highlight/languages/rust'
import { shell } from '@tanstack/highlight/languages/shell'
import { sql } from '@tanstack/highlight/languages/sql'
import { toml } from '@tanstack/highlight/languages/toml'
import { ts } from '@tanstack/highlight/languages/ts'
import { tsx } from '@tanstack/highlight/languages/tsx'
import { yaml } from '@tanstack/highlight/languages/yaml'
import docsCss from './docs.css?raw'
import { codeThemeCss } from './theme'

export const highlighter = createHighlighter({ languages: [css, diff, go, html, js, json, jsx, markdown, plaintext, python, rust, shell, sql, toml, ts, tsx, yaml] })
const highlight = createTanStackMarkdownHighlighter(highlighter)

const LINK = /^\[\[([a-z0-9][a-z0-9_/-]*?)(?:#([^\]\n]+))?\]\]/

/** [[docs/runbooks/deploy]] and [[docs/runbooks/deploy#rollback]], as a doc-link element. */
export const docLinks: MarkdownExtension = {
  name: 'workbus-doc-links',
  inlineParser: {
    markers: '[',
    parse(context) {
      if (context.inLink) return undefined
      const match = LINK.exec(context.source.slice(context.index, context.index + 2300))
      if (!match) return undefined
      const [all, path, section] = match
      const node: InlineComponentNode = {
        type: 'inlineComponent',
        name: 'doc-link',
        tagName: 'doc-link',
        attributes: {},
        properties: { path: path!, ...(section ? { section } : {}) },
        children: [{ type: 'text', value: section ? path + '#' + section : path! }],
      }
      return { node, length: all.length }
    },
  },
}

const extensions: MarkdownExtension[] = [docLinks, autolinksExtension()]

/** Where the app finds a doc by its path: path to ID. */
export const DocPaths = createContext<ReadonlyMap<string, string>>(new Map())

function DocLink({ path, section, children }: { path: string; section?: string; children?: ReactNode }) {
  const id = useContext(DocPaths).get(path)
  if (!id)
    return (
      <span className="doc-link doc-link--missing" title={'No doc at ' + path} data-doc-link={path}>
        {children}
      </span>
    )
  return (
    <Link to="/docs/$id" params={{ id }} hash={section} className="doc-link" data-doc-link={path}>
      {children}
    </Link>
  )
}

const components: MarkdownComponents = {
  'doc-link': DocLink,
  a: (props) => <a {...props} {...(props.href?.startsWith('http') ? { target: '_blank', rel: 'noopener noreferrer' } : {})} />,
}

/** The CSS Markdown needs (prose and code colors), once per page however many render: React 19 hoists and dedupes it. */
function Styles() {
  return (
    <style href="workbus-markdown" precedence="default">
      {docsCss + '\n' + codeThemeCss}
    </style>
  )
}

export type MarkdownProps = {
  children: string
  headingIds?: boolean
  /** Chat spacing, for messages. */
  compact?: boolean
  /** More syntax, after the app's own (a message's mentions). */
  extensions?: MarkdownExtension[]
  /** Elements to draw differently, over the app's own. */
  components?: MarkdownComponents
}

/** Markdown from the board: no raw HTML, frontmatter off (a message or a section isn't a file). */
export function Markdown({ children, headingIds = false, compact = false, extensions: more, components: over }: MarkdownProps) {
  const all = useMemo(() => (more?.length ? [...extensions, ...more] : extensions), [more])
  const drawn = useMemo(() => (over ? { ...components, ...over } : components), [over])
  return (
    <div className={compact ? 'markdown markdown--compact' : 'markdown'}>
      <Styles />
      <TanStackMarkdown extensions={all} components={drawn} highlighter={highlight} frontmatter={false} headingIds={headingIds}>
        {children}
      </TanStackMarkdown>
    </div>
  )
}
