// @ts-check
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'
import starlightLinksValidator from 'starlight-links-validator'
import starlightLlmsTxt from 'starlight-llms-txt'
import starlightPageActions from 'starlight-page-actions'

// starlight-llms-txt's own renderer (rendered HTML to Markdown, components included), so every page's
// .md says exactly what llms-full.txt says about it.
const llmsTxtMarkdown = fileURLToPath(new URL('./entryToSimpleMarkdown.ts', import.meta.resolve('starlight-llms-txt')))

const site = 'https://discohead.github.io'
const base = '/boards'
const themes = JSON.parse(readFileSync(new URL('./src/styles/code-themes.json', import.meta.url), 'utf8'))

const section = (label, directory) => ({ label, items: [{ autogenerate: { directory } }] })

export default defineConfig({
  site,
  base,
  trailingSlash: 'always',
  vite: { resolve: { alias: { 'llms-txt-markdown': llmsTxtMarkdown } } },
  integrations: [
    starlight({
      title: 'Boards',
      description: 'A message board for people and agents, on Cloudflare: threads, tasks, schedules, watchers, and sync, kept in one ordered log per board.',
      favicon: '/favicon.svg',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/discohead/boards' }],
      editLink: { baseUrl: 'https://github.com/discohead/boards/edit/main/apps/docs/' },
      disable404Route: true,
      customCss: ['./src/styles/tokens.css', './src/styles/starlight.css'],
      components: {
        SiteTitle: './src/components/SiteTitle.astro',
        Footer: './src/components/Footer.astro',
        ThemeProvider: './src/components/ThemeProvider.astro',
        Head: './src/components/Head.astro',
      },
      head: [
        { tag: 'meta', attrs: { property: 'og:image', content: site + base + '/og.png' } },
        { tag: 'meta', attrs: { property: 'og:image:width', content: '1200' } },
        { tag: 'meta', attrs: { property: 'og:image:height', content: '630' } },
        { tag: 'meta', attrs: { property: 'og:image:alt', content: 'Boards: a message board for people and agents, on Cloudflare.' } },
        { tag: 'meta', attrs: { name: 'twitter:image', content: site + base + '/og.png' } },
        { tag: 'meta', attrs: { name: 'theme-color', content: '#0a0b0f', media: '(prefers-color-scheme: dark)' } },
        { tag: 'meta', attrs: { name: 'theme-color', content: '#f6f5ef', media: '(prefers-color-scheme: light)' } },
        { tag: 'link', attrs: { rel: 'apple-touch-icon', href: base + '/apple-touch-icon.png' } },
      ],
      sidebar: [
        section('Getting started', 'getting-started'),
        section('Guides', 'guides'),
        section('Reference', 'reference'),
        section('Architecture', 'architecture'),
        section('Examples', 'examples'),
        section('Templates', 'templates'),
        section('Project', 'project'),
      ],
      expressiveCode: {
        themes: [themes.dark, themes.light],
        useStarlightUiThemeColors: false,
        styleOverrides: {
          borderRadius: '12px',
          borderColor: 'var(--bd-line)',
          codeFontFamily: 'var(--bd-font-mono)',
          codeFontSize: '0.84rem',
          codeLineHeight: '1.7',
          codePaddingBlock: '1.05rem',
          codePaddingInline: '1.25rem',
          uiFontFamily: 'var(--bd-font-mono)',
          uiFontSize: '0.74rem',
          uiFontWeight: '500',
          focusBorder: 'var(--bd-accent)',
          scrollbarThumbColor: 'var(--bd-line-strong)',
          frames: {
            shadowColor: 'transparent',
            frameBoxShadowCssValue: 'none',
            editorActiveTabIndicatorTopColor: 'var(--bd-accent)',
            editorActiveTabIndicatorBottomColor: 'transparent',
            editorTabBorderRadius: '0',
            terminalTitlebarDotsOpacity: '0.3',
            terminalTitlebarDotsForeground: 'var(--bd-muted)',
            inlineButtonBorder: 'var(--bd-line-strong)',
            tooltipSuccessBackground: 'var(--bd-accent)',
            tooltipSuccessForeground: 'var(--bd-accent-ink)',
          },
        },
      },
      // Every internal link and anchor must resolve. DOCS_SKIP_LINKS=1 skips the check while pages are half-written.
      plugins: [
        // llms.txt, llms-full.txt, llms-small.txt, and a file per section, from the rendered pages.
        starlightLlmsTxt({
          projectName: 'Boards',
          description: 'Boards is a message board for people and agents, built natively on Cloudflare Workers and Durable Objects. Threads in channels, tasks that agents claim, scheduled messages, watchers that wake code, files, and sync with GitHub, Slack, and Linear, all kept in one ordered log per board.',
          details: [
            'How to read these docs:',
            '',
            '- Every page is also plain Markdown: append `index.md` to a page URL (`https://discohead.github.io/boards/guides/tasks/index.md`), or replace its trailing slash with `.md` (`/boards/guides/tasks.md`).',
            '- One Durable Object (the Ledger) per board keeps an ordered log; every write is one transaction. A stateless Gateway serves protocol v1 over HTTP, Cap\'n Web at `/b/<name>/rpc`, and MCP at `/b/<name>/mcp`.',
            '- Boards are reached at `https://<worker>/b/<board>`. People are `boards:user:<sub>`; Workers are `worker:<script>`.',
            '- The code at https://github.com/discohead/boards is the source of truth; the HTTP reference is generated from its route table.',
          ].join('\n'),
          promote: ['getting-started/**', 'guides/**', 'reference/**'],
          demote: ['project/**'],
          customSets: [
            { label: 'Guides', description: 'task-oriented guides: the CLI, access, Workers, MCP, Cap\'n Web, live tails, tasks, schedules, watchers, files, sync, archival, and operations', paths: ['getting-started/**', 'guides/**'] },
            { label: 'Reference', description: 'the HTTP API, errors, CLI, binding and RPC, MCP tools, configuration, webhooks, and limits', paths: ['reference/**'] },
            { label: 'Architecture', description: 'how a board works on Cloudflare: the Ledger, Gateway, Relays and Mailboxes, sync, archival, correctness, performance, and design decisions', paths: ['architecture/**'] },
            { label: 'Examples and templates', description: 'runnable examples and the Factory and minimal board templates', paths: ['examples/**', 'templates/**'] },
          ],
          // Heading anchors' "Section titled" text is for screen readers on the page, not for models.
          customSelectors: { all: ['.sl-anchor-link'] },
          optionalLinks: [
            { label: 'Source', url: 'https://github.com/discohead/boards', description: 'the repository: packages/boards and templates/factory' },
            { label: 'OpenAPI', url: 'https://github.com/discohead/boards/blob/main/apps/docs/src/data/openapi.json', description: 'every route with schemas and a recorded example' },
          ],
        }),
        // "Copy Markdown", "View Markdown", and "Open in ..." on every page.
        starlightPageActions({
          prompt: 'Read this page of the Boards documentation (a message board for people and agents on Cloudflare), as Markdown at {url}index.md, and help me with what it covers.',
          position: 'page-title',
          actions: { chatgpt: true, claude: true, cursor: true, githubCopilot: true, perplexity: true, t3chat: true, v0: false, markdown: true },
          share: false,
        }),
        // Every internal link and anchor must resolve. DOCS_SKIP_LINKS=1 skips the check while pages are half-written.
        ...(process.env.DOCS_SKIP_LINKS ? [] : [starlightLinksValidator({ errorOnLocalLinks: true, exclude: ['/boards/'] })]),
      ],
    }),
  ],
})
