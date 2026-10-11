import MDEditor from '@uiw/react-md-editor/nohighlight'
import '@uiw/react-md-editor/markdown-editor.css'

/** A secondary, lossless source view for Markdown extensions and exact syntax edits. */
export function CodeEditor({ value, onChange, onSelection, onSave, theme }: {
  value: string; onChange: (value: string) => void; onSelection?: (from: number, to: number) => void
  onSave?: () => void; theme: 'light' | 'dark'
}) {
  return <div className="markdown-editor" data-color-mode={theme}>
    <MDEditor value={value} onChange={next => onChange(next ?? '')} height="100%" minHeight={0}
      preview="edit" hideToolbar visibleDragbar={false} highlightEnable={false} enableScroll={false} textareaProps={{
        'aria-label': 'Markdown 正文', placeholder: 'Markdown 源码…',
        onSelect: event => {
          // Native textareas collapse CRLF to LF. Map selection to the unchanged file.
          const sourceOffset = (offset: number) => {
            let source = 0, rendered = 0
            while (source < value.length && rendered < offset) { if (value[source] === '\r' && value[source + 1] === '\n') source++; source++; rendered++ }
            return source
          }
          onSelection?.(sourceOffset(event.currentTarget.selectionStart), sourceOffset(event.currentTarget.selectionEnd))
        },
        onKeyDown: event => {
          if (!event.nativeEvent.isComposing && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopPropagation(); onSave?.() }
        },
      }}/>
  </div>
}
