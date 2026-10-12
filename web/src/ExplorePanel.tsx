import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { ChangeSetDetail, DraftDTO, SourceRefDTO } from '../shared/types'
import { api, subscribeEvents, type NoteResearch } from './api'
import { DiscussionDialogs, DiscussionThread, clip, folderOf, message, useDiscussionKit } from './discussion'
import { Button, TextArea } from './ui'

/** Explore a note: ask about selected passages, compare answers, write one back, and trace it to its basis. */
export function ExplorePanel({ name, model, active, beforeSend, selection, reveal, onConfigure, onOpenNote }: {
  name: string | null; model: string | null; active: boolean; beforeSend: MutableRefObject<() => Promise<boolean>>
  selection: MutableRefObject<() => string | undefined>; reveal: MutableRefObject<(quote: string, start: number | null) => boolean>; onConfigure: () => void; onOpenNote: (name: string) => void
}) {
  const [view, setView] = useState<NoteResearch | null>(null)
  const [changes, setChanges] = useState<Record<string, ChangeSetDetail>>({})
  const [loadError, setLoadError] = useState('')
  const [quote, setQuote] = useState('')
  const [question, setQuestion] = useState('')
  const current = useRef(name)
  current.current = name

  const load = useCallback(async () => {
    if (!name) { setView(null); return }
    try {
      const next = await api.researchNote(name)
      if (current.current !== name) return
      setView(next)
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
  useEffect(() => { setView(null); setLoadError(''); setQuote(''); void load() }, [load])
  useEffect(() => subscribeEvents(event => { if (event.type === 'notes-changed' || event.type === 'note-changed') void load() }), [load])

  // The editor keeps its selection while focus moves here; read it while this tab is showing.
  useEffect(() => {
    if (!active) return
    const read = () => { const text = selection.current()?.trim(); if (text) setQuote(text) }
    read()
    const timer = setInterval(read, 400)
    return () => clearInterval(timer)
  }, [active, selection])

  /** Freeze the selection as a source and keep the question in a durable draft, without sending. */
  const collect = async (send: boolean) => {
    if (!name || !view) return
    await flush()
    const text = question.trim()
    if (!quote || !text) throw new Error('请先在笔记中选中文字，再写下问题。')
    const source: SourceRefDTO = await api.createSource(name, quote)
    const item = { id: crypto.randomUUID(), question: text, sourceIds: [source.id] }
    const existing = view.drafts.find(draft => !draft.discussionId)
    const draft = existing ? await api.updateDraft(existing.id, existing.revision, [...existing.items, item]) : await api.createDraft({ origin: { kind: 'note', noteId: view.noteId, sourceId: source.id }, items: [item] })
    setTexts(value => ({ ...value, [item.id]: text })); setQuestion('')
    if (send) await sendDraft(draft, [item.id]); else await load()
  }
  const dropItem = (draft: DraftDTO, id: string) => guard('drop' + id, async () => { await api.updateDraft(draft.id, draft.revision, draft.items.filter(item => item.id !== id)); await load() })

  if (!name) return <aside className="explore-panel"><p className="muted explore-empty">打开一篇笔记，选中一段文字，就可以围绕它提问。</p></aside>
  const sources = view?.sources ?? {}
  const drafts = view?.drafts ?? []
  const noModel = !model
  const error = kitValue.error || loadError

  return <aside className="explore-panel" aria-label="探索">
    <section className="explore-composer" aria-label="围绕选中文字提问">
      <h3 className="agent-section-title">围绕选中文字提问</h3>
      {quote ? <blockquote className="explore-quote">{clip(quote, 240)}</blockquote> : <p className="muted explore-hint">在笔记中选中一段文字。</p>}
      <TextArea aria-label="你的问题" value={question} rows={3} placeholder="想问什么？可先收集多个问题，再一起发送。" disabled={!!busy || !view}
        onChange={event => setQuestion(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); if (!noModel) void guard('ask', () => collect(true)) } }}/>
      <div className="explore-actions">
        <Button variant="ghost" size="sm" isDisabled={!!busy || !quote || !question.trim()} onPress={() => void guard('collect', () => collect(false))}>先收集</Button>
        <Button size="sm" isDisabled={!!busy || noModel || !quote || !question.trim()} onPress={() => void guard('ask', () => collect(true))}>{busy === 'ask' ? '发送中…' : '提问'}</Button>
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
