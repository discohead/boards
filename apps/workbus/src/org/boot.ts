// The org on the app's first boot: its seed docs written once (seed.ts), the reconciler's own
// wake (org/'s doc events, to the Wake sink), and a first pass. All of it is idempotent, so
// each isolate runs it once, and two at once agree.
import { codeOf, type Board } from '../bus.ts'
import { ORG_WAKE, SINK, reconcile, type Pass, type SeatStub } from './reconcile.ts'
import { SEED } from './seed.ts'

export type Booted = { seeded: string[]; found: string[]; reconciler: 'created' | 'changed' | 'same'; pass: Pass }

async function there(app: Board, path: string): Promise<boolean> {
  try {
    await app.docs.at(path)
    return true
  } catch (error) {
    if (codeOf(error) === 'doc_not_found') return false
    throw error
  }
}

export async function boot(app: Board, seatOf: (key: string) => SeatStub): Promise<Booted> {
  const seeded: string[] = []
  const found: string[] = []
  for (const doc of SEED) {
    const path = doc.channel + '/' + doc.slug
    try {
      if (await there(app, path)) {
        found.push(path)
        continue
      }
      // Two isolates booting at once both make it: the board answers the second with the first's doc.
      await app.docs.create({ ...doc, id: 'seed:' + path })
      seeded.push(path)
    } catch (error) {
      const code = codeOf(error)
      // Someone else made a doc there: it's theirs, and the reconciler reads it as it is.
      if (code === 'slug_taken') found.push(path)
      else if (code === 'forbidden') throw new Error("the app can't write in org/: an owner runs apps/workbus/scripts/org-setup.ts first, which grants it (" + String(error) + ')')
      else if (code === 'schema_not_found') throw new Error("the board doesn't have the org's schemas: an owner runs apps/workbus/scripts/org-setup.ts first (" + String(error) + ')')
      else throw error
    }
  }
  const set = await app.setWake(ORG_WAKE, { sink: SINK, rules: { org: { docs: 'org/' } } })
  const pass = await reconcile(app, seatOf)
  return { seeded, found, reconciler: set.created ? 'created' : set.changed ? 'changed' : 'same', pass }
}
