import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { createPortal } from 'react-dom'
import { AiChat } from './components/arc/blocks/ai-chat/ai-chat'
import { prefs } from './prefs'
import type { ChangeSetDetail, DiscussionSummaryDTO } from '../shared/types'
import { api, subscribeEvents, type DiscussionView } from './api'
import { DiscussionDialogs, DiscussionThread, message, title, useDiscussionKit } from './discussion'
import { Button, Input, Icon, DropdownMenu } from './ui'


const ago = (time: number) => new Date(time).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })

/**
 * Independent conversations. They run on the same discussion, run and write-back layers as exploring a note, so a
 * conversation started from a passage shows up here and a plain one can be written into any note.
 */
export function ChatWorkspace({ notes, model, active, beforeSend, onConfigure, onOpenNote, navigationRoot, newChat }: {
  navigationRoot?: HTMLElement | null; newChat?: MutableRefObject<() => void>
  notes: { name: string; title: string }[]; model: string | null; active: boolean; beforeSend: MutableRefObject<() => Promise<boolean>>; onConfigure: () => void; onOpenNote: (name: string) => void
}) {
  const [list, setList] = useState<DiscussionSummaryDTO[]>([])
  const [archived, setArchived] = useState(false)
  const [selected, setSelected] = useState<string | null>(() => prefs.get('chat-selected'))
  const [view, setView] = useState<DiscussionView | null>(null)
  const [changes, setChanges] = useState<Record<string, ChangeSetDetail>>({})
  const [loadError, setLoadError] = useState('')
  const [drafts, setDrafts] = useState<Record<string, string>>(() => {
    try { const saved = JSON.parse(prefs.get('chat-drafts') || '{}'); return saved && typeof saved === 'object' && !Array.isArray(saved) ? Object.fromEntries(Object.entries(saved).filter(([, value]) => typeof value === 'string')) as Record<string, string> : {} } catch { return {} }
  })
  const draftKey = selected ?? 'new'
  const question = drafts[draftKey] ?? ''
  const setQuestion = (value: string) => setDrafts(current => ({ ...current, [draftKey]: value }))
  useEffect(() => { prefs.set('chat-drafts', JSON.stringify(drafts)) }, [drafts])
  const [query, setQuery] = useState('')
  useEffect(() => { if (selected) prefs.set('chat-selected', selected); else prefs.remove('chat-selected') }, [selected])
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
      if (!next) { if (current.current === id) setSelected(null); return }
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

  const open = (id: string | null) => {
    // Choosing the conversation that is already open must not blank it: nothing would trigger a reload.
    if (id === selected) { void load(); return }
    retry.current = null; setSelected(id); setView(null); setChanges({})
  }
  useEffect(() => { if (newChat) newChat.current = () => { if (!busy) { setArchived(false); setQuery(''); open(null) } } })
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
    setDrafts(current => { const next = { ...current }; if (next[draftKey] === text || next[draftKey]?.trim() === text) delete next[draftKey]; return next }); setSelected(sent.discussion.id)
  })
  const archive = (id: string, value: boolean) => guard('archive' + id, async () => { await api.archiveDiscussion(id, value); if (selected === id) open(null); await load() })
  const error = kitValue.error || loadError
  const summary = list.find(item => item.id === selected)
  const heading = summary?.title ?? view?.discussion.title ?? '新对话'
  const submit = () => { if (!noModel) void send() }
  const waiting = !!view && !leaf && Object.values(kitValue.runs).some(run => run.status === 'queued' || run.status === 'running')
  const liveRuns = Object.values(kitValue.runs).filter(run => run.discussionId === selected && (run.status === 'queued' || run.status === 'running'))
  const filtered = list.filter(item => (item.title + ' ' + item.lastQuestion).toLocaleLowerCase().includes(query.toLocaleLowerCase().trim()))
  const navigation = <nav className="chat-list" aria-label="对话列表" hidden={!active}>
    <Button variant="ghost" size="sm" className="nav-item chat-new" aria-label="新对话" isDisabled={!!busy} onPress={() => { setArchived(false); setQuery(''); open(null) }}><Icon name="plus"/><span>新对话</span></Button>
    <div className="chat-search"><Input id="chat-search" aria-label="搜索对话" placeholder="搜索对话" value={query} onChange={event => setQuery(event.target.value)}/></div>
    <div className="section-header sidebar-section chat-list-heading"><span className="section-label">{archived ? '已归档' : '最近对话'}</span>
      <DropdownMenu label="对话列表选项" trigger={<Button variant="ghost" size="sm" isIconOnly aria-label="对话列表选项"><Icon name="more"/></Button>} items={[{ label: archived ? '返回最近对话' : '查看已归档', disabled: !!busy, onSelect: () => { setArchived(value => !value); open(null) } }]}/>
    </div>
    <ul className="chat-items">
      {filtered.map(item => <li key={item.id}>
        <Button variant="ghost" size="sm" isDisabled={!!busy} className={'chat-item' + (item.id === selected ? ' is-active' : '')} aria-current={item.id === selected ? 'page' : undefined} onPress={() => open(item.id)}>
          <span className="chat-item-title">{item.title}</span>
          <span className="chat-item-meta muted">{drafts[item.id]?.trim() ? '草稿 · ' : ''}{ago(item.updatedAt)}</span>
        </Button>
      </li>)}
    </ul>
    {!filtered.length && <p className="muted chat-empty">{query ? '没有找到匹配的对话。' : archived ? '没有已归档的对话。' : '从一个问题开始。'}</p>}
  </nav>

  return <div className={'chat-workspace' + (navigationRoot !== undefined ? ' has-shared-navigation' : '')} hidden={!active}>
    {navigationRoot === undefined ? navigation : navigationRoot ? createPortal(navigation, navigationRoot) : null}
    <section className="chat-detail" aria-label={'对话：' + heading}>
      <header className="chat-detail-head">
        <h2>{heading}</h2>
        <div className="chat-list-actions">
          <Button variant="ghost" size="sm" onPress={onConfigure} title={model ?? '连接模型'}><span className="chat-model">{model ?? '连接模型'}</span><Icon name="down" size={14}/></Button>
          {summary && <DropdownMenu label="对话操作" trigger={<Button variant="ghost" size="sm" isIconOnly aria-label="对话操作"><Icon name="more"/></Button>} items={[
            ...(summary.notePath ? [{ label: '打开来源笔记', onSelect: () => onOpenNote(summary.notePath!) }] : []),
            { label: summary.archived ? '取消归档' : '归档对话', disabled: !!busy, onSelect: () => void archive(summary.id, !summary.archived) },
          ]}/>}
        </div>
      </header>
      <AiChat key={selected ?? 'new'} title="对话内容" model={model} hideHeader onConfigure={onConfigure} onNew={() => open(null)} onClose={() => {}}
        messages={[]} value={question} onValueChange={setQuestion} onSend={submit} onStop={() => { void Promise.all(liveRuns.map(run => api.stopRun(run.id))).catch(failure => kitValue.setError(message(failure))) }}
        busy={liveRuns.length > 0} disabled={!!busy || noModel || (!!selected && (!view || !leaf))} readOnly={!!busy}
        inputLabel={selected ? '继续提问' : '你的问题'} sendLabel={selected ? '继续提问' : '开始对话'} placeholder={selected ? '继续提问…' : '有什么想一起想清楚的？'}
        emptyTitle="从一个问题开始" emptyText="一起推敲想法，值得留下的，再存进笔记。" onOpenNote={onOpenNote}
        hideComposer={!!view?.discussion.imported?.readOnly}
        context={error ? <p className="ai-error" role="alert">{error}</p> : noModel ? <p className="muted explore-hint">连接模型后即可开始。<Button variant="ghost" size="sm" onPress={onConfigure}>连接模型</Button></p> : waiting ? <p className="muted explore-hint">正在回答，你可以先写下一个问题。</p> : undefined}
        thread={selected ? view ? <DiscussionThread kit={kitValue} discussion={view.discussion} sources={view.sources} captures={view.captures} changes={changes} model={model}
          presentation="chat" readOnly={!!view.discussion.imported?.readOnly} noteName={null} appendTo={origin} newFolder="" notes={notes}/> : <p className="muted chat-empty" role="status">{loadError || '正在读取对话…'}</p> : undefined}>
        {view?.discussion.imported?.readOnly && <p className="muted chat-empty" role="note">这是只读历史，可以阅读或保存到笔记。继续交流请新建对话。</p>}
      </AiChat>
    </section>
    <DiscussionDialogs kit={kitValue}/>
  </div>
}
