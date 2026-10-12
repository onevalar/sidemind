import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { AnswerVersionDTO, CaptureDTO, ChangeSetDetail, DiscussionDTO, DraftDTO, ResolvedSourceDTO, SourceRefDTO, TurnDTO } from '../shared/types'
import { api, subscribeEvents, type CaptureTarget, type NoteResearch } from './api'
import { NoteMarkdown } from './NoteMarkdown'
import { Button, Dialog, TextArea } from './ui'

const folderOf = (name: string) => name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : ''
const title = (path: string) => path.split('/').at(-1)!.replace(/\.md$/, '')
const clip = (text: string, max: number) => { const flat = text.replace(/\s+/g, ' ').trim(); return flat.length > max ? flat.slice(0, max) + '…' : flat }
const statusText: Record<ResolvedSourceDTO['status'], string> = {
  current: '与笔记当前内容一致。', moved: '笔记已修改，这段文字仍能在原文中唯一找到。', ambiguous: '笔记已修改，这段文字现在出现多次，无法确定位置；以下是当时的依据。',
  missing: '笔记已修改，原文中找不到这段文字；以下是当时的依据。', 'note-deleted': '来源笔记已删除；以下是当时保存的依据。',
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

/** Explore a note: ask about selected passages, compare answers, write one back, and trace it to its basis. */
export function ExplorePanel({ name, model, active, beforeSend, selection, onConfigure, onOpenNote }: {
  name: string | null; model: string | null; active: boolean; beforeSend: MutableRefObject<() => Promise<boolean>>
  selection: MutableRefObject<() => string | undefined>; onConfigure: () => void; onOpenNote: (name: string) => void
}) {
  const [view, setView] = useState<NoteResearch | null>(null)
  const [changes, setChanges] = useState<Record<string, ChangeSetDetail>>({})
  const [error, setError] = useState('')
  const [quote, setQuote] = useState('')
  const [question, setQuestion] = useState('')
  const [texts, setTexts] = useState<Record<string, string>>({})
  const [running, setRunning] = useState<Record<string, boolean>>({})
  const [failed, setFailed] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [follow, setFollow] = useState<{ turn: string; text: string } | null>(null)
  const [version, setVersion] = useState<Record<string, number>>({})
  const [basis, setBasis] = useState<ResolvedSourceDTO | null>(null)
  const keys = useRef(new Map<string, string>())
  const current = useRef(name)
  current.current = name

  const load = useCallback(async () => {
    if (!name) { setView(null); return }
    try {
      const next = await api.researchNote(name)
      if (current.current !== name) return
      setView(next)
      setTexts(previous => { const merged = { ...previous }; for (const draft of next.drafts) for (const item of draft.items) merged[item.id] ??= item.question; return merged })
      const details = await Promise.all(next.captures.filter(capture => capture.changeSetId).map(capture => api.changeSet(capture.changeSetId!).catch(() => null)))
      if (current.current === name) setChanges(Object.fromEntries(details.filter((detail): detail is ChangeSetDetail => !!detail).map(detail => [detail.id, detail])))
    } catch (failure) { if (current.current === name) setError('无法读取探索记录：' + message(failure)) }
  }, [name])
  useEffect(() => { setView(null); setError(''); setQuote(''); setFollow(null); void load() }, [load])
  useEffect(() => subscribeEvents(event => { if (event.type === 'notes-changed' || event.type === 'note-changed') void load() }), [load])

  // The editor keeps its selection while focus moves here; read it while this tab is showing.
  useEffect(() => {
    if (!active) return
    const read = () => { const text = selection.current()?.trim(); if (text) setQuote(text) }
    read()
    const timer = setInterval(read, 400)
    return () => clearInterval(timer)
  }, [active, selection])

  const guard = async (id: string, action: () => Promise<void>) => {
    if (busy) return
    setBusy(id); setError('')
    try { await action() } catch (failure) { setError(message(failure)) } finally { setBusy(null) }
  }
  const flush = async () => { if (!await beforeSend.current()) throw new Error('请先处理未保存的修改，再继续。') }

  const answer = async (discussionId: string, turn: TurnDTO) => {
    setRunning(value => ({ ...value, [turn.id]: true })); setFailed(value => { const { [turn.id]: _, ...rest } = value; return rest })
    try { await api.answerTurn(discussionId, turn.id, crypto.randomUUID()) }
    catch (failure) { setFailed(value => ({ ...value, [turn.id]: message(failure) })) }
    finally { setRunning(value => ({ ...value, [turn.id]: false })); await load() }
  }
  const sendDraft = async (draft: DraftDTO, ids: string[]) => {
    const items = ids.map(id => ({ id, question: (texts[id] ?? draft.items.find(item => item.id === id)!.question).trim() }))
    if (items.some(item => !item.question)) throw new Error('请先写下问题。')
    const sent = await api.sendDraft(draft.id, items)
    setTexts(value => { const rest = { ...value }; for (const item of sent.draft.items) rest[item.id] ??= item.question; for (const id of ids) if (!sent.draft.items.some(item => item.id === id)) delete rest[id]; return rest })
    await load()
    // Answers run on their own so the next question can be written while these are generated.
    void Promise.all(sent.turns.map(turn => answer(sent.discussion.id, turn)))
  }

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

  const askFollowUp = (discussion: DiscussionDTO, turn: TurnDTO) => guard('follow' + turn.id, async () => {
    const text = follow?.text.trim()
    if (!text) throw new Error('请先写下追问。')
    const id = crypto.randomUUID()
    const draft = await api.createDraft({ discussionId: discussion.id, parentIds: [turn.id], items: [{ id, question: text, sourceIds: [] }] })
    setTexts(value => ({ ...value, [id]: text })); setFollow(null)
    await sendDraft(draft, [id])
  })

  const save = (discussion: DiscussionDTO, turn: TurnDTO, saved: AnswerVersionDTO, target: CaptureTarget) => guard('save' + saved.id, async () => {
    await flush()
    const id = saved.id + '|' + JSON.stringify(target)
    if (!keys.current.has(id)) keys.current.set(id, crypto.randomUUID())
    const result = await api.capture({ requestKey: keys.current.get(id)!, discussionId: discussion.id, turnId: turn.id, answerId: saved.id, target })
    keys.current.delete(id)
    await load()
    if (result.capture.target.kind === 'new') onOpenNote(result.capture.target.notePath)
  })
  const undo = (capture: CaptureDTO) => guard('undo' + capture.id, async () => { await flush(); await api.undoChangeSet(capture.changeSetId!); await load() })
  const showBasis = (id: string) => guard('basis' + id, async () => setBasis(await api.source(id)))

  if (!name) return <aside className="explore-panel"><p className="muted explore-empty">打开一篇笔记，选中一段文字，就可以围绕它提问。</p></aside>
  const sources = view?.sources ?? {}
  const drafts = view?.drafts ?? []
  const noModel = !model

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
        <Button size="sm" isDisabled={!!busy || noModel} onPress={() => void guard('send' + draft.id, () => sendDraft(draft, draft.items.map(item => item.id)))}>{busy === 'send' + draft.id ? '发送中…' : '全部发送'}</Button></div>
      {draft.items.map(item => <div className="explore-item" key={item.id}>
        {item.sourceIds.map(id => sources[id] && <blockquote className="explore-quote" key={id}>{clip(sources[id]!.quote, 120)}</blockquote>)}
        <TextArea aria-label="问题" rows={2} value={texts[item.id] ?? item.question} disabled={!!busy}
          onChange={event => setTexts(value => ({ ...value, [item.id]: event.target.value }))}
          onBlur={() => { const text = texts[item.id]; if (text !== undefined && text !== item.question) void guard('edit' + item.id, async () => { await api.updateDraft(draft.id, draft.revision, draft.items.map(entry => entry.id === item.id ? { ...entry, question: text } : entry)); await load() }) }}/>
        <div className="explore-actions"><Button variant="ghost" size="sm" isDisabled={!!busy} onPress={() => void dropItem(draft, item.id)}>移除</Button></div>
      </div>)}
    </section>)}

    {view?.discussions.map(discussion => <section className="explore-discussion" key={discussion.id} aria-label={'讨论：' + discussion.title}>
      {discussion.turns.map(turn => {
        const answers = turn.answers, index = Math.min(version[turn.id] ?? answers.length - 1, answers.length - 1), shown = answers[index]
        const saved = shown ? view.captures.filter(capture => capture.answers.some(entry => entry.answerId === shown.id)) : []
        return <article className="explore-turn" key={turn.id} data-follow-up={turn.parents.length ? 'true' : undefined}>
          {turn.sourceIds.map(id => sources[id] && <blockquote className="explore-quote" key={id}>{clip(sources[id]!.quote, 160)}<Button variant="ghost" size="sm" isDisabled={!!busy} onPress={() => void showBasis(id)}>查看依据</Button></blockquote>)}
          <p className="explore-question">{turn.question}</p>
          {running[turn.id] && <p className="muted" role="status">正在回答…</p>}
          {failed[turn.id] && <p className="ai-error" role="alert">{failed[turn.id]}</p>}
          {shown && <div className="explore-answer"><NoteMarkdown name={name} onOpenNote={onOpenNote}>{shown.text}</NoteMarkdown></div>}
          {answers.length > 1 && <div className="explore-versions" aria-label="回答版本">
            <Button variant="ghost" size="sm" isDisabled={index === 0} onPress={() => setVersion(value => ({ ...value, [turn.id]: index - 1 }))}>上一版</Button>
            <span className="muted">第 {index + 1} / {answers.length} 版</span>
            <Button variant="ghost" size="sm" isDisabled={index === answers.length - 1} onPress={() => setVersion(value => ({ ...value, [turn.id]: index + 1 }))}>下一版</Button></div>}
          {saved.map(capture => {
            const detail = capture.changeSetId ? changes[capture.changeSetId] : undefined
            return <div className="explore-saved" key={capture.id}>
              <span>{detail?.undone ? '已撤销 · ' : '已保存 · '}{capture.target.kind === 'new' ? '新笔记' : '追加到'}《{title(capture.target.notePath)}》</span>
              <span className="agent-change-actions">
                {capture.target.notePath !== name && !detail?.undone && <Button variant="ghost" size="sm" onPress={() => onOpenNote(capture.target.notePath)}>打开</Button>}
                {detail && !detail.undone && <Button variant="ghost" size="sm" isDisabled={!!busy || !detail.undoable} title={detail.undoable ? undefined : '之后又有修改，撤销会覆盖新内容'} onPress={() => void undo(capture)}>{detail.undoable ? '撤销' : '无法撤销'}</Button>}
              </span></div>
          })}
          <div className="explore-actions">
            {shown && <>
              <Button variant="ghost" size="sm" isDisabled={!!busy} onPress={() => void save(discussion, turn, shown, { kind: 'append', note: name })}>追加到本文</Button>
              <Button variant="ghost" size="sm" isDisabled={!!busy} onPress={() => void save(discussion, turn, shown, { kind: 'new', folder: folderOf(name) })}>存为新笔记</Button></>}
            <Button variant="ghost" size="sm" isDisabled={!!busy || noModel || running[turn.id]} onPress={() => void guard('retry' + turn.id, () => answer(discussion.id, turn))}>{shown ? '重新回答' : '生成回答'}</Button>
            <Button variant="ghost" size="sm" isDisabled={!!busy || noModel || !shown} onPress={() => setFollow(follow?.turn === turn.id ? null : { turn: turn.id, text: '' })}>追问</Button>
          </div>
          {follow?.turn === turn.id && <div className="explore-follow">
            <TextArea aria-label="追问" rows={2} autoFocus value={follow.text} placeholder="基于这条回答继续问" onChange={event => setFollow({ turn: turn.id, text: event.target.value })}/>
            <div className="explore-actions"><Button variant="ghost" size="sm" onPress={() => setFollow(null)}>取消</Button><Button size="sm" isDisabled={!!busy || !follow.text.trim()} onPress={() => void askFollowUp(discussion, turn)}>发送追问</Button></div></div>}
        </article>
      })}
    </section>)}
    {view && !view.discussions.length && !drafts.length && <p className="muted explore-empty">还没有探索记录。选中文字并提问后，回答会保留在这里，可以选择写回笔记。</p>}

    <Dialog title="查看依据" open={!!basis} onClose={() => setBasis(null)}>
      {basis && <><p className="muted">《{title(basis.notePath ?? basis.source.notePath)}》{basis.source.section ? ' · ' + basis.source.section : ''}</p>
        <blockquote className="explore-quote">{basis.source.quote}</blockquote>
        <p className="muted">{statusText[basis.status]}</p>
        {basis.notePath && <Button size="sm" variant="secondary" onPress={() => { onOpenNote(basis.notePath!); setBasis(null) }}>打开笔记</Button>}</>}
    </Dialog>
  </aside>
}
