// Message text as people read it outside the message itself: the board writes a mention as
// @[<actor ID>], and a title, a row, or a palette result shows it as @handle. One place, so every
// title and one-line summary says the same thing.

type Actors = { get: (id: string) => { handle: string } | undefined }

const MENTION = /@\[([^\]\s]{1,256})\]/g

/** An actor's handle, from what the app knows of it, or the last part of its ID. */
export const handleOf = (actors: Actors, id: string) => actors.get(id)?.handle ?? id.replace(/^.*[:+]/, '')

/** Text as it was typed, with mentions as @handle: what an edit starts from. */
export const typedText = (text: string, actors: Actors) => text.replace(MENTION, (_all, id: string) => '@' + handleOf(actors, id))

/** A message's one-line summary: its first line with text, without a heading's #s, mentions as @handle. */
export const summaryOf = (text: string, actors: Actors) => typedText(text.split('\n').find((line) => line.trim()) ?? '', actors).replace(/^#+\s*/, '').trim()

/** Actors as summaryOf reads them, from a live name lookup (useActorNames), so titles follow the actors as they load. */
export const named = (name: (id: string) => string): Actors => ({ get: (id) => ({ handle: name(id) }) })
