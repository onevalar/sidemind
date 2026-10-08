import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { linkedNoteName } from './note-links'

export function NoteMarkdown({ children, onOpenNote }: { children: string; onOpenNote?: (name: string) => void }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
    a: ({ node: _node, href, children, ...props }) => <a {...props} className={['nodrag', 'nopan', props.className].filter(Boolean).join(' ')} href={href} onClick={event => {
      const name = href ? linkedNoteName(href) : null
      if (name && onOpenNote && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
        event.preventDefault(); event.stopPropagation(); onOpenNote(name)
      }
    }}>{children}</a>,
  }}>{children}</ReactMarkdown>
}
