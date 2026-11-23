// Avatar initials for any actor, the same everywhere (design system: people round, agents square).
// A seat (worker:workbus-app+<key>) is drawn by its handle as the org views draw it, so seats whose
// handles start alike get unlike initials (Ada AD, Advisor AV); anyone else by their name's words.
import { seatInitials } from './use-seats.ts'
import { APP_PRINCIPAL } from './views.ts'

/** A name's initials: the first letter of its first two words. */
export const nameInitials = (name: string) => name.split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((part) => part[0]!.toUpperCase()).join('') || '?'

export function initialsFor(actor: string | null | undefined, name: string, handle?: string | null): string {
  if (actor && actor.startsWith(APP_PRINCIPAL + '+')) return seatInitials({ name, handle: handle ?? actor.slice(APP_PRINCIPAL.length + 1) })
  return nameInitials(name)
}
