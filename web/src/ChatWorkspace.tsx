import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { ChangeSetDetail, DiscussionSummaryDTO } from '../shared/types'
import { api, subscribeEvents, type DiscussionView } from './api'
import { DiscussionDialogs, DiscussionThread, clip, message, title, useDiscussionKit } from './discussion'
import { Button, Select, TextArea } from './ui'
import { composing } from './ime'

const NONE = '__none__'
const ago = (time: number) => new Date(time).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

/**
 * Independent conversations. They run on the same discussion, run and write-back layers as exploring a note, so a
 * conversation started from a passage shows up here and a plain one can be written into any note.
 */
export function ChatWorkspace({ notes, model, active, beforeSend, onConfigure, onOpenNote }: {
  notes: { name: string; title: string }[]; model: string | null; active: boolean; beforeSend: MutableRefObject<() => Promise<boolean>>; onConfigure: () => void; onOpenNote: (name: string) => void
}) {
  const [list, setList] = useState<DiscussionSummaryDTO[]>([])
  const [archived, setArchived] = useState(false)
  const [selected, setSelected] = useState<string | null>(() => localStorage.getItem('canvas.chat-selected'))
  const [view, setView] = useState<DiscussionView | null>(null)
  const [changes, setChanges] = useState<Record<string, ChangeSetDetail>>({})
  const [loadError, setLoadError] = useState('')
  const [question, setQuestion] = useState('')
  const [target, setTarget] = useState<string>(NONE)
  const [detailOpen, setDetailOpen] = useState(() => !!localStorage.getItem('canvas.chat-selected'))
  useEffect(() => { if (selected) localStorage.setItem('canvas.chat-selected', selected); else localStorage.removeItem('canvas.chat-selected') }, [selected])
  const current = useRef(selected)
  current.current = selected
  const listed = useRef(archived)
  listed.current = archived

  const load = useCallback(async () => {
    try {
      const rows = await api.discussions(listed.current)
      setList(rows)
      const id = current.current
      if (!id) { setView(null); return }
      const next = await api.discussionView(id).catch(failure => { if (/找不到/.test(message(failure))) return null; throw failure })
      if (!next) { if (current.current === id) { setSelected(null); setDetailOpen(false) } return }
      if (current.current !== id) return
      setView(next); setLoadError('')
      kit.current.adopt(next.runs)
      const details = await Promise.all(next.captures.filter(capture => capture.changeSetId).map(capture => api.changeSet(capture.changeSetId!).catch(() => null)))
      if (current.current === id) setChanges(Object.fromEntries(details.filter((detail): detail is ChangeSetDetail => !!detail).map(detail => [detail.id, detail])))
    } catch (failure) { setLoadError('无法读取对话：' + message(failure)) }
  }, [])
  const kitValue = useDiscussionKit({ reload: load, beforeSend, onOpenNote, scope: selected })
  const kit = useRef(kitValue)
  kit.current = kitValue
  const { busy, guard } = kitValue

  useEffect(() => { if (active) void load() }, [active, archived, selected, load])
  useEffect(() => subscribeEvents(event => { if (active && (event.type === 'notes-changed' || event.type === 'note-changed')) void load() }), [active, load])
  // Where an answer is appended follows the conversation: a conversation about a note defaults to that note.
  const origin = list.find(item => item.id === selected)?.notePath ?? null
  useEffect(() => { setTarget(origin ?? NONE) }, [selected, origin])

  const open = (id: string | null) => {
    setDetailOpen(true)
    // Choosing the conversation that is already open must not blank it: nothing would trigger a reload.
    if (id === selected) { void load(); return }
    retry.current = null; setSelected(id); setView(null); setChanges({}); setQuestion('')
  }
  const noModel = !model

  // A send that failed after its draft was saved retries with the same draft, so it can never create a second question.
  const retry = useRef<{ draft: string; item: string; text: string; discussion: string | null; parent: string | null } | null>(null)
  const leaf = view ? [...view.discussion.turns].reverse().find(turn => turn.answers.length) : undefined
  const send = () => guard('send', async () => {
    const text = question.trim()
    if (!text) throw new Error('请先写下问题。')
    const parent = selected ? leaf?.id ?? null : null
    if (selected && !parent) throw new Error('请等上一条回答完成后再继续提问。')
    let pending = retry.current
    if (!pending || pending.text !== text || pending.discussion !== selected || pending.parent !== parent) {
      const item = crypto.randomUUID()
      const draft = await api.createDraft({ ...(selected ? { discussionId: selected, parentIds: [parent!] } : {}), items: [{ id: item, question: text, sourceIds: [] }] })
      pending = retry.current = { draft: draft.id, item, text, discussion: selected, parent }
    }
    kitValue.setTexts(value => ({ ...value, [pending!.item]: text }))
    const sent = await kitValue.sendDraft({ id: pending.draft, items: [{ id: pending.item, question: text, sourceIds: [] }] }, [pending.item])
    retry.current = null
    setQuestion(''); setSelected(sent.discussion.id)
  })
  const archive = (id: string, value: boolean) => guard('archive' + id, async () => { await api.archiveDiscussion(id, value); if (selected === id) open(null); await load() })
  const error = kitValue.error || loadError
  const summary = list.find(item => item.id === selected)
  const heading = summary?.title ?? view?.discussion.title ?? '新对话'
  const submit = () => { if (!noModel) void send() }
  const waiting = !!view && !leaf && Object.values(kitValue.runs).some(run => run.status === 'queued' || run.status === 'running')
  const hint = !selected ? '想问什么？回答会保存在对话里，之后可以选择写入笔记。Enter 发送，Shift+Enter 换行。' : leaf ? '继续提问（Enter 发送；想从别处分支，用每条回答下的“追问”）' : !view ? '正在读取对话…' : waiting ? '等待上一条回答完成后继续提问' : '上一条没有回答成功，请先在上面重试'

  return <div className="chat-workspace" data-detail={detailOpen ? 'true' : undefined} hidden={!active}>
    <nav className="chat-list" aria-label="对话列表">
      <div className="chat-list-head"><h2>对话</h2>
        <div className="chat-list-actions">
          <Button variant="ghost" size="sm" aria-pressed={archived} onPress={() => { setArchived(value => !value); open(null); setDetailOpen(false) }}>{archived ? '返回对话' : '已归档'}</Button>
          {!archived && <Button size="sm" onPress={() => open(null)}>新对话</Button>}</div></div>
      <ul className="chat-items">
        {list.map(item => <li key={item.id}>
          <Button variant="ghost" size="sm" className={'chat-item' + (item.id === selected ? ' is-active' : '')} aria-current={item.id === selected ? 'true' : undefined} onPress={() => open(item.id)}>
            <span className="chat-item-title">{item.title}</span>
            <span className="chat-item-meta muted">{item.notePath ? '来自《' + title(item.notePath) + '》 · ' : ''}{item.turnCount} 个问题 · {ago(item.updatedAt)}</span>
          </Button>
        </li>)}
      </ul>
      {!list.length && <p className="muted chat-empty">{archived ? '没有已归档的对话。' : '还没有对话。在右侧写下第一个问题。'}</p>}
    </nav>

    <section className="chat-detail" aria-label={'对话：' + heading}>
      <header className="chat-detail-head">
        <Button variant="ghost" size="sm" className="chat-back" onPress={() => setDetailOpen(false)}>返回列表</Button>
        <h2>{heading}</h2>
        {summary && <div className="chat-list-actions">
          {summary.notePath && <Button variant="ghost" size="sm" onPress={() => onOpenNote(summary.notePath!)}>打开《{title(summary.notePath)}》</Button>}
          <Button variant="ghost" size="sm" isDisabled={!!busy} onPress={() => void archive(summary.id, !summary.archived)}>{summary.archived ? '取消归档' : '归档'}</Button></div>}
      </header>
      <div className="chat-scroll">
        {error && <p className="ai-error" role="alert">{error}</p>}
        {view && selected && <>
          {leaf && <div className="chat-target">
            <Select id="chat-target-note" label="写入笔记" value={target} onValueChange={setTarget} options={[{ value: NONE, label: '不追加（只能存为新笔记）' }, ...notes.map(note => ({ value: note.name, label: note.title }))]}/>
          </div>}
          <DiscussionThread kit={kitValue} discussion={view.discussion} sources={view.sources} captures={view.captures} changes={changes} model={model}
            noteName={null} appendTo={target === NONE ? null : target} appendLabel={notes.find(note => note.name === target)?.title} newFolder="" notes={notes}/></>}
        {!selected && <p className="muted chat-empty">这是一段没有读取任何笔记的独立对话。想基于笔记内容提问，请在笔记里选中文字后使用「探索」。</p>}
        {selected && !view && !error && <p className="muted chat-empty">正在读取对话…</p>}
      </div>
      <div className="chat-composer">
        {/* readOnly, not disabled: a disabled field drops keyboard focus, and the next question would need a click first. */}
        <TextArea aria-label={selected ? '继续提问' : '你的问题'} value={question} rows={3} placeholder={hint} aria-busy={!!busy} readOnly={!!busy || (!!selected && (!view || !leaf))}
          onChange={event => setQuestion(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !composing(event)) { event.preventDefault(); submit() } }}/>
        <div className="explore-actions">
          {noModel && <span className="muted explore-hint">尚未连接模型。<Button variant="ghost" size="sm" onPress={onConfigure}>去设置</Button></span>}
          <Button size="sm" isDisabled={!!busy || noModel || !question.trim() || (!!selected && !leaf)} onPress={submit}>{busy === 'send' ? '发送中…' : selected ? '继续提问' : '开始对话'}</Button></div>
      </div>
    </section>
    <DiscussionDialogs kit={kitValue}/>
  </div>
}
