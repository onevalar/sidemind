import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ComponentProps } from 'react'
import { linkedNoteName } from './note-links'

export function NoteLink({ source, onOpenNote, href, children, ...props }: ComponentProps<'a'> & { source: string; onOpenNote?: (name: string) => void }) {
  return <a {...props} href={href} onClick={event => {
    const name = href ? linkedNoteName(href, source) : null
    if (name && onOpenNote && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
      event.preventDefault(); event.stopPropagation(); onOpenNote(name)
    }
  }}>{children}</a>
}

export function NoteMarkdown({ children, name = '', onOpenNote }: { children: string; name?: string; onOpenNote?: (name: string) => void }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{ a: ({ node: _node, ...props }) => <NoteLink {...props} source={name} onOpenNote={onOpenNote}/> }}>{children}</ReactMarkdown>
}
