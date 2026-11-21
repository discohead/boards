// Each docs page as Markdown, for agents: a header naming the page and where it lives, then the page
// rendered and converted the way llms-full.txt converts it.
import type { APIContext } from 'astro'
import { getCollection, type CollectionEntry } from 'astro:content'
// @ts-expect-error: starlight-llms-txt's renderer, aliased in astro.config.mjs
import { entryToSimpleMarkdown } from 'llms-txt-markdown'

export const SITE = 'https://discohead.github.io/boards'

export async function docsPaths() {
  const docs = await getCollection('docs')
  return docs.map((entry) => ({ params: { slug: entry.id }, props: { entry } }))
}

export async function pageMarkdown(entry: CollectionEntry<'docs'>, context: APIContext) {
  const url = SITE + '/' + entry.id + '/'
  const body = (await entryToSimpleMarkdown(entry, context, false)) as string
  const header = ['# ' + entry.data.title, '', '> ' + (entry.data.description ?? ''), '', 'Source: ' + url, 'Markdown: ' + url + 'index.md', 'All docs for agents: ' + SITE + '/llms.txt']
  return new Response(header.join('\n') + '\n\n' + body.trim() + '\n', { headers: { 'content-type': 'text/markdown; charset=utf-8' } })
}
