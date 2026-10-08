import { useEffect, useId, useRef, useState } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, placeholder as editorPlaceholder } from '@codemirror/view'
import { markdown } from '@codemirror/lang-markdown'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { autocompletion } from '@codemirror/autocomplete'
import { formatSelection, slashCompletions, type InlineFormat } from './editor-commands'
import { Button } from './ui'

export function CodeEditor({ value, onChange, onSelection, onSave, reveal, placeholder = '开始写作，支持 Markdown…' }: {
  value: string; onChange: (value: string) => void; onSelection?: (from: number, to: number) => void; onSave?: () => void; reveal?: { offset: number; request: number } | null; placeholder?: string
}) {
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<EditorView | null>(null)
  const [selected, setSelected] = useState(false)
  const hintId = useId()
  function format(kind: InlineFormat) {
    const view = editor.current
    if (!view || view.composing) return
    const transaction = formatSelection(view.state, kind)
    if (transaction) { view.dispatch(transaction); view.focus() }
  }
  const callbacks = useRef({ onChange, onSelection, onSave })
  callbacks.current = { onChange, onSelection, onSave }
  useEffect(() => {
    if (!host.current) return
    const view = new EditorView({ parent: host.current, state: EditorState.create({ doc: value, extensions: [
      markdown(), history(), EditorView.lineWrapping, editorPlaceholder(placeholder),
      autocompletion({ override: [slashCompletions], icons: false, activateOnTypingDelay: 100 }),
      EditorView.contentAttributes.of({ 'aria-label': 'Markdown 正文', 'aria-multiline': 'true', 'aria-describedby': hintId }),
      keymap.of([{ key: 'Mod-s', run: () => { callbacks.current.onSave?.(); return true } }, ...(['bold', 'italic', 'link'] as const).map((kind, index) => ({ key: ['Mod-b', 'Mod-i', 'Mod-k'][index], run: (view: EditorView) => {
        if (view.composing) return false
        const transaction = formatSelection(view.state, kind)
        if (!transaction) return false
        view.dispatch(transaction); return true
      } })), ...defaultKeymap, ...historyKeymap]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) callbacks.current.onChange(update.state.doc.toString())
        if (update.selectionSet) { const { from, to } = update.state.selection.main; callbacks.current.onSelection?.(from, to) }
        if (update.selectionSet || update.docChanged) { const { from, to } = update.state.selection.main; setSelected(from !== to && !update.state.sliceDoc(from, to).includes('\n')) }
      }),
      EditorView.theme({ '&': { fontSize: '16px', color: 'var(--foreground)' }, '.cm-content': { fontFamily: 'inherit', lineHeight: '1.9', padding: '8px 0 80px' }, '.cm-line': { padding: '0' }, '&.cm-focused': { outline: 'none' }, '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { background: 'var(--accent-soft)' }, '.cm-cursor': { borderLeftColor: 'var(--foreground)' } }),
    ] }) })
    editor.current = view
    return () => { view.destroy(); editor.current = null }
  }, []) // One editor owns native undo history throughout this note's lifetime.
  useEffect(() => {
    const view = editor.current
    if (view && view.state.doc.toString() !== value) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
  }, [value])
  useEffect(() => {
    const view = editor.current
    if (!view || !reveal) return
    const offset = Math.max(0, Math.min(reveal.offset, view.state.doc.length))
    view.dispatch({ selection: { anchor: offset }, effects: EditorView.scrollIntoView(offset, { y: 'start', yMargin: 24 }) })
    view.focus()
  }, [reveal])
  return <div className="markdown-editor">
    {selected && <div className="editor-tools"><div role="group" aria-label="选中文字的格式">
      <Button size="sm" variant="ghost" aria-label="加粗，Command 或 Control B" onPress={() => format('bold')}><strong>B</strong></Button>
      <Button size="sm" variant="ghost" aria-label="斜体，Command 或 Control I" onPress={() => format('italic')}><em>I</em></Button>
      <Button size="sm" variant="ghost" aria-label="行内代码" onPress={() => format('code')}><span aria-hidden="true">&lt;/&gt;</span></Button>
      <Button size="sm" variant="ghost" aria-label="添加链接，Command 或 Control K" onPress={() => format('link')}>链接</Button>
    </div></div>}
    <div ref={host} className="editor-surface" />
    <p id={hintId} className="editor-hint">在新行输入 / 插入内容；方向键选择，Enter 插入，Esc 关闭。</p>
  </div>
}
