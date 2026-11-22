// The browser's one bus: /b/bus on the same origin, with the Access cookie. In development, where
// there's no Access, a board token can be given once as #token=<token> and is kept for the tab.
import { createBus, type Bus } from './data/index.ts'

let bus: Bus | null = null

export function browserBus(): Bus {
  if (bus) return bus
  let token: string | undefined
  if (import.meta.env.DEV) {
    const given = /[#&]token=([^&]+)/.exec(location.hash)?.[1]
    if (given) sessionStorage.setItem('workbus-token', given), history.replaceState(null, '', location.pathname + location.search)
    token = sessionStorage.getItem('workbus-token') ?? undefined
  }
  bus = createBus({ url: '/b/bus', ...(token ? { token } : {}) })
  return bus
}
