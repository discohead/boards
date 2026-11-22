// Highlight's colors, as CSS: GitHub's light and dark themes on Markdown's code blocks.
import { createThemeCss } from '@tanstack/highlight/theme'
import { githubDarkTheme } from '@tanstack/highlight/themes/github-dark'
import { githubLightTheme } from '@tanstack/highlight/themes/github-light'

export const codeThemeCss = createThemeCss({ light: githubLightTheme, dark: githubDarkTheme, darkSelector: '.dark', codeBlockSelector: 'pre.tm-code' })
