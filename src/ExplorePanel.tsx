import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { ChangeSetDetail, DraftDTO, SourceRefDTO } from '../shared/types'
import { api, subscribeEvents, type NoteResearch } from './api'
import { DiscussionDialogs, DiscussionThread, clip, folderOf, message, useDiscussionKit } from './discussion'
import { Button, IconButton, TextArea } from './ui'
import { composing } from './ime'

const EXPLAIN = '请解释这段内容。'

/** Explore a note: ask about selected passages, compare answers, write one back, and trace it to its basis. */
export function ExplorePanel({ name, model, active, beforeSend, selection, reveal, onConfigure, onOpenNote, request, onClose }: {
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
    setView(null); setLoadError('')
    const saved = name ? pending.current.get(name) : undefined
    setQuote(saved?.quote ?? ''); setQuestion(saved?.question ?? '')
    void load()
    return () => { if (name) pending.current.set(name, composingDraft.current) }
  }, [load, name])
  useEffect(() => {
    if (!active || !request || request.name !== name || handledRequest.current === request.key) return
    handledRequest.current = request.key
    setQuote(request.quote)
    const frame = requestAnimationFrame(() => input.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [active, request, name])
  useEffect(() => subscribeEvents(event => { if (event.type === 'notes-changed' || event.type === 'note-changed') void load() }), [load])

  // Capture an initial passage, then keep it stable while the user writes a question.
  useEffect(() => {
    if (!active) return
    const read = () => { const text = selection.current()?.trim(); if (text && !composingDraft.current.quote && !composingDraft.current.question) setQuote(previous => previous || text) }
    read()
    const timer = setInterval(read, 400)
    return () => clearInterval(timer)
  }, [active, selection])

  /** Freeze the selection as a source and keep the question in a durable draft, without sending. */
  const collect = async (send: boolean) => {
    if (!name || !view) return
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

  if (!name) return <aside className="explore-panel">{onClose && <div className="explore-heading"><h3>探索笔记</h3><IconButton icon="close" label="关闭 AI 助手" onPress={onClose}/></div>}<p className="muted explore-empty">打开一篇笔记，选中一段文字，就可以围绕它提问。</p></aside>
  const sources = view?.sources ?? {}
  const drafts = view?.drafts ?? []
  const noModel = !model
  const error = kitValue.error || loadError

  return <aside className="explore-panel" aria-label="探索">
    <div className="explore-heading"><div><h3>探索笔记</h3><p className="muted">{name.split('/').pop()?.replace(/\.md$/, '')}</p></div>{onClose && <IconButton icon="close" label="关闭 AI 助手" onPress={onClose}/>}</div>
    <section className="explore-composer" aria-label="围绕选中文字提问">
      <div className="section-header"><span className="section-label">引用原文</span>{quote && <Button variant="ghost" size="sm" isDisabled={!!busy} onPress={() => { const text = selection.current()?.trim(); if (text) { setQuote(text); input.current?.focus() } }}>使用当前选区</Button>}</div>
      {quote ? <blockquote className="explore-quote">{clip(quote, 240)}</blockquote> : <p className="muted explore-hint">在笔记中选中一段文字。</p>}
      <TextArea ref={input} aria-label="你的问题" value={question} rows={3} placeholder="针对这段内容提问，留空则解释原文" readOnly={!!busy} disabled={!view}
        onChange={event => setQuestion(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !composing(event)) { event.preventDefault(); if (!noModel && !busy && view && quote) void guard('ask', () => collect(true)) } }}/>
      <div className="explore-actions">
        <span className="muted explore-shortcut">⌘ / Ctrl + Enter 发送</span>
        <Button variant="ghost" size="sm" isDisabled={!!busy || !view || !quote} onPress={() => void guard('collect', () => collect(false))}>加入待发送</Button>
        <Button size="sm" isDisabled={!!busy || !view || noModel || !quote} onPress={() => void guard('ask', () => collect(true))}>{busy === 'ask' ? '发送中…' : '提问'}</Button>
      </div>
      {noModel && <p className="muted explore-hint">尚未连接模型。<Button variant="ghost" size="sm" onPress={onConfigure}>去设置</Button> 仍可先收集问题。</p>}
    </section>
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
    {view && !view.discussions.length && !drafts.length && <p className="muted explore-empty">还没有探索记录。选中文字并提问后，回答会保留在这里，可以选择写回笔记。</p>}
    <DiscussionDialogs kit={kitValue}/>
  </aside>
}
