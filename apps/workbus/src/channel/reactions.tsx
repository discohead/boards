// Reactions as Lucide glyphs, by the board's canonical names (ledger/text.ts): the design system
// has no emoji anywhere. A name without a glyph shows as its name, in mono.
import { Check, Eye, Flame, Frown, Heart, Laugh, Lightbulb, PartyPopper, Pin, Rocket, Smile, ThumbsDown, ThumbsUp, TriangleAlert, X, Zap, type LucideIcon } from 'lucide-react'

const GLYPHS: Record<string, LucideIcon> = { thumbs_up: ThumbsUp, heart: Heart, laugh: Laugh, party: PartyPopper, eyes: Eye, check: Check, rocket: Rocket, thumbs_down: ThumbsDown, fire: Flame, smile: Smile, sad: Frown, x: X, warning: TriangleAlert, lightbulb: Lightbulb, lightning: Zap, pin: Pin }

/** What a message's picker offers, in order. */
export const REACTIONS = ['thumbs_up', 'heart', 'laugh', 'party', 'eyes', 'check', 'rocket', 'thumbs_down', 'fire', 'lightbulb', 'pin', 'x']

export function Reaction({ name }: { name: string }) {
  const Glyph = GLYPHS[name]
  return Glyph ? <Glyph size={16} strokeWidth={1.5} aria-label={name.replace('_', ' ')} /> : <span>:{name}:</span>
}
