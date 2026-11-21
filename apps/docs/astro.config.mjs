// @ts-check
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'
import starlightLinksValidator from 'starlight-links-validator'

const site = 'https://discohead.github.io'
const base = '/boards'
const themes = JSON.parse(readFileSync(new URL('./src/styles/code-themes.json', import.meta.url), 'utf8'))

const section = (label, directory) => ({ label, items: [{ autogenerate: { directory } }] })

export default defineConfig({
  site,
  base,
  trailingSlash: 'always',
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
      plugins: process.env.DOCS_SKIP_LINKS ? [] : [starlightLinksValidator({ errorOnLocalLinks: true, exclude: ['/boards/'] })],
    }),
  ],
})
