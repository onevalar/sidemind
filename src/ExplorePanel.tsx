import { useCallback, useEffect, useRef, useState, type MutableRefObject, type ReactNode } from 'react'
import type { ChangeSetDetail, DraftDTO, SourceRefDTO } from '../shared/types'
import { api, subscribeEvents, type NoteResearch } from './api'
import { DiscussionDialogs, DiscussionThread, clip, folderOf, message, useDiscussionKit } from './discussion'
import { Button, IconButton, TextArea } from './ui'
import { composing } from './ime'

const EXPLAIN = '请解释这段内容。'

/** Explore a note: ask about selected passages, compare answers, write one back, and trace it to its basis. */
export function ExplorePanel({ name, model, active, beforeSend, selection, reveal, onConfigure, onOpenNote, request, onClose, navigation, onAssistant }: {
  navigation?: ReactNode; onAssistant?: () => void
  request?: { name: string; quote: string; key: number } | null; onClose?: () => void
  name: string | null; model: string | null; active: boolean; beforeSend: MutableRefObject<() => Promise<boolean>>
  selection: MutableRefObject<() => string | undefined>; reveal: MutableRefObject<(quote: string, start: number | null) => boolean>; onConfigure: () => void; onOpenNote: (name: string) => void
}) {
  const [view, setView] = useState<NoteResearch | null>(null)
  const [changes, setChanges] = useState<Record<string, ChangeSetDetail>>({})
  const [loadError, setLoadError] = useState('')
  const [quote, setQuote] = useState('')
  const [question, setQuestion] = useState('')
  const input = useRef<HTMLTextAreaElement>(null)
  const history = useRef<HTMLDivElement>(null)
  const followHistory = useRef(true)
  const dismissedSelection = useRef<string | null>(null)
  const pending = useRef(new Map<string, { quote: string; question: string }>())
  const composingDraft = useRef({ quote, question })
  composingDraft.current = { quote, question }
  const handledRequest = useRef<number | null>(null)
  const current = useRef(name)
  current.current = name

  const load = useCallback(async () => {
    if (!name) { setView(null); return }
    try {
      const next = await api.researchNote(name)
      if (current.current !== name) return
      setView(next); setLoadError('')
      kit.current.adopt(next.runs)
      kit.current.adoptDrafts(next.drafts)
      const details = await Promise.all(next.captures.filter(capture => capture.changeSetId).map(capture => api.changeSet(capture.changeSetId!).catch(() => null)))
      if (current.current === name) setChanges(Object.fromEntries(details.filter((detail): detail is ChangeSetDetail => !!detail).map(detail => [detail.id, detail])))
    } catch (failure) { if (current.current === name) setLoadError('无法读取探索记录：' + message(failure)) }
  }, [name])
  const kitValue = useDiscussionKit({ reload: load, beforeSend, onOpenNote, reveal, scope: name })
  const kit = useRef(kitValue)
  kit.current = kitValue
  const { busy, guard, flush, texts, setTexts, sendDraft } = kitValue
  useEffect(() => {
    setView(null); setLoadError(''); dismissedSelection.current = null
    const saved = name ? pending.current.get(name) : undefined
    setQuote(saved?.quote ?? ''); setQuestion(saved?.question ?? '')
    void load()
    return () => { if (name) pending.current.set(name, composingDraft.current) }
  }, [load, name])
  useEffect(() => {
    if (!active || !request || request.name !== name || handledRequest.current === request.key) return
    handledRequest.current = request.key
    dismissedSelection.current = null
    setQuote(request.quote)
    const frame = requestAnimationFrame(() => input.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [active, request, name])
  useEffect(() => subscribeEvents(event => { if (event.type === 'notes-changed' || event.type === 'note-changed') void load() }), [load])

  // Capture an initial passage, then keep it stable while the user writes a question.
  useEffect(() => {
    if (!active) return
    const read = () => { const text = selection.current()?.trim(); if (text && text !== dismissedSelection.current && !composingDraft.current.quote && !composingDraft.current.question) setQuote(previous => previous || text) }
    read()
    const timer = setInterval(read, 400)
    return () => clearInterval(timer)
  }, [active, selection, name])

  // Follow a live answer only while the reader remains at the end of the history.
  useEffect(() => {
    const node = history.current
    if (!active || !node || !name) return
    followHistory.current = true
    const follow = () => { if (followHistory.current) node.scrollTop = node.scrollHeight }
    follow()
    if (typeof ResizeObserver === 'undefined' || !node.firstElementChild) return
    const observer = new ResizeObserver(follow)
    observer.observe(node.firstElementChild)
    return () => observer.disconnect()
  }, [active, name])

  /** Freeze the selection as a source and keep the question in a durable draft, without sending. */
  const collect = async (send: boolean) => {
    if (!name || !view) return
    followHistory.current = true
    const passage = quote
    const text = question.trim() || EXPLAIN
    await flush()
    if (current.current !== name) return
    // A passage with no question means "explain this", as in ChatGit's quote-and-send.
    if (!passage) throw new Error('请先在笔记中选中文字，再写下问题。')
    const source: SourceRefDTO = await api.createSource(name, passage)
    const item = { id: crypto.randomUUID(), question: text, sourceIds: [source.id] }
    const existing = view.drafts.find(draft => !draft.discussionId)
    const draft = existing ? await api.updateDraft(existing.id, existing.revision, [...existing.items, item]) : await api.createDraft({ origin: { kind: 'note', noteId: view.noteId, sourceId: source.id }, items: [item] })
    if (current.current === name) { setTexts(value => ({ ...value, [item.id]: text })); setQuestion('') }
    else pending.current.set(name, { quote: passage, question: '' })
    // A failed send must still expose the durable draft, so retry does not create another question.
    try { if (send) await sendDraft(draft, [item.id]) } finally { await load() }
  }
  const dropItem = (draft: DraftDTO, id: string) => guard('drop' + id, async () => { await api.updateDraft(draft.id, draft.revision, draft.items.filter(item => item.id !== id)); await load() })

  const heading = <div className="explore-heading">{navigation ?? <h3>探索</h3>}{onClose && <IconButton icon="close" label="关闭 AI 助手" onPress={onClose}/>}</div>
  if (!name) return <aside className="explore-panel" aria-label="探索">{heading}<div className="explore-history explore-onboarding"><h3>从一段原文开始</h3><p className="muted explore-empty">打开笔记并选中文字，即可解释概念、比较回答，再把有用的内容写回笔记。</p>{onAssistant && <Button variant="ghost" size="sm" onPress={onAssistant}>需要查找或整理笔记？前往助手</Button>}</div></aside>
  const sources = view?.sources ?? {}
  const drafts = view?.drafts ?? []
  const noModel = !model
  const error = kitValue.error || loadError
  const useSelection = () => { const text = selection.current()?.trim(); if (text) { dismissedSelection.current = null; setQuote(text); input.current?.focus() } }

  return <aside className="explore-panel" aria-label="探索">
    {heading}
    <p className="explore-note-context muted" title={name}>{name.split('/').pop()?.replace(/\.md$/, '')}</p>
    <div ref={history} className="explore-history" aria-label="探索记录" onScroll={event => { const node = event.currentTarget; followHistory.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48 }}><div className="explore-history-content">
    {error && <p className="ai-error" role="alert">{error}</p>}

    {drafts.map(draft => <section className="explore-draft" key={draft.id} aria-label="待发送的问题">
      <div className="section-header"><h3 className="agent-section-title">待发送 · {draft.items.length}</h3>
        <Button size="sm" isDisabled={!!busy || noModel} onPress={() => void guard('send' + draft.id, async () => { await sendDraft(draft, draft.items.map(item => item.id)) })}>{busy === 'send' + draft.id ? '发送中…' : '全部发送'}</Button></div>
      {draft.items.map(item => <div className="explore-item" key={item.id}>
        {item.sourceIds.map(id => sources[id] && <blockquote className="explore-quote" key={id}>{clip(sources[id]!.quote, 120)}</blockquote>)}
        <TextArea aria-label="问题" rows={2} value={texts[item.id] ?? item.question} disabled={!!busy}
          onChange={event => setTexts(value => ({ ...value, [item.id]: event.target.value }))}
          onBlur={() => { const text = texts[item.id]; if (text !== undefined && text !== item.question) void guard('edit' + item.id, async () => { await api.updateDraft(draft.id, draft.revision, draft.items.map(entry => entry.id === item.id ? { ...entry, question: text } : entry)); await load() }) }}/>
        <div className="explore-actions"><Button variant="ghost" size="sm" isDisabled={!!busy} onPress={() => void dropItem(draft, item.id)}>移除</Button></div>
      </div>)}
    </section>)}

    {view?.discussions.map(discussion => <DiscussionThread key={discussion.id} kit={kitValue} discussion={discussion} sources={sources} captures={view.captures} changes={changes}
      model={model} noteName={name} appendTo={name} newFolder={folderOf(name)}/>)}
    {view && !view.discussions.length && !drafts.length && <div className="explore-onboarding"><h3>{quote ? '围绕这段原文深入理解' : '从一段原文开始'}</h3><p className="muted explore-empty">{quote ? '直接提问，或留空发送以解释原文。回答会保留引用，你可以追问、比较并写回笔记。' : '在笔记中选中文字，再到这里提问。回答与引用保存在当前笔记的探索记录中。'}</p></div>}
    </div></div>
    <section className="explore-composer" aria-label="围绕选中文字提问">
      <div className="section-header"><span className="section-label">{quote ? '已引用原文' : '尚未引用原文'}</span><div className="explore-actions"><Button variant="ghost" size="sm" isDisabled={!!busy} onPress={useSelection}>{quote ? '替换选区' : '引用选区'}</Button>{quote && <IconButton icon="close" label="移除引用" isDisabled={!!busy} onPress={() => { dismissedSelection.current = selection.current()?.trim() || quote; setQuote(''); input.current?.focus() }}/>}</div></div>
      {quote && <blockquote className="explore-quote explore-composer-quote">{quote}</blockquote>}
      <TextArea ref={input} aria-label="你的问题" value={question} rows={2} placeholder={quote ? '针对原文提问，留空则解释原文…' : '先在笔记中选中文字…'} readOnly={!!busy} disabled={!view}
        onChange={event => setQuestion(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !composing(event)) { event.preventDefault(); if (!noModel && !busy && view && quote) void guard('ask', () => collect(true)) } }}/>
      <div className="explore-actions">
        <span className="muted explore-shortcut">Enter 发送 · Shift + Enter 换行</span>
        <Button variant="ghost" size="sm" isDisabled={!!busy || !view || !quote} onPress={() => void guard('collect', () => collect(false))}>加入待发送</Button>
        <Button size="sm" isDisabled={!!busy || !view || noModel || !quote} onPress={() => void guard('ask', () => collect(true))}>{busy === 'ask' ? '发送中…' : question.trim() ? '提问' : '解释原文'}</Button>
      </div>
      <div className="explore-model"><Button variant="ghost" size="sm" onPress={onConfigure}>{model ?? '连接模型'}</Button>{noModel && <span className="muted explore-hint">连接后发送，也可先收集问题</span>}</div>
    </section>
    <DiscussionDialogs kit={kitValue}/>
  </aside>
}
