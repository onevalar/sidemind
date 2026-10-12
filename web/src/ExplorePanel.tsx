import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { AnswerVersionDTO, CaptureDTO, ContextPreviewDTO, ChangeSetDetail, DiscussionDTO, DraftDTO, ResolvedSourceDTO, RunDTO, SourceRefDTO, TurnDTO } from '../shared/types'
import { api, subscribeEvents, subscribeRun, type CaptureTarget, type NoteResearch } from './api'
import { NoteMarkdown } from './NoteMarkdown'
import { Button, Dialog, TextArea } from './ui'

const folderOf = (name: string) => name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : ''
const title = (path: string) => path.split('/').at(-1)!.replace(/\.md$/, '')
const clip = (text: string, max: number) => { const flat = text.replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '').replace(/\s+/g, ' ').trim(); return flat.length > max ? flat.slice(0, max) + '…' : flat }
const statusText: Record<ResolvedSourceDTO['status'], string> = {
  current: '与笔记当前内容一致。', moved: '笔记已修改，这段文字仍能在原文中唯一找到。', ambiguous: '笔记已修改，这段文字现在出现多次，无法确定位置；以下是当时的依据。',
  missing: '笔记已修改，原文中找不到这段文字；以下是当时的依据。', 'note-deleted': '来源笔记已删除；以下是当时保存的依据。',
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

/** Explore a note: ask about selected passages, compare answers, write one back, and trace it to its basis. */
export function ExplorePanel({ name, model, active, beforeSend, selection, reveal, onConfigure, onOpenNote }: {
  name: string | null; model: string | null; active: boolean; beforeSend: MutableRefObject<() => Promise<boolean>>
  selection: MutableRefObject<() => string | undefined>; reveal: MutableRefObject<(quote: string, start: number | null) => boolean>; onConfigure: () => void; onOpenNote: (name: string) => void
}) {
  const [view, setView] = useState<NoteResearch | null>(null)
  const [changes, setChanges] = useState<Record<string, ChangeSetDetail>>({})
  const [error, setError] = useState('')
  const [quote, setQuote] = useState('')
  const [question, setQuestion] = useState('')
  const [texts, setTexts] = useState<Record<string, string>>({})
  const [runs, setRuns] = useState<Record<string, RunDTO>>({})
  const followed = useRef(new Map<string, () => void>())
  const [busy, setBusy] = useState<string | null>(null)
  const [followUp, setFollowUp] = useState<{ turn: string; text: string } | null>(null)
  const [version, setVersion] = useState<Record<string, number>>({})
  const [basis, setBasis] = useState<ResolvedSourceDTO | null>(null)
  const [picked, setPicked] = useState<{ discussion: string; turns: string[] }>({ discussion: '', turns: [] })
  const [compareText, setCompareText] = useState('比较这几条分支的回答。')
  const [preview, setPreview] = useState<ContextPreviewDTO | null>(null)
  const keys = useRef(new Map<string, string>())
  const current = useRef(name)
  current.current = name

  /** Show a run's progress. It keeps going on the server whether or not this panel is open. */
  const followRun = useRef<(run: RunDTO) => void>(() => {})
  const follow = (run: RunDTO) => followRun.current(run)
  const load = useCallback(async () => {
    if (!name) { setView(null); return }
    try {
      const next = await api.researchNote(name)
      if (current.current !== name) return
      setView(next)
      for (const run of next.runs) { setRuns(value => (value[run.turnId]?.seq ?? -1) >= run.seq ? value : { ...value, [run.turnId]: run }); if (run.status === 'queued' || run.status === 'running') follow(run) }
      setTexts(previous => { const merged = { ...previous }; for (const draft of next.drafts) for (const item of draft.items) merged[item.id] ??= item.question; return merged })
      const details = await Promise.all(next.captures.filter(capture => capture.changeSetId).map(capture => api.changeSet(capture.changeSetId!).catch(() => null)))
      if (current.current === name) setChanges(Object.fromEntries(details.filter((detail): detail is ChangeSetDetail => !!detail).map(detail => [detail.id, detail])))
    } catch (failure) { if (current.current === name) setError('无法读取探索记录：' + message(failure)) }
  }, [name])
  useEffect(() => { setView(null); setError(''); setQuote(''); setFollowUp(null); void load() }, [load])
  useEffect(() => () => { for (const stop of followed.current.values()) stop(); followed.current.clear() }, [name])
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

  followRun.current = (run: RunDTO) => {
    if (followed.current.has(run.id)) return
    const close = subscribeRun(run.id, latest => {
      setRuns(value => ({ ...value, [latest.turnId]: latest }))
      if (!['queued', 'running'].includes(latest.status)) { followed.current.get(latest.id)?.(); followed.current.delete(latest.id); void load() }
    }, () => { followed.current.delete(run.id); setError('与回答的连接中断，正在重新读取。') ; void load() })
    followed.current.set(run.id, close)
  }
  const answer = async (discussionId: string, turn: TurnDTO) => {
    const run = await api.startRun(discussionId, turn.id, crypto.randomUUID())
    setRuns(value => ({ ...value, [turn.id]: run }))
    follow(run)
  }
  const sendDraft = async (draft: DraftDTO, ids: string[]) => {
    const items = ids.map(id => ({ id, question: (texts[id] ?? draft.items.find(item => item.id === id)!.question).trim() }))
    if (items.some(item => !item.question)) throw new Error('请先写下问题。')
    const sent = await api.sendDraft(draft.id, items)
    setTexts(value => { const rest = { ...value }; for (const item of sent.draft.items) rest[item.id] ??= item.question; for (const id of ids) if (!sent.draft.items.some(item => item.id === id)) delete rest[id]; return rest })
    await load()
    // Runs live on the server: start them all and keep writing while they stream in.
    await Promise.all(sent.turns.map(turn => answer(sent.discussion.id, turn).catch(failure => setError(message(failure)))))
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
    const text = followUp?.text.trim()
    if (!text) throw new Error('请先写下追问。')
    const id = crypto.randomUUID()
    const draft = await api.createDraft({ discussionId: discussion.id, parentIds: [turn.id], items: [{ id, question: text, sourceIds: [] }] })
    setTexts(value => ({ ...value, [id]: text })); setFollowUp(null)
    await sendDraft(draft, [id])
  })

  /** Choose answers to compare: only within one discussion, and a shared ancestor is sent once. */
  const toggle = (discussion: DiscussionDTO, turn: TurnDTO) => setPicked(current => {
    const turns = current.discussion === discussion.id ? current.turns : []
    return { discussion: discussion.id, turns: turns.includes(turn.id) ? turns.filter(id => id !== turn.id) : [...turns, turn.id] }
  })
  const compare = (discussion: DiscussionDTO) => guard('compare' + discussion.id, async () => {
    const text = compareText.trim()
    if (picked.turns.length < 2 || !text) throw new Error('请选择至少两条回答，并写下比较的问题。')
    const id = crypto.randomUUID()
    const draft = await api.createDraft({ discussionId: discussion.id, parentIds: picked.turns, items: [{ id, question: text, sourceIds: [] }] })
    setTexts(value => ({ ...value, [id]: text })); setPicked({ discussion: '', turns: [] })
    await sendDraft(draft, [id])
  })
  const showContext = (discussion: DiscussionDTO, turn: TurnDTO) => guard('context' + turn.id, async () => setPreview(await api.context(discussion.id, turn.id)))

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
  /** Jump to the passage in the open note; when it cannot be placed, show the saved evidence instead. */
  const locate = (id: string) => guard('locate' + id, async () => {
    const resolved = await api.source(id)
    if (resolved.notePath && resolved.notePath !== name) { onOpenNote(resolved.notePath); return }
    if ((resolved.status === 'current' || resolved.status === 'moved') && reveal.current(resolved.source.quote, resolved.start)) return
    setBasis(resolved)
  })

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

    {view?.discussions.map(discussion => {
      const depth = new Map<string, number>(), byId = new Map(discussion.turns.map(turn => [turn.id, turn]))
      const depthOf = (turn: TurnDTO): number => { if (!depth.has(turn.id)) depth.set(turn.id, turn.parents.length ? 1 + Math.max(...turn.parents.map(id => depthOf(byId.get(id)!))) : 0); return depth.get(turn.id)! }
      const choosing = picked.discussion === discussion.id ? picked.turns : []
      return <section className="explore-discussion" key={discussion.id} aria-label={'讨论：' + discussion.title}>
      {discussion.turns.map(turn => {
        const answers = turn.answers, index = Math.min(version[turn.id] ?? answers.length - 1, answers.length - 1), shown = answers[index]
        const live = runs[turn.id], active = !!live && (live.status === 'queued' || live.status === 'running')
        const finishedBad = !!live && ['failed', 'cancelled', 'interrupted'].includes(live.status)
        const saved = shown ? view.captures.filter(capture => capture.answers.some(entry => entry.answerId === shown.id)) : []
        return <article className="explore-turn" key={turn.id} data-follow-up={turn.parents.length ? 'true' : undefined} style={{ marginLeft: Math.min(depthOf(turn), 3) * 14 }}>
          {turn.parents.length > 1 && <p className="muted explore-merge">合并比较 · 来自 {turn.parents.length} 条分支</p>}
          {turn.sourceIds.map(id => sources[id] && <blockquote className="explore-quote" key={id}>{clip(sources[id]!.quote, 160)}<span className="explore-quote-actions"><Button variant="ghost" size="sm" isDisabled={!!busy} onPress={() => void locate(id)}>在原文中定位</Button><Button variant="ghost" size="sm" isDisabled={!!busy} onPress={() => void showBasis(id)}>查看依据</Button></span></blockquote>)}
          <p className="explore-question">{turn.question}</p>
          {(active || finishedBad) && live && <div className="explore-run" aria-live="polite">
            {(live.status === 'queued' || live.status === 'running') && <div className="explore-run-head"><span className="muted" role="status">{live.text ? '正在回答…' : '正在准备回答…'}</span><Button variant="ghost" size="sm" onPress={() => void api.stopRun(live.id).catch(failure => setError(message(failure)))}>停止</Button></div>}
            {live.text && <div className="explore-answer" data-partial={finishedBad ? 'true' : undefined}><NoteMarkdown name={name} onOpenNote={onOpenNote}>{live.text}</NoteMarkdown></div>}
            {finishedBad && (live.status === 'cancelled' ? <p className="muted" role="status">{live.error}</p> : <p className="ai-error" role="alert">{live.error}</p>)}</div>}
          {shown && !active && <div className="explore-answer"><NoteMarkdown name={name} onOpenNote={onOpenNote}>{shown.text}</NoteMarkdown></div>}
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
            {!active && <Button variant="ghost" size="sm" isDisabled={!!busy || noModel} onPress={() => void guard('retry' + turn.id, () => answer(discussion.id, turn))}>{shown ? '重新回答' : finishedBad ? '重试' : '生成回答'}</Button>}
            {shown && <Button variant="ghost" size="sm" aria-pressed={choosing.includes(turn.id)} isDisabled={!!busy} onPress={() => toggle(discussion, turn)}>{choosing.includes(turn.id) ? '已选 · 取消' : '选择比较'}</Button>}
            <Button variant="ghost" size="sm" isDisabled={!!busy} onPress={() => void showContext(discussion, turn)}>查看上下文</Button>
            <Button variant="ghost" size="sm" isDisabled={!!busy || noModel || !shown} onPress={() => setFollowUp(followUp?.turn === turn.id ? null : { turn: turn.id, text: '' })}>追问</Button>
          </div>
          {followUp?.turn === turn.id && <div className="explore-follow">
            <TextArea aria-label="追问" rows={2} autoFocus value={followUp.text} placeholder="基于这条回答继续问" onChange={event => setFollowUp({ turn: turn.id, text: event.target.value })}/>
            <div className="explore-actions"><Button variant="ghost" size="sm" onPress={() => setFollowUp(null)}>取消</Button><Button size="sm" isDisabled={!!busy || !followUp.text.trim()} onPress={() => void askFollowUp(discussion, turn)}>发送追问</Button></div></div>}
        </article>
      })}
      {choosing.length >= 2 && <div className="explore-compare" role="group" aria-label="比较所选回答">
        <p className="muted">已选 {choosing.length} 条回答。比较会保留各分支，不会把它们合并掉。</p>
        <TextArea aria-label="比较的问题" rows={2} value={compareText} onChange={event => setCompareText(event.target.value)}/>
        <div className="explore-actions"><Button variant="ghost" size="sm" onPress={() => setPicked({ discussion: '', turns: [] })}>取消</Button><Button size="sm" isDisabled={!!busy || noModel || !compareText.trim()} onPress={() => void compare(discussion)}>发送比较</Button></div></div>}
    </section> })}
    {view && !view.discussions.length && !drafts.length && <p className="muted explore-empty">还没有探索记录。选中文字并提问后，回答会保留在这里，可以选择写回笔记。</p>}

 <Dialog title="发送给模型的上下文" open={!!preview} onClose={() => setPreview(null)}>
      {preview && <><p className={preview.exceeded ? 'ai-error' : 'muted'}>约 {preview.estimatedTokens} / {preview.budget} 单位（粗略估计，不同模型的计数不同）。{preview.exceeded ? '超出上限，发送会被拒绝：请缩小选区或减少分支。' : '这就是发送时的全部内容；未选中的分支和笔记其他部分都不在其中。'}</p>
        <div className="explore-context">{preview.messages.map((message, index) => <section key={index}><h4>{{ system: '指令', user: '提问与原文', assistant: '先前的回答' }[message.role]}</h4><pre>{message.content}</pre></section>)}</div></>}
    </Dialog>
    <Dialog title="查看依据" open={!!basis} onClose={() => setBasis(null)}>
      {basis && <><p className="muted">《{title(basis.notePath ?? basis.source.notePath)}》{basis.source.section ? ' · ' + basis.source.section : ''}</p>
        <blockquote className="explore-quote">{basis.source.quote}</blockquote>
        <p className="muted">{statusText[basis.status]}</p>
        {basis.notePath && <Button size="sm" variant="secondary" onPress={() => { onOpenNote(basis.notePath!); setBasis(null) }}>打开笔记</Button>}</>}
    </Dialog>
  </aside>
}
