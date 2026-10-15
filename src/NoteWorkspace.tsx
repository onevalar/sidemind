import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { useNote } from './useNote'
import { CodeEditor } from './CodeEditor'
import { outlineHeadings, richEditingIssue } from './outline'
import { RichEditor, type RichEditorHandle, type RichSelection } from './RichEditor'
import { Button, DropdownMenu, Icon, SegmentedControl } from './ui'
import { Dialog as ArcDialog, DialogContent } from './components/arc/dialog/dialog'
import { NoteMarkdown } from './NoteMarkdown'
import { richSelectionSource } from './rich-selection'
import './editor-workspace.css'
import { MemoryDialog } from './MemoryDialog'
import { findTextRange } from './reveal'
import { composing } from './ime'

// Measure wrapped source text, both for directory jumps and changing column widths.
function editorOffsetTop(editor: HTMLTextAreaElement, offset: number) {
  const style = getComputedStyle(editor), mirror = document.createElement('div'), marker = document.createElement('span')
  for (const property of ['font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'padding', 'white-space', 'word-break', 'overflow-wrap', 'tab-size', 'box-sizing']) {
    mirror.style.setProperty(property, style.getPropertyValue(property))
  }
  Object.assign(mirror.style, { position: 'absolute', visibility: 'hidden', width: editor.clientWidth + 'px' })
  mirror.textContent = editor.value.slice(0, offset); marker.textContent = '\u200b'; mirror.append(marker)
  document.body.append(mirror)
  const top = marker.getBoundingClientRect().top - mirror.getBoundingClientRect().top - parseFloat(style.paddingTop || '0')
  mirror.remove()
  return top
}

export function NoteWorkspace({ name, beforeLeave, agentSelection, reveal, aiOpen, onToggleAI, theme, onOpenNote, onBack, onExplore }: {
  name: string; onOpenNote: (name: string) => void; onBack: () => void; beforeLeave: MutableRefObject<() => Promise<boolean>>
  onExplore?: (quote: string) => void; agentSelection?: MutableRefObject<() => string | undefined>; reveal?: MutableRefObject<(quote: string, start: number | null) => boolean>; aiOpen?: boolean; onToggleAI?: () => void; theme: 'light' | 'dark'
}) {
  const { note, draft, setDraft, status, error, save: saveDraft, undo, undoCount, reload } = useNote(name)
  const [mode, setMode] = useState<'read' | 'edit' | 'source'>('edit')
  const [editorError, setEditorError] = useState('')
  const richEditor = useRef<RichEditorHandle>(null)
  const [richSelection, setRichSelection] = useState<RichSelection | null>(null)
  const issue = useMemo(() => richEditingIssue(draft), [draft])
  const sourceMode = mode === 'source' || (mode === 'edit' && (!!issue || !!editorError))
  const reading = mode === 'read'
  useEffect(() => { if (mode === 'edit' && (issue || editorError)) setMode('source') }, [mode, issue, editorError])
  const save = useCallback(async () => {
    if (note && !sourceMode && !reading && !richEditor.current?.flush()) return false
    return saveDraft()
  }, [note, sourceMode, reading, saveDraft])
  const [outlineOpen, setOutlineOpen] = useState(false)
  const outlineToggle = useRef<HTMLButtonElement>(null)
  const pendingHeading = useRef<number | null>(null)
  const scrollPositions = useRef({ read: 0, edit: 0, source: 0 })
  const [readSelection, setReadSelection] = useState('')
  const [memoryOpen, setMemoryOpen] = useState(false)
  const workspace = useRef<HTMLDivElement>(null)
  const positions = useRef({
    editor: null as { start: number; end: number; direction: HTMLTextAreaElement['selectionDirection']; top: number; left: number; width: number; caretTop: number } | null,
  })
  const headings = useMemo(() => outlineHeadings(draft), [draft])
  const [selection, setSelection] = useState({ from: 0, to: 0 })
  const latestDraft = useRef(draft)
  latestDraft.current = draft
  const selectedText = reading ? readSelection : sourceMode ? draft.slice(selection.from, selection.to) : richSelection?.text
  useEffect(() => {
    if (!agentSelection) return
    agentSelection.current = () => reading ? readSelection || undefined : sourceMode ? selection.to > selection.from ? latestDraft.current.slice(selection.from, selection.to) : undefined : richSelection?.text
    return () => { agentSelection.current = () => undefined }
  }, [agentSelection, reading, readSelection, sourceMode, selection, richSelection])
  useEffect(() => { beforeLeave.current = save; return () => { beforeLeave.current = async () => true } }, [beforeLeave, save])
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!event.defaultPrevented && !composing(event) && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save() }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [save])
  useLayoutEffect(() => {
    const scroll = workspace.current?.querySelector('.editor-scroll')
    if (scroll) scroll.scrollTop = scrollPositions.current[mode]
    const editor = workspace.current?.querySelector<HTMLTextAreaElement>('textarea[aria-label="Markdown 正文"]'), saved = positions.current.editor
    if (editor && saved) {
      editor.focus({ preventScroll: true }); editor.setSelectionRange(saved.start, saved.end, saved.direction)
      editor.scrollTop = saved.top + (editor.clientWidth === saved.width ? 0 : editorOffsetTop(editor, editor.selectionStart) - saved.caretTop)
      editor.scrollLeft = saved.left
    }
  }, [sourceMode, mode])
  // Scroll to and highlight a saved passage, in whichever editor is showing. False means it could not be found.
  useEffect(() => {
    if (!reveal) return
    reveal.current = (quote, start) => {
      if (sourceMode) {
        const editor = workspace.current?.querySelector<HTMLTextAreaElement>('textarea[aria-label="Markdown 正文"]')
        const at = start !== null && draft.startsWith(quote, start) ? start : draft.indexOf(quote)
        if (!editor || at < 0) return false
        const flat = (offset: number) => draft.slice(0, offset).replace(/\r\n/g, '\n').length
        editor.focus({ preventScroll: true }); editor.setSelectionRange(flat(at), flat(at + quote.length))
        editor.scrollTop = Math.max(0, editorOffsetTop(editor, flat(at)) - editor.clientHeight / 3)
        return true
      }
      const root = workspace.current?.querySelector(reading ? '.note-reading' : '.ProseMirror')
      const range = root ? findTextRange(root, quote) : null
      if (!range) return false
      range.startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
      const marker = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights, Highlight = (globalThis as { Highlight?: new (range: Range) => unknown }).Highlight
      if (marker && Highlight) { marker.set('explore-source', new Highlight(range)); setTimeout(() => marker.delete('explore-source'), 5000) }
      else { const selected = getSelection(); selected?.removeAllRanges(); selected?.addRange(range) }
      return true
    }
    return () => { reveal.current = () => false }
  }, [reveal, sourceMode, reading, draft])
  if (!note) return <div className="empty">{error ?? '正在打开文章…'}</div>
  const changeMode = (next: typeof mode) => {
    if (next === 'edit' && (issue || editorError)) return
    if (next === mode || (!sourceMode && !reading && !richEditor.current?.flush())) return
    scrollPositions.current[mode] = workspace.current?.querySelector('.editor-scroll')?.scrollTop ?? 0
    const editor = workspace.current?.querySelector<HTMLTextAreaElement>('textarea[aria-label="Markdown 正文"]')
    if (editor) positions.current.editor = { start: editor.selectionStart, end: editor.selectionEnd, direction: editor.selectionDirection, top: editor.scrollTop, left: editor.scrollLeft, width: editor.clientWidth, caretTop: editorOffsetTop(editor, editor.selectionStart) }
    setMode(next); setOutlineOpen(false); setRichSelection(null); setReadSelection(''); setSelection({ from: 0, to: 0 })
  }
  const title = /^#\s+(.+)$/m.exec(draft)?.[1]?.trim() ?? name.split('/').at(-1)?.replace(/\.md$/, '')
  const revealHeading = (index: number) => {
    if (!headings[index]) return
    if (sourceMode) {
      const editor = workspace.current?.querySelector<HTMLTextAreaElement>('textarea[aria-label="Markdown 正文"]')
      if (!editor) return
      const offset = draft.slice(0, headings[index]!.start).replace(/\r\n/g, '\n').length
      editor.focus({ preventScroll: true }); editor.setSelectionRange(offset, offset); editor.scrollTop = editorOffsetTop(editor, offset)
      setSelection({ from: headings[index]!.start, to: headings[index]!.start })
      return
    }
    if (reading) {
      const heading = workspace.current?.querySelectorAll<HTMLElement>('.note-reading :is(h1,h2,h3,h4,h5,h6)')[index]
      if (heading) { heading.tabIndex = -1; heading.scrollIntoView({ block: 'start' }); heading.focus({ preventScroll: true }) }
      return
    }
    richEditor.current?.revealHeading(index)
  }
  const captureReadSelection = () => {
    const selected = getSelection(), root = workspace.current?.querySelector('.note-reading')
    const text = selected && root?.contains(selected.anchorNode) && root.contains(selected.focusNode) ? selected.toString() : ''
    setReadSelection(richSelectionSource(draft, text) ?? text)
  }
  const exploreSelection = () => {
    const quote = selectedText
    if (!quote?.trim() || (!reading && !sourceMode && !richEditor.current?.flush())) return
    onExplore?.(quote)
  }
  return <>
    <header className="topbar editor-topbar note-workspace-header">
      <div className="breadcrumb">
        <Button size="sm" variant="ghost" aria-label="返回画布" onPress={onBack}><Icon name="grid" size={16}/><span className="editor-back-label">画布</span></Button>
        <div className="editor-location"><span className="editor-folder">{note.space || '笔记文件夹'}</span><span className="editor-title" title={title}>{title}</span></div>
      </div>
      <div className="toolbar editor-actions">
        <Button ref={outlineToggle} variant="ghost" size="sm" aria-expanded={outlineOpen} aria-haspopup="dialog" onPress={() => setOutlineOpen(true)}>目录</Button>
        <Button size="sm" variant={aiOpen ? 'secondary' : 'ghost'} className="ai-toggle" aria-pressed={aiOpen} aria-controls="ai-assistant-pane" title={aiOpen ? '关闭 AI 助手' : '打开 AI 助手'} onPress={onToggleAI}><Icon name="spark"/><span className="editor-ai-label">AI 助手</span></Button>
        <DropdownMenu label="文章更多操作" trigger={<Button variant="ghost" size="sm" isIconOnly aria-label="文章更多操作"><Icon name="more"/></Button>} items={[
          { label: '文章记忆', icon: <Icon name="spark"/>, onSelect: () => setMemoryOpen(true) },
          { label: '撤销上次保存', icon: <Icon name="undo"/>, disabled: undoCount === 0, separatorBefore: true, onSelect: () => { void save().then(saved => { if (saved) void undo() }) } },
        ]}/>
      </div>
    </header>
    <div ref={workspace} className="workspace-body note-workspace-body">
      <section className="note-stage">
        <div className="editor-modebar">
          <SegmentedControl label="文章编辑方式" value={sourceMode ? 'source' : mode} onValueChange={value => changeMode(value as typeof mode)} options={[{ value: 'read', label: '阅读' }, { value: 'edit', label: '写作' }, { value: 'source', label: '源码' }]}/>
          <span className="editor-mode-hint">{reading ? '选中文字，继续探索' : sourceMode ? 'Markdown 源码' : '修改自动保存'}</span>
        </div>
        {error && <div className="inline-error" role="alert">{error}{status === 'conflict' && <Button size="sm" variant="ghost" onPress={() => void reload()}>放弃草稿并重新载入</Button>}</div>}
        {(issue || editorError) && <p className="editor-format-note" role="status">{reading ? '阅读预览可能隐藏 Markdown 扩展；完整原文保留在源码中。' : issue || editorError}</p>}
        <div className="editor-workspace">
          <div className={'editor-scroll' + (sourceMode ? ' is-source' : '')}>
          {reading ? <article className="note-reading prose" tabIndex={0} aria-label="文章阅读预览" onMouseUp={captureReadSelection} onTouchEnd={captureReadSelection} onKeyUp={captureReadSelection}>
            <NoteMarkdown name={name} onOpenNote={onOpenNote}>{draft || '这篇文章还没有正文。切换到写作开始记录。'}</NoteMarkdown>
          </article> : sourceMode ? <CodeEditor theme={theme} value={draft} onChange={setDraft} onSelection={(from, to) => setSelection({ from, to })} onSave={() => void save()}/> : <RichEditor editorRef={richEditor} name={name} value={draft} onChange={value => { latestDraft.current = value; setDraft(value) }} onSelection={setRichSelection} onOpenNote={onOpenNote} onError={() => setEditorError('写作编辑器未能载入，正文已保留，可继续使用源码编辑。')}/>}
          </div>
        </div>
        {onExplore && selectedText?.trim() && <div className="editor-selection-context" role="region" aria-label="选区探索">
          <div className="editor-selection-summary"><span className="muted">已选择 {Array.from(selectedText).length} 字</span><span className="editor-selection-quote">{selectedText}</span></div>
          <Button variant="secondary" size="sm" onPress={exploreSelection}><Icon name="spark" size={16}/>探索选区</Button>
        </div>}
        <footer className="editor-statusbar note-workspace-status">
          <span className="save-status" role="status" aria-label="保存状态"><Icon name={status === 'saved' ? 'check' : 'clock'} size={13}/>{status === 'saved' ? '已保存' : status === 'saving' ? '正在保存…' : status === 'conflict' ? '需要处理修改冲突' : '未保存'}</span>
          <span className="editor-document-length">{Array.from(draft.replace(/\s/g, '')).length.toLocaleString()} 字符</span>
          {status !== 'saved' && <Button variant="ghost" size="sm" onPress={() => void save()} isDisabled={status === 'saving'}>保存</Button>}
        </footer>
      </section>
    </div>
    <ArcDialog open={outlineOpen} onOpenChange={setOutlineOpen}>
      <DialogContent title="本文目录" aria-describedby={undefined} className="editor-outline-dialog" onEscapeKeyDown={event => { if (composing(event)) event.preventDefault() }} onOpenAutoFocus={event => { const first = document.querySelector<HTMLButtonElement>('.editor-heading-list button'); if (first) { event.preventDefault(); first.focus() } }} onCloseAutoFocus={event => {
        event.preventDefault()
        if (pendingHeading.current !== null) { const index = pendingHeading.current; pendingHeading.current = null; revealHeading(index) }
        else outlineToggle.current?.focus({ preventScroll: true })
      }}>
        <nav className="editor-heading-list" aria-label="文章章节">{headings.map((heading, index) => <Button variant="ghost" size="sm" key={heading.start} aria-label={'定位到：' + heading.title} style={{ marginInlineStart: Math.min(heading.depth - 1, 3) * 12 }} onPress={() => { pendingHeading.current = index; setOutlineOpen(false) }}>{heading.title}</Button>)}</nav>
        {!headings.length && <p className="muted">添加标题后，可在这里快速定位。</p>}
      </DialogContent>
    </ArcDialog>
    <MemoryDialog target="note" name={name} title={'文章记忆 · ' + title} open={memoryOpen} onClose={() => setMemoryOpen(false)}/>
  </>
}
