
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { NoteMarkdown } from './NoteMarkdown'
import { api } from './api'
import { useNote } from './useNote'
import { NoteCanvas } from './NoteCanvas'
import { CodeEditor } from './CodeEditor'
import { outlineHeadings } from './outline'
import { ModificationPreview } from './ModificationPreview'
import { Button, Dialog, Icon, IconButton, Input, TextArea } from './ui'

type Proposal = { model: string | null; original: string; replacement: string; from: number; to: number; base: string }
export function NoteWorkspace({ name, beforeLeave, onUpdated, onConfigureAI, aiModel, spaces, theme, onOpenNote }: { name: string; onOpenNote: (name: string) => void; beforeLeave: MutableRefObject<() => Promise<boolean>>; onUpdated: () => void; onConfigureAI: () => void; aiModel: string | null; spaces: string[]; theme: 'light' | 'dark' }) {
  const { note, draft, setDraft, status, error, save, replace, undo, undoCount, reload } = useNote(name)
  const [mode, setMode] = useState<'document' | 'canvas'>('document')
  const [editing, setEditing] = useState(false)
  const [reveal, setReveal] = useState<{ offset: number; request: number } | null>(null)
  const headings = useMemo(() => outlineHeadings(draft), [draft])
  const [aiOpen, setAiOpen] = useState(false)
  const [selectedBlock, setSelectedBlock] = useState<string | null>(null)
  const [selection, setSelection] = useState({ from: 0, to: 0 })
  const [instruction, setInstruction] = useState('')
  const [proposal, setProposal] = useState<Proposal | null>(null)
  const [aiBusy, setAiBusy] = useState(false)
  const [aiError, setAiError] = useState('')
  const aiRequest = useRef<AbortController | null>(null)
  useEffect(() => () => aiRequest.current?.abort(), [])
  const [editBlockId, setEditBlockId] = useState<string | null>(null)
  const [blockDraft, setBlockDraft] = useState('')
  const [adding, setAdding] = useState(false)
  const [extra, setExtra] = useState('')
  const [operationError, setOperationError] = useState('')
  const [spaceOpen, setSpaceOpen] = useState(false)
  const latestDraft = useRef(draft)
  latestDraft.current = draft
  useEffect(() => { beforeLeave.current = save; return () => { beforeLeave.current = async () => true } }, [beforeLeave, save])
  useEffect(() => { const key = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); void save() } }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key) }, [save])
  if (!note) return <div className="empty">{error ?? '正在打开笔记…'}</div>
  const title = /^#\s+(.+)$/m.exec(draft)?.[1] ?? name.replace(/\.md$/, '')
  const currentBlock = note.blocks.find((b) => b.id === selectedBlock)
  const context = mode === 'canvas' && currentBlock ? { from: currentBlock.start, to: currentBlock.end } : selection.to > selection.from ? selection : { from: 0, to: draft.length }
  const contextLabel = mode === 'canvas' && currentBlock ? '已选中 1 个内容块' : selection.to > selection.from ? '已选择的文字' : '当前整篇笔记'
  const ask = async () => {
    if (!instruction.trim() || aiBusy || !draft.trim()) return
    const source = draft.slice(context.from, context.to)
    const snapshot = draft
    const controller = new AbortController()
    aiRequest.current = controller
    setAiBusy(true); setAiError(''); setProposal(null)
    try {
      const { replacement } = await api.proposeEdit(source, instruction.trim(), controller.signal)
      if (!controller.signal.aborted) setProposal({ model: aiModel, original: source, replacement, ...context, base: snapshot })
    } catch (e) { if (!controller.signal.aborted) setAiError((e as Error).message) }
    finally { if (aiRequest.current === controller) { aiRequest.current = null; setAiBusy(false) } }
  }
  const applyProposal = async () => {
    if (!proposal) return
    if (latestDraft.current !== proposal.base) { setAiError('笔记已发生变化，请重新生成建议后再应用。'); return }
    const content = proposal.base.slice(0, proposal.from) + proposal.replacement + proposal.base.slice(proposal.to)
    if (await replace(content)) { setProposal(null); setInstruction(''); onUpdated() }
  }
  const editBlock = (id: string) => { const block = note.blocks.find((b) => b.id === id); if (block) { setEditBlockId(id); setBlockDraft(block.raw) } }
  const saveBlock = async () => {
    const block = note.blocks.find((b) => b.id === editBlockId)
    if (!block) return
    if (draft !== note.content) { setOperationError('请先等待正文保存，再编辑内容块。'); return }
    if (await replace(note.content.slice(0, block.start) + blockDraft + note.content.slice(block.end))) { setEditBlockId(null); onUpdated() }
  }
  const append = async () => { if (extra.trim() && await replace(draft.trimEnd() + '\n\n' + extra.trim() + '\n')) { setAdding(false); setExtra(''); onUpdated() } }
  const changeSpace = async (space: string) => { try { if (!await save()) return; await api.saveSpace(name, space); await reload(); onUpdated(); setSpaceOpen(false) } catch (e) { setOperationError((e as Error).message) } }
  const changeMode = async (next: 'document' | 'canvas') => { if (await save()) { setMode(next); setSelection({ from: 0, to: 0 }) } }
  const revealHeading = (offset: number, index: number) => {
    if (editing) setReveal(previous => ({ offset, request: (previous?.request || 0) + 1 }))
    else document.querySelectorAll('.document .prose :is(h1,h2,h3,h4,h5,h6)')[index]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  const showProposal = () => {
    if (matchMedia('(max-width: 820px)').matches) setAiOpen(false)
    requestAnimationFrame(() => document.querySelector('.modification-preview')?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }
  return <>
    <header className="topbar">
      <div className="breadcrumb"><Button size="sm" variant="ghost" aria-label="移动笔记到其他空间" onPress={() => setSpaceOpen(true)}>{note.space}</Button><span>/</span><span>{title}</span></div>
      <div className="toolbar"><Button size="sm" variant={mode === 'document' ? 'secondary' : 'ghost'} onPress={() => void changeMode('document')}><Icon name="note"/>文档</Button><Button size="sm" variant={mode === 'canvas' ? 'secondary' : 'ghost'} onPress={() => void changeMode('canvas')}><Icon name="grid"/>画布</Button><IconButton icon="undo" label="撤销上次保存" isDisabled={undoCount === 0} onPress={() => void undo()}/><Button size="sm" variant={aiOpen ? 'secondary' : 'outline'} onPress={() => setAiOpen(!aiOpen)}><Icon name="spark"/>AI 助手</Button></div>
    </header>
    <div className="workspace-body">
      <section className="note-stage">
        {(error || operationError) && <div className="inline-error" role="alert">{error || operationError}{status === 'conflict' && <Button size="sm" variant="ghost" onPress={() => void reload()}>放弃草稿并重新载入</Button>}</div>}
        <div className="note-heading"><div>{mode === 'canvas' && <h1>{title}</h1>}<span className="muted"><Icon name={status === 'saved' ? 'check' : 'clock'} size={13}/>{status === 'saved' ? '已保存到本地' : status === 'saving' ? '正在保存…' : status === 'conflict' ? '需要处理修改冲突' : '未保存'}<span>·</span>{note.blocks.length} 个内容块{mode === 'canvas' && ' · ' + note.groups.length + ' 个容器'}</span></div><div className="toolbar">{mode === 'document' && <Button size="sm" variant="ghost" onPress={() => setEditing(!editing)}>{editing ? '阅读预览' : '编辑正文'}</Button>}<Button size="sm" variant={mode === 'canvas' ? 'primary' : 'outline'} onPress={() => setAdding(true)}><Icon name="plus"/>添加内容</Button></div></div>
        {mode === 'canvas' ? <div className="canvas-wrap"><NoteCanvas onOpenNote={onOpenNote} theme={theme} note={note} onSelect={setSelectedBlock} onEdit={editBlock} onAdd={() => setAdding(true)} onChanged={() => void reload()}/></div> :
          <div className="document-scroll"><div className="document-layout"><article className="document">{editing ? <CodeEditor value={draft} reveal={reveal} onChange={setDraft} onSelection={(from, to) => setSelection({ from, to })} onSave={() => void save()}/> : <div className="prose" onDoubleClick={() => setEditing(true)}><NoteMarkdown onOpenNote={onOpenNote}>{draft}</NoteMarkdown></div>}{proposal && <ModificationPreview original={proposal.original} replacement={proposal.replacement} onDiscard={() => setProposal(null)} onApply={() => void applyProposal()}/>}</article>{!aiOpen && <aside className="document-outline"><span className="section-label">本文目录</span>{headings.map((heading, index) => <Button variant="ghost" size="sm" key={heading.start} aria-label={'定位到：' + heading.title} className={heading.depth > 1 ? 'outline-subheading' : ''} onPress={() => revealHeading(heading.start, index)}>{heading.title}</Button>)}{!headings.length && <p className="muted outline-empty">添加标题后，可在这里快速定位。</p>}</aside>}</div></div>}
      </section>
      {aiOpen && <aside className="ai-panel"><div className="section-header"><strong><Icon name="spark"/>AI 助手</strong><IconButton icon="close" label="关闭 AI 助手" onPress={() => setAiOpen(false)}/></div><div className="context-pill"><Icon name="note" size={14}/>{contextLabel}</div><p className="muted">修改先预览，再由你决定是否应用。</p><Button variant="ghost" size="sm" onPress={onConfigureAI}><Icon name="settings" size={14}/>模型连接</Button>{aiBusy && <div className="section-header"><p role="status">正在准备修改建议…</p><Button variant="ghost" size="sm" onPress={() => { aiRequest.current?.abort(); setAiError('已停止生成，正文未更改。') }}>停止生成</Button></div>}{aiError && <p className="error-text" role="alert">{aiError}</p>}{proposal && <div className="ai-result"><strong>修改已准备好</strong><span className="muted">{proposal.model || '模型服务'}</span><p>检查原文与建议，再决定是否应用。</p>{mode === 'canvas' ? <ModificationPreview compact original={proposal.original} replacement={proposal.replacement} onDiscard={() => setProposal(null)} onApply={() => void applyProposal()}/> : <Button variant="outline" size="sm" onPress={showProposal}>查看修改预览</Button>}<p className="muted">应用后可撤销。正文变化后需重新生成。</p></div>}<div className="ai-composer"><TextArea aria-label="修改要求" value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="让这段文字更自然，保留原意…" rows={3}/><div className="toolbar"><span className="muted">仅发送上述上下文</span><Button isIconOnly size="sm" aria-label="生成修改建议" onPress={() => void ask()} isDisabled={aiBusy || !instruction.trim()}><Icon name="send"/></Button></div></div></aside>}
    </div>
    <Dialog title={editBlockId ? '编辑内容块' : '添加内容'} open={!!editBlockId || adding} onClose={() => { setEditBlockId(null); setAdding(false) }} footer={<><Button variant="ghost" onPress={() => { setEditBlockId(null); setAdding(false) }}>取消</Button><Button onPress={() => void (editBlockId ? saveBlock() : append())}>保存内容</Button></>}><CodeEditor value={editBlockId ? blockDraft : extra} onChange={editBlockId ? setBlockDraft : setExtra}/></Dialog>
    <Dialog title="移动笔记到空间" open={spaceOpen} onClose={() => setSpaceOpen(false)}><div className="spaces">{spaces.map((s) => <Button key={s} className="nav-item" variant={s === note.space ? 'secondary' : 'ghost'} onPress={() => void changeSpace(s)}><Icon name="folder"/>{s}{s === note.space && <Icon name="check"/>}</Button>)}</div></Dialog>
  </>
}
