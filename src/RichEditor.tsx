import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { Crepe } from '@milkdown/crepe'
import { editorViewCtx } from '@milkdown/kit/core'
import { Plugin, TextSelection } from '@milkdown/kit/prose/state'
import { $prose, replaceAll, replaceRange } from '@milkdown/kit/utils'
import { linkedNoteName } from './note-links'
import { richSelectionSource } from './rich-selection'
import '@milkdown/crepe/theme/common/style.css'
import '@milkdown/crepe/theme/classic.css'

export type RichSelection = { text: string; apply: (replacement: string) => string | null }
export type RichEditorHandle = { flush: () => boolean; revealHeading: (index: number) => void }

/** Crepe owns editing, input rules and history. This adapter owns only app integration. */
export function RichEditor({ value, onChange, onSelection, name, onOpenNote, editorRef, onError }: {
  value: string; onChange: (markdown: string) => void; onSelection: (selection: RichSelection | null) => void
  name: string; onOpenNote: (name: string) => void; editorRef: Ref<RichEditorHandle>; onError: () => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const sync = useRef<((markdown: string) => void) | null>(null)
  const actions = useRef<RichEditorHandle | null>(null)
  const latest = useRef({ value, onChange, onSelection, onOpenNote, onError })
  latest.current = { value, onChange, onSelection, onOpenNote, onError }
  const accepted = useRef(value)
  const [loading, setLoading] = useState(true)
  useImperativeHandle(editorRef, () => ({
    flush: () => actions.current?.flush() ?? false,
    revealHeading: index => actions.current?.revealHeading(index),
  }), [])

  useEffect(() => {
    const root = document.createElement('div')
    host.current!.append(root)
    let active = true, ready = false, baseline = '', applying = false
    const initial = latest.current.value
    const eol = initial.includes('\r\n') ? '\r\n' : '\n'
    const source = (markdown: string) => markdown.replace(/\r\n/g, '\n').replace(/\n/g, eol)
    const crepe = new Crepe({
      root, defaultValue: initial,
      features: {
        [Crepe.Feature.Toolbar]: false, [Crepe.Feature.TopBar]: false,
        [Crepe.Feature.BlockEdit]: false, [Crepe.Feature.AI]: false,
        [Crepe.Feature.Latex]: false, [Crepe.Feature.ImageBlock]: false,
      },
      featureConfigs: {
        [Crepe.Feature.Placeholder]: { text: '开始写作，输入 # 和空格创建标题…' },
        [Crepe.Feature.CodeMirror]: { searchPlaceholder: '搜索语言', noResultText: '没有匹配的语言', copyText: '复制' },
        [Crepe.Feature.LinkTooltip]: { inputPlaceholder: '输入链接地址' },
      },
    })
    const flush = () => {
      if (!active || !ready) return false
      const view = crepe.editor.ctx.get(editorViewCtx)
      if (view.composing) return false
      const markdown = crepe.getMarkdown()
      if (markdown !== baseline) {
        baseline = markdown
        accepted.current = source(markdown)
        latest.current.onChange(accepted.current)
      }
      return true
    }
    crepe.editor.use($prose(() => new Plugin({
      props: {
        attributes: { role: 'textbox', 'aria-label': '文章正文', 'aria-multiline': 'true', spellcheck: 'false' },
        handleDOMEvents: {
          compositionend: () => { setTimeout(() => { if (active) flush() }, 0); return false },
          // Avoid ephemeral blob uploads: attachments are not managed by this app yet.
          drop: (_view, event) => { if (event.dataTransfer?.files.length) { event.preventDefault(); return true } return false },
          paste: (_view, event) => { if (event.clipboardData?.files.length) { event.preventDefault(); return true } return false },
        },
      },
      view: () => ({ update: (view, previous) => {
        if (!active || !ready || applying || view.composing) return
        flush()
        if (view.state.doc.eq(previous.doc) && view.state.selection.eq(previous.selection)) return
        const { doc, selection } = view.state
        if (selection.empty) { latest.current.onSelection(null); return }
        const { from, to } = selection
        const visible = doc.textBetween(from, to, '\n', '\n')
        const text = richSelectionSource(accepted.current, visible) ?? source(visible)
        latest.current.onSelection({ text, apply: replacement => {
          if (!active || !ready || !view.state.doc.eq(doc)) return null
          applying = true
          try {
            crepe.editor.action(replaceRange(replacement, { from, to }))
            baseline = crepe.getMarkdown()
            accepted.current = source(baseline)
            return accepted.current
          } finally { applying = false }
        } })
      } }),
    })))
    const creation = crepe.create()
    void creation.then(() => {
      if (!active) return
      baseline = crepe.getMarkdown()
      accepted.current = initial
      ready = true
      sync.current = markdown => {
        applying = true
        try {
          crepe.editor.action(replaceAll(markdown, true))
          baseline = crepe.getMarkdown()
          accepted.current = markdown
          latest.current.onSelection(null)
        } finally { applying = false }
      }
      actions.current = { flush, revealHeading: index => {
        const view = crepe.editor.ctx.get(editorViewCtx)
        const positions: number[] = []
        view.state.doc.descendants((node, pos) => { if (node.type.name === 'heading') positions.push(pos) })
        const pos = positions[index]
        if (pos === undefined) return
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + 1)))
        view.focus()
        const heading = view.nodeDOM(pos)
        if (heading instanceof HTMLElement) heading.scrollIntoView({ block: 'start' })
      } }
      if (latest.current.value !== initial) sync.current(latest.current.value)
      setLoading(false)
    }).catch(error => { console.error('Editor initialization failed', error); if (active) latest.current.onError() })
    return () => {
      active = false; ready = false; actions.current = null; sync.current = null
      root.remove()
      void creation.then(() => crepe.destroy()).catch(() => {})
    }
  }, [name])

  useEffect(() => {
    if (value === accepted.current) return
    // Accepted reload/undo/whole-document AI edits are a new authoritative document.
    sync.current?.(value)
  }, [value])
  return <div className="rich-editor" aria-busy={loading} onClickCapture={event => {
    const link = (event.target as HTMLElement).closest('a[href]')
    // Include Crepe's link popover, which lives outside the editable document.
    if (!link || (link.closest('.ProseMirror') && !(event.ctrlKey || event.metaKey))) return
    event.preventDefault()
    const href = link.getAttribute('href') || ''
    const note = linkedNoteName(href, name)
    if (note) onOpenNote(note)
    else if (/^https?:\/\//i.test(href)) window.open(href, '_blank', 'noopener,noreferrer')
  }}>
    {loading && <p className="editor-loading muted" role="status">正在准备编辑器…</p>}
    <div ref={host}/>
  </div>
}
