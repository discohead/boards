// A message's text as Markdown, rendered as docs are (src/docs/markdown.tsx), with mentions.
import { Markdown } from '@/docs/markdown'
import { Mention, mentionExtension } from './mentions.tsx'

const extensions = [mentionExtension]
const components = { mention: Mention }

export function MessageText({ text }: { text: string }) {
  return (
    <div className="message-text" data-testid="message-text">
      <Markdown compact extensions={extensions} components={components}>
        {text}
      </Markdown>
    </div>
  )
}
