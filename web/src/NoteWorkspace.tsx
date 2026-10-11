import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { api } from './api'
import { useNote } from './useNote'
import { CodeEditor } from './CodeEditor'
import { outlineHeadings, richEditingIssue } from './outline'
import { RichEditor, type RichEditorHandle, type RichSelection } from './RichEditor'
import { ModificationPreview } from './ModificationPreview'
import { Button, Icon, IconButton, TextArea, SegmentedControl } from './ui'

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

type Proposal = { model: string | null; original: string; replacement: string; from: number; to: number; base: string; richSelection: RichSelection | null }
export function NoteWorkspace({ name, beforeLeave, onUpdated, onConfigureAI, aiModel, theme, onOpenNote, onBack }: {
  name: string; onOpenNote: (name: string) => void; onBack: () => void; beforeLeave: MutableRefObject<() => Promise<boolean>>
  onUpdated: () => void; onConfigureAI: () => void; aiModel: string | null; theme: 'light' | 'dark'
}) {
  const { note, draft, setDraft, status, error, save: saveDraft, replace, undo, undoCount, reload } = useNote(name)
  const [mode, setMode] = useState<'edit' | 'source'>('edit')
  const [editorError, setEditorError] = useState('')
  const richEditor = useRef<RichEditorHandle>(null)
  const [richSelection, setRichSelection] = useState<RichSelection | null>(null)
  const issue = useMemo(() => richEditingIssue(draft), [draft])
  const sourceMode = mode === 'source' || !!issue || !!editorError
  useEffect(() => { if (issue || editorError) setMode('source') }, [issue, editorError])
  const save = useCallback(async () => {
    if (note && !sourceMode && !richEditor.current?.flush()) return false
    return saveDraft()
  }, [note, sourceMode, saveDraft])
  const [aiOpen, setAiOpen] = useState(false)
  const [outlineOpen, setOutlineOpen] = useState(false)
  const outlineToggle = useRef<HTMLButtonElement>(null)
  const workspace = useRef<HTMLDivElement>(null)
  const positions = useRef({
    editor: null as { start: number; end: number; direction: HTMLTextAreaElement['selectionDirection']; top: number; left: number; width: number; caretTop: number } | null,
  })
  const headings = useMemo(() => outlineHeadings(draft), [draft])
  const [selection, setSelection] = useState({ from: 0, to: 0 })
  const [instruction, setInstruction] = useState('')
  const [proposal, setProposal] = useState<Proposal | null>(null)
  const [aiBusy, setAiBusy] = useState(false)
  const [aiError, setAiError] = useState('')
  const aiRequest = useRef<AbortController | null>(null)
  const latestDraft = useRef(draft)
  latestDraft.current = draft
  useEffect(() => () => aiRequest.current?.abort(), [])
  useEffect(() => { beforeLeave.current = save; return () => { beforeLeave.current = async () => true } }, [beforeLeave, save])
  useEffect(() => {
    if (outlineOpen) document.querySelector<HTMLButtonElement>('#editor-outline button[aria-label^="定位到："]')?.focus()
  }, [outlineOpen])
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!event.isComposing && event.key === 'Escape' && outlineOpen) { event.preventDefault(); setOutlineOpen(false); outlineToggle.current?.focus() }
      if (!event.defaultPrevented && !event.isComposing && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save() }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [save, outlineOpen])
  useLayoutEffect(() => {
    const editor = workspace.current?.querySelector<HTMLTextAreaElement>('textarea[aria-label="Markdown 正文"]'), saved = positions.current.editor
    if (editor && saved) {
      editor.focus({ preventScroll: true }); editor.setSelectionRange(saved.start, saved.end, saved.direction)
      editor.scrollTop = saved.top + (editor.clientWidth === saved.width ? 0 : editorOffsetTop(editor, editor.selectionStart) - saved.caretTop)
      editor.scrollLeft = saved.left
    }
  }, [sourceMode])
  if (!note) return <div className="empty">{error ?? '正在打开文章…'}</div>
  const changeMode = (next: typeof mode) => {
    if (next === 'edit' && (issue || editorError)) return
    if (next === mode || (!sourceMode && !richEditor.current?.flush())) return
    const editor = workspace.current?.querySelector<HTMLTextAreaElement>('textarea[aria-label="Markdown 正文"]')
    if (editor) positions.current.editor = { start: editor.selectionStart, end: editor.selectionEnd, direction: editor.selectionDirection, top: editor.scrollTop, left: editor.scrollLeft, width: editor.clientWidth, caretTop: editorOffsetTop(editor, editor.selectionStart) }
    aiRequest.current?.abort()
    setMode(next); setOutlineOpen(false); setProposal(null); setRichSelection(null); setSelection({ from: 0, to: 0 })
  }
  const title = /^#\s+(.+)$/m.exec(draft)?.[1]?.trim() ?? name.split('/').at(-1)?.replace(/\.md$/, '')
  const context = selection.to > selection.from ? selection : { from: 0, to: draft.length }
  const contextLabel = (!sourceMode && richSelection) || (sourceMode && selection.to > selection.from) ? '已选择的文字' : '当前整篇文章'
  const ask = async () => {
    if (!instruction.trim() || aiBusy || !draft.trim()) return
    if (!sourceMode && !richEditor.current?.flush()) return
    const selectedRich = sourceMode ? null : richSelection
    const snapshot = latestDraft.current
    const source = selectedRich ? selectedRich.text : sourceMode ? snapshot.slice(context.from, context.to) : snapshot
    const controller = new AbortController()
    aiRequest.current = controller
    setAiBusy(true); setAiError(''); setProposal(null)
    try {
      const { replacement } = await api.proposeEdit(source, instruction.trim(), controller.signal)
      if (!controller.signal.aborted) setProposal({ model: aiModel, original: source, replacement, ...(sourceMode ? context : { from: 0, to: snapshot.length }), base: snapshot, richSelection: selectedRich })
    } catch (error) { if (!controller.signal.aborted) setAiError((error as Error).message) }
    finally { if (aiRequest.current === controller) { aiRequest.current = null; setAiBusy(false) } }
  }
  const applyProposal = async () => {
    if (!proposal) return
    if (!sourceMode && !richEditor.current?.flush()) return
    if (latestDraft.current !== proposal.base) { setAiError('文章已发生变化，请重新生成建议后再应用。'); return }
    const content = proposal.richSelection ? proposal.richSelection.apply(proposal.replacement) : proposal.base.slice(0, proposal.from) + proposal.replacement + proposal.base.slice(proposal.to)
    if (content === null) { setAiError('文章已发生变化，请重新生成建议后再应用。'); return }
    if (await replace(content)) { setProposal(null); setInstruction(''); setSelection({ from: 0, to: 0 }); setRichSelection(null); onUpdated() }
  }
  const revealHeading = (index: number) => {
    if (sourceMode) {
      const editor = workspace.current?.querySelector<HTMLTextAreaElement>('textarea[aria-label="Markdown 正文"]')
      if (!editor) return
      const offset = draft.slice(0, headings[index]!.start).replace(/\r\n/g, '\n').length
      editor.focus({ preventScroll: true }); editor.setSelectionRange(offset, offset); editor.scrollTop = editorOffsetTop(editor, offset)
      setSelection({ from: headings[index]!.start, to: headings[index]!.start })
      return
    }
    richEditor.current?.revealHeading(index)
  }
  return <>
    <header className="topbar editor-topbar">
      <div className="breadcrumb"><Button size="sm" variant="ghost" onPress={onBack}><Icon name="grid" size={16}/>返回画布</Button><span className="editor-folder">/ {note.space || '笔记文件夹'}</span><span className="editor-title" title={title}>{title}</span></div>
      <div className="toolbar">
        <SegmentedControl label="文章编辑方式" value={sourceMode ? 'source' : 'edit'} onValueChange={value => changeMode(value as typeof mode)} options={[{ value: 'edit', label: '写作' }, { value: 'source', label: '源码' }]}/>
        <Button ref={outlineToggle} variant="ghost" size="sm" aria-expanded={outlineOpen} aria-controls="editor-outline" onPress={() => { setOutlineOpen(!outlineOpen); setAiOpen(false) }}>目录</Button>
        <Button size="sm" variant="ghost" aria-pressed={aiOpen} onPress={() => { setAiOpen(!aiOpen); setOutlineOpen(false) }}><Icon name="spark"/>AI 助手</Button>
      </div>
    </header>
    <div ref={workspace} className="workspace-body">
      <section className="note-stage">
        {error && <div className="inline-error" role="alert">{error}{status === 'conflict' && <Button size="sm" variant="ghost" onPress={() => void reload()}>放弃草稿并重新载入</Button>}</div>}
        {(issue || editorError) && <p className="editor-format-note" role="status">{issue || editorError}</p>}
        <div className="editor-workspace">
          <div className={'editor-scroll' + (sourceMode ? ' is-source' : '')}>
          {sourceMode ? <CodeEditor theme={theme} value={draft} onChange={setDraft} onSelection={(from, to) => setSelection({ from, to })} onSave={() => void save()}/> : <RichEditor editorRef={richEditor} name={name} value={draft} onChange={value => { latestDraft.current = value; setDraft(value) }} onSelection={setRichSelection} onOpenNote={onOpenNote} onError={() => setEditorError('写作编辑器未能载入，正文已保留，可继续使用源码编辑。')}/>}
          </div>
          <aside id="editor-outline" className="document-outline editor-outline" hidden={!outlineOpen} aria-label="本文目录"><div className="section-header"><span className="section-label">本文目录</span><Button variant="ghost" size="sm" isIconOnly aria-label="关闭目录" onPress={() => { setOutlineOpen(false); outlineToggle.current?.focus() }}><Icon name="close"/></Button></div>{headings.map((heading, index) => <Button variant="ghost" size="sm" key={heading.start} aria-label={'定位到：' + heading.title} className={heading.depth > 1 ? 'outline-subheading' : ''} onPress={() => revealHeading(index)}>{heading.title}</Button>)}{!headings.length && <p className="muted outline-empty">添加标题后，可在这里快速定位。</p>}</aside>
        </div>
        <footer className="editor-statusbar">
          <span className="save-status" role="status"><Icon name={status === 'saved' ? 'check' : 'clock'} size={13}/>{status === 'saved' ? '已保存' : status === 'saving' ? '正在保存…' : status === 'conflict' ? '需要处理修改冲突' : '未保存'}</span>
          <div className="toolbar"><IconButton icon="undo" label="撤销上次保存" isDisabled={undoCount === 0} onPress={() => { void save().then(saved => { if (saved) void undo() }) }}/><Button variant="ghost" size="sm" onPress={() => void save()} isDisabled={status === 'saved' || status === 'saving'}>保存</Button></div>
        </footer>
      </section>
      {aiOpen && <aside className="ai-panel"><div className="section-header"><strong><Icon name="spark"/>AI 助手</strong><IconButton icon="close" label="关闭 AI 助手" onPress={() => setAiOpen(false)}/></div><div className="context-pill"><Icon name="note" size={14}/>{contextLabel}</div><p className="muted">只发送上述内容。修改先预览，再由你决定是否应用。</p><Button variant="ghost" size="sm" onPress={onConfigureAI}><Icon name="settings" size={14}/>{aiModel || '连接 ChatGPT 或其他模型'}</Button>{aiBusy && <div className="section-header"><p role="status">正在准备修改建议…</p><Button variant="ghost" size="sm" onPress={() => { aiRequest.current?.abort(); setAiError('已停止生成，正文未更改。') }}>停止生成</Button></div>}{aiError && <p className="error-text" role="alert">{aiError}</p>}{proposal && <div className="ai-result"><strong>修改已准备好</strong><span className="muted">{proposal.model || '模型服务'}</span><ModificationPreview compact original={proposal.original} replacement={proposal.replacement} onDiscard={() => setProposal(null)} onApply={() => void applyProposal()}/><p className="muted">应用后可撤销。正文变化后需重新生成。</p></div>}<div className="ai-composer"><TextArea aria-label="修改要求" value={instruction} onChange={event => setInstruction(event.target.value)} placeholder="让这段文字更自然，保留原意…" rows={3}/><div className="toolbar"><span className="muted">{aiModel ? '由你决定是否写入' : '请先连接模型'}</span><Button isIconOnly size="sm" aria-label="生成修改建议" onPress={() => void ask()} isDisabled={!aiModel || aiBusy || !instruction.trim()}><Icon name="send"/></Button></div></div></aside>}
    </div>
  </>
}
