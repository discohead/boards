// The theme and density settings: light, dark, or the system's (the default); compact (the
// default) or comfortable. They live in localStorage and on <html> as data-theme and
// data-density, set by an inline script before first paint so nothing flashes.
import { useCallback, useSyncExternalStore } from 'react'

export type ThemeSetting = 'system' | 'light' | 'dark'
export type Density = 'compact' | 'comfortable'

const THEME = 'workbus.theme'
const DENSITY = 'workbus.density'

// Runs in <head> before the body paints, and again on every change. It follows the system's
// preference while the setting is 'system'. Plain ES5, as a string: nothing of the bundle exists yet.
export const appearanceScript = `(function(){var d=document.documentElement,m=matchMedia('(prefers-color-scheme: dark)');function get(k,v){try{return localStorage.getItem(k)||v}catch(e){return v}}function apply(){var t=get('${THEME}','system');d.dataset.theme=t==='dark'||(t==='system'&&m.matches)?'dark':'light';d.dataset.density=get('${DENSITY}','compact')==='comfortable'?'comfortable':'compact'}apply();m.addEventListener('change',apply);addEventListener('storage',apply);window.__wbAppearance=apply})()`

declare global {
  interface Window {
    __wbAppearance?: () => void
  }
}

const listeners = new Set<() => void>()
function subscribe(fn: () => void) {
  listeners.add(fn)
  const media = matchMedia('(prefers-color-scheme: dark)')
  media.addEventListener('change', fn)
  addEventListener('storage', fn)
  return () => {
    listeners.delete(fn)
    media.removeEventListener('change', fn)
    removeEventListener('storage', fn)
  }
}

function read(key: string, fallback: string) {
  try {
    return localStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // private mode: the setting lasts for the page
  }
  window.__wbAppearance?.()
  for (const fn of listeners) fn()
}

/** The theme setting, the theme it resolves to, and a setter. */
export function useTheme() {
  const theme = useSyncExternalStore(subscribe, () => read(THEME, 'system') as ThemeSetting, () => 'system' as ThemeSetting)
  const resolved = useSyncExternalStore<'light' | 'dark'>(
    subscribe,
    () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'),
    () => 'light',
  )
  const setTheme = useCallback((next: ThemeSetting) => store(THEME, next), [])
  return { theme, resolved, setTheme }
}

/** The density setting and a setter. */
export function useDensity() {
  const density = useSyncExternalStore(
    subscribe,
    () => (read(DENSITY, 'compact') === 'comfortable' ? 'comfortable' : 'compact') as Density,
    () => 'compact' as Density,
  )
  const setDensity = useCallback((next: Density) => store(DENSITY, next), [])
  return { density, setDensity }
}
