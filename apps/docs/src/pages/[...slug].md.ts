// src/pages/[...slug].md.ts: every docs page as Markdown (see src/lib/page-markdown.ts).
import type { APIContext } from 'astro'
import { docsPaths, pageMarkdown } from '../lib/page-markdown.ts'

export const getStaticPaths = docsPaths
export const GET = (context: APIContext) => pageMarkdown(context.props.entry, context)
