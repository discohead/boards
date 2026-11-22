// The app Worker's entry: Start's handler behind an Access check, and (later) the app's Durable
// Objects and entrypoints as named exports (design/workbus.md §9.1).
import handler from '@tanstack/react-start/server-entry'
import { checkAccess } from './access.ts'

export default {
  async fetch(request, env) {
    const refused = await checkAccess(request, env)
    if (refused) return refused
    return handler.fetch(request)
  },
} satisfies ExportedHandler<Env>
