import { useEffect, useRef, useState, type ComponentProps } from 'react'
import type { ExtraProps } from 'react-markdown'
import type { PluggableList } from 'unified'
import MDEditor, { commands } from '@uiw/react-md-editor/nohighlight'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import { NoteLink } from './NoteMarkdown'
import '@uiw/react-md-editor/markdown-editor.css'
import '@uiw/react-markdown-preview/markdown.css'

const previewHeadings = Object.fromEntries((['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const).map(Tag => [
  Tag, ({ node, ...props }: ComponentProps<'h1'> & ExtraProps) => <Tag {...props} data-source-start={node?.position?.start.offset}/>,
]))
const editorCommands = [
  [commands.heading, '一级标题'], [commands.heading2, '二级标题'],
  [commands.bold, '加粗'], [commands.italic, '斜体'], [commands.strikethrough, '删除线'],
  [commands.divider, ''],
  [commands.unorderedListCommand, '无序列表'], [commands.orderedListCommand, '有序列表'], [commands.checkedListCommand, '任务列表'], [commands.quote, '引用'],
  [commands.divider, ''],
  [commands.link, '链接'], [commands.image, '图片'], [commands.table, '表格'], [commands.code, '行内代码'], [commands.codeBlock, '代码块'], [commands.hr, '分隔线'],
] as const
const toolbarCommands = editorCommands.map(([command, label]) => label ? {
  ...command, buttonProps: { ...command.buttonProps, title: label, 'aria-label': label },
  ...(command === commands.heading ? { icon: <span className="heading-command">H₁</span> } : {}),
  ...(command === commands.heading2 ? { icon: <span className="heading-command">H₂</span> } : {}),
  ...(command === commands.hr ? { icon: <span className="heading-command">—</span> } : {}),
} : command)
const noExtraCommands: typeof toolbarCommands = []

/** The full editor UI is supplied by uiw; persistence and AI selections stay app-owned. */
export function CodeEditor({ value, onChange, onSelection, onSave, theme, name, onOpenNote, preview = 'edit' }: {
  value: string; onChange: (value: string) => void; onSelection?: (from: number, to: number) => void
  onSave?: () => void; theme: 'light' | 'dark'; name: string; onOpenNote: (name: string) => void
  preview?: 'edit' | 'live'
}) {
  const host = useRef<HTMLDivElement>(null)
  const [highlight, setHighlight] = useState<typeof import('rehype-prism-plus')['default'] | null>(null)
  const [highlightError, setHighlightError] = useState(false)
  useEffect(() => {
    if (preview !== 'live' || highlight || !host.current?.querySelector('pre code')) return
    let active = true
    setHighlightError(false)
    // Keep every supported language, but load its rules only when the preview has code blocks.
    void import('rehype-prism-plus').then(module => { if (active) setHighlight(() => module.default) })
      .catch(() => { if (active) setHighlightError(true) })
    return () => { active = false }
  }, [preview, highlight, value])
  const previewPlugins: PluggableList = [rehypeRaw, rehypeSanitize]
  if (highlight) previewPlugins.push([highlight, { ignoreMissing: true }])
  return <div ref={host} className="markdown-editor" data-color-mode={theme}>
    <MDEditor value={value} onChange={next => onChange(next ?? '')} height="100%" minHeight={0}
      preview={preview} visibleDragbar={false} highlightEnable={false} enableScroll={false} commands={toolbarCommands} extraCommands={noExtraCommands}
      previewOptions={{ rehypePlugins: previewPlugins, components: { ...previewHeadings, a: ({ node: _node, ...props }) => <NoteLink {...props} source={name} onOpenNote={onOpenNote}/> } }} textareaProps={{
        'aria-label': 'Markdown 正文', placeholder: '开始写作，支持 Markdown…',
        onSelect: event => {
          // Native textareas collapse CRLF to LF. Map selection back to the unchanged file source.
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
    {preview === 'live' && highlightError && <div className="banner" role="status">代码着色加载失败，正文和预览仍可使用。保存后刷新页面可重试。</div>}
  </div>
}
