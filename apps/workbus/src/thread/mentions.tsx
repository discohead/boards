// Mentions in a message: the board writes @handle as @[<actor ID>]. They render as the actor's
// handle, marked when it's the reader, and link to its DM channel when there is one.
import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import type { InlineComponentNode, MarkdownExtension } from '@tanstack/markdown'
import { useBus } from '@/data'
import { cn } from '@/lib/utils'

const MENTION = /^@\[([^\]\s]{1,256})\]/

export const mentionExtension: MarkdownExtension = {
  name: 'workbus-mentions',
  inlineParser: {
    markers: '@',
    parse(context) {
      if (context.inLink) return undefined
      const match = MENTION.exec(context.source.slice(context.index, context.index + 260))
      if (!match) return undefined
      const node: InlineComponentNode = { type: 'inlineComponent', name: 'mention', tagName: 'mention', attributes: {}, properties: { actor: match[1]! }, children: [{ type: 'text', value: match[0] }] }
      return { node, length: match[0].length }
    },
  },
}

/** An actor's handle, from what the app knows of it, or the last part of its ID. */
export const handleOf = (actors: { get: (id: string) => { handle: string } | undefined }, id: string) => actors.get(id)?.handle ?? id.replace(/^.*[:+]/, '')

export function Mention({ actor }: { actor: string; children?: ReactNode }) {
  const bus = useBus()
  const handle = handleOf(bus.actors, actor)
  const me = actor === bus.runtime.me.actor
  const dm = 'dm/' + handle
  // A mention of the reader is waiting on them: held, in the brand color. Others are handles, in mono.
  const className = cn('mention rounded-sm px-0.5 font-mono text-[0.92em]', me ? 'bg-primary/10 font-semibold text-primary' : 'text-foreground')
  if (bus.channels.get(dm))
    return (
      <Link to="/c/$" params={{ _splat: dm }} className={className} data-mention={actor} title={actor}>
        @{handle}
      </Link>
    )
  return (
    <span className={className} data-mention={actor} title={actor}>
      @{handle}
    </span>
  )
}

/** Text as it was typed, with mentions as @handle: what an edit starts from. */
export const typedText = (text: string, actors: { get: (id: string) => { handle: string } | undefined }) => text.replace(/@\[([^\]\s]{1,256})\]/g, (_all, id: string) => '@' + handleOf(actors, id))
