import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { AnswerVersionDTO, CaptureDTO, ChangeSetDetail, ContextPreviewDTO, DiscussionDTO, DraftDTO, ResolvedSourceDTO, RunDTO, SourceRefDTO, TurnDTO } from '../shared/types'
import { api, subscribeRun, type CaptureTarget } from './api'
import { NoteMarkdown } from './NoteMarkdown'
import { WriteBackDialog, type WriteBackSubject } from './WriteBackDialog'
import { Button, Dialog, TextArea } from './ui'

export const title = (path: string) => path.split('/').at(-1)!.replace(/\.md$/, '')
export const folderOf = (name: string) => name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : ''
export const clip = (text: string, max: number) => { const flat = text.replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '').replace(/\s+/g, ' ').trim(); return flat.length > max ? flat.slice(0, max) + '…' : flat }
export const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const statusText: Record<ResolvedSourceDTO['status'], string> = {
  current: '与笔记当前内容一致。', moved: '笔记已修改，这段文字仍能在原文中唯一找到。', ambiguous: '笔记已修改，这段文字现在出现多次，无法确定位置；以下是当时的依据。',
  missing: '笔记已修改，原文中找不到这段文字；以下是当时的依据。', 'note-deleted': '来源笔记已删除；以下是当时保存的依据。',
}

export interface DiscussionKitOptions {
  /** Re-reads whatever the host shows; called after anything changed on the server. */
  reload: () => Promise<void>
  beforeSend: MutableRefObject<() => Promise<boolean>>
  onOpenNote: (name: string) => void
  reveal?: MutableRefObject<(quote: string, start: number | null) => boolean>
  /** Changing this stops following runs and clears per-view state (a different note or conversation). */
  scope: string | null
}

/**
 * State and actions shared by every view of a discussion: following server-side runs, sending drafts, branching,
 * comparing, writing an answer back and tracing it to its basis. The host decides what is loaded and where it is shown.
 */
export function useDiscussionKit(options: DiscussionKitOptions) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [texts, setTexts] = useState<Record<string, string>>({})
  const [runs, setRuns] = useState<Record<string, RunDTO>>({})
  const [followUp, setFollowUp] = useState<{ turn: string; text: string } | null>(null)
  const [version, setVersion] = useState<Record<string, number>>({})
  const [basis, setBasis] = useState<ResolvedSourceDTO | null>(null)
  const [picked, setPicked] = useState<{ discussion: string; turns: string[] }>({ discussion: '', turns: [] })
  const [compareText, setCompareText] = useState('比较这几条分支的回答。')
  const [preview, setPreview] = useState<ContextPreviewDTO | null>(null)
  const [writing, setWriting] = useState<WriteBackSubject | null>(null)
  const followed = useRef(new Map<string, () => void>())
  const keys = useRef(new Map<string, string>())
  const latest = useRef(options)
  latest.current = options

  useEffect(() => { setFollowUp(null); setPicked({ discussion: '', turns: [] }); return () => { for (const stop of followed.current.values()) stop(); followed.current.clear() } }, [options.scope])

  const reload = () => latest.current.reload()
  /** Show a run's progress. It keeps going on the server whether or not this view is open. */
  const follow = (run: RunDTO) => {
    if (followed.current.has(run.id)) return
    const close = subscribeRun(run.id, current => {
      setRuns(value => ({ ...value, [current.turnId]: current }))
      if (!['queued', 'running'].includes(current.status)) { followed.current.get(current.id)?.(); followed.current.delete(current.id); void reload() }
    }, () => { followed.current.delete(run.id); setError('与回答的连接中断，正在重新读取。'); void reload() })
    followed.current.set(run.id, close)
  }
  /** Adopt runs the server reports as unfinished (after a load or a reconnect). */
  const adopt = (unfinished: RunDTO[]) => {
    for (const run of unfinished) { setRuns(value => (value[run.turnId]?.seq ?? -1) >= run.seq ? value : { ...value, [run.turnId]: run }); if (run.status === 'queued' || run.status === 'running') follow(run) }
  }
  /** Remember the text of drafts already on the server without overwriting what is being typed. */
  const adoptDrafts = (drafts: DraftDTO[]) => setTexts(previous => { const merged = { ...previous }; for (const draft of drafts) for (const item of draft.items) merged[item.id] ??= item.question; return merged })

  const guard = async (id: string, action: () => Promise<void>) => {
    if (busy) return
    setBusy(id); setError('')
    try { await action() } catch (failure) { setError(message(failure)) } finally { setBusy(null) }
  }
  const flush = async () => { if (!await latest.current.beforeSend.current()) throw new Error('请先处理未保存的修改，再继续。') }

  const answer = async (discussionId: string, turn: TurnDTO) => {
    const run = await api.startRun(discussionId, turn.id, crypto.randomUUID())
    setRuns(value => ({ ...value, [turn.id]: run }))
    follow(run)
  }
  const sendDraft = async (draft: Pick<DraftDTO, 'id' | 'items'>, ids: string[]) => {
    const items = ids.map(id => ({ id, question: (texts[id] ?? draft.items.find(item => item.id === id)!.question).trim() }))
    if (items.some(item => !item.question)) throw new Error('请先写下问题。')
    const sent = await api.sendDraft(draft.id, items)
    setTexts(value => { const rest = { ...value }; for (const item of sent.draft.items) rest[item.id] ??= item.question; for (const id of ids) if (!sent.draft.items.some(item => item.id === id)) delete rest[id]; return rest })
    await reload()
    // Runs live on the server: start them all and keep writing while they stream in.
    await Promise.all(sent.turns.map(turn => answer(sent.discussion.id, turn).catch(failure => setError(message(failure)))))
    return sent
  }
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
    await reload()
    if (result.capture.target.kind === 'new') latest.current.onOpenNote(result.capture.target.notePath)
  })
  const undo = (capture: CaptureDTO) => guard('undo' + capture.id, async () => { await flush(); await api.undoChangeSet(capture.changeSetId!); await reload() })
  const showBasis = (id: string) => guard('basis' + id, async () => setBasis(await api.source(id)))
  /** Jump to the passage in the open note; when it cannot be placed, show the saved evidence instead. */
  const locate = (id: string, openNote: string | null) => guard('locate' + id, async () => {
    const resolved = await api.source(id)
    if (resolved.notePath && resolved.notePath !== openNote) { latest.current.onOpenNote(resolved.notePath); return }
    if ((resolved.status === 'current' || resolved.status === 'moved') && latest.current.reveal?.current(resolved.source.quote, resolved.start)) return
    setBasis(resolved)
  })

  return {
    error, setError, busy, guard, flush, texts, setTexts, runs, setRuns, followUp, setFollowUp, version, setVersion, picked, setPicked, compareText, setCompareText,
    writing, setWriting, preview, setPreview, basis, setBasis, follow, adopt, adoptDrafts, answer, sendDraft, askFollowUp, toggle, compare, showContext, save, undo, showBasis, locate,
    reload, onOpenNote: (name: string) => latest.current.onOpenNote(name),
  }
}
export type DiscussionKit = ReturnType<typeof useDiscussionKit>

/** The questions and answers of one discussion, indented by branch depth, with every per-answer action. */
export function DiscussionThread({ kit, discussion, sources, captures, changes, model, noteName, appendTo, appendLabel, newFolder, notes }: {
  kit: DiscussionKit; discussion: DiscussionDTO; sources: Record<string, SourceRefDTO>; captures: CaptureDTO[]; changes: Record<string, ChangeSetDetail>
  model: string | null
  /** The note open in the editor, if any: relative links in answers resolve against it and quotes from it can be located there. */
  noteName: string | null
  /** Where "append" writes; null hides the action. */
  appendTo: string | null
  /** How to name the append target on its button; defaults to its file name. */
  appendLabel?: string
  /** Folder for "save as new note". */
  newFolder: string
  /** Notes the write dialog may append to. Defaults to just `appendTo`. */
  notes?: { name: string; title: string }[]
}) {
  const { busy, runs, followUp, setFollowUp, version, setVersion, picked, compareText, setCompareText } = kit
  const noModel = !model
  const depth = new Map<string, number>(), byId = new Map(discussion.turns.map(turn => [turn.id, turn]))
  const depthOf = (turn: TurnDTO): number => { if (!depth.has(turn.id)) depth.set(turn.id, turn.parents.length ? 1 + Math.max(...turn.parents.map(id => depthOf(byId.get(id)!))) : 0); return depth.get(turn.id)! }
  const choosing = picked.discussion === discussion.id ? picked.turns : []
  const base = noteName ?? ''
  return <section className="explore-discussion" aria-label={'讨论：' + discussion.title}>
    {discussion.turns.map(turn => {
      const answers = turn.answers, index = Math.min(version[turn.id] ?? answers.length - 1, answers.length - 1), shown = answers[index]
      const live = runs[turn.id], active = !!live && (live.status === 'queued' || live.status === 'running')
      const finishedBad = !!live && ['failed', 'cancelled', 'interrupted'].includes(live.status)
      const saved = shown ? captures.filter(capture => capture.answers.some(entry => entry.answerId === shown.id)) : []
      return <article className="explore-turn" key={turn.id} data-follow-up={turn.parents.length ? 'true' : undefined} style={{ marginLeft: Math.min(depthOf(turn), 3) * 14 }}>
        {turn.parents.length > 1 && <p className="muted explore-merge">合并比较 · 来自 {turn.parents.length} 条分支</p>}
        {turn.sourceIds.map(id => sources[id] && <blockquote className="explore-quote" key={id}>{clip(sources[id]!.quote, 160)}<span className="explore-quote-actions">
          {noteName !== null && <Button variant="ghost" size="sm" isDisabled={!!busy} onPress={() => void kit.locate(id, noteName)}>在原文中定位</Button>}
          {noteName === null && <Button variant="ghost" size="sm" isDisabled={!!busy} onPress={() => void kit.locate(id, null)}>打开原文</Button>}
          <Button variant="ghost" size="sm" isDisabled={!!busy} onPress={() => void kit.showBasis(id)}>查看依据</Button></span></blockquote>)}
        <p className="explore-question">{turn.question}</p>
        {(active || finishedBad) && live && <div className="explore-run" aria-live="polite">
          {(live.status === 'queued' || live.status === 'running') && <div className="explore-run-head"><span className="muted" role="status">{live.text ? '正在回答…' : '正在准备回答…'}</span><Button variant="ghost" size="sm" onPress={() => void api.stopRun(live.id).catch(failure => kit.setError(message(failure)))}>停止</Button></div>}
          {live.text && <div className="explore-answer" data-partial={finishedBad ? 'true' : undefined}><NoteMarkdown name={base} onOpenNote={kit.onOpenNote}>{live.text}</NoteMarkdown></div>}
          {finishedBad && (live.status === 'cancelled' ? <p className="muted" role="status">{live.error}</p> : <p className="ai-error" role="alert">{live.error}</p>)}</div>}
        {shown && !active && <div className="explore-answer"><NoteMarkdown name={base} onOpenNote={kit.onOpenNote}>{shown.text}</NoteMarkdown></div>}
        {answers.length > 1 && <div className="explore-versions" aria-label="回答版本">
          <Button variant="ghost" size="sm" isDisabled={index === 0} onPress={() => setVersion(value => ({ ...value, [turn.id]: index - 1 }))}>上一版</Button>
          <span className="muted">第 {index + 1} / {answers.length} 版</span>
          <Button variant="ghost" size="sm" isDisabled={index === answers.length - 1} onPress={() => setVersion(value => ({ ...value, [turn.id]: index + 1 }))}>下一版</Button></div>}
        {saved.map(capture => {
          const detail = capture.changeSetId ? changes[capture.changeSetId] : undefined
          return <div className="explore-saved" key={capture.id}>
            <span>{detail?.undone ? '已撤销 · ' : '已保存 · '}{capture.mode === 'organized' ? '整理后 · ' : ''}{{ new: '新笔记', append: '追加到', replace: '替换了' }[capture.target.kind]}《{title(capture.target.notePath)}》{capture.target.kind === 'replace' ? '中的片段' : ''}</span>
            <span className="agent-change-actions">
              {capture.target.notePath !== noteName && !detail?.undone && <Button variant="ghost" size="sm" onPress={() => kit.onOpenNote(capture.target.notePath)}>打开</Button>}
              {detail && !detail.undone && <Button variant="ghost" size="sm" isDisabled={!!busy || !detail.undoable} title={detail.undoable ? undefined : '之后又有修改，撤销会覆盖新内容'} onPress={() => void kit.undo(capture)}>{detail.undoable ? '撤销' : '无法撤销'}</Button>}
            </span></div>
        })}
        <div className="explore-actions">
          {shown && <>
            {appendTo && <Button variant="ghost" size="sm" isDisabled={!!busy} onPress={() => void kit.save(discussion, turn, shown, { kind: 'append', note: appendTo })}>{noteName !== null && appendTo === noteName ? '追加到本文' : `追加到《${appendLabel ?? title(appendTo)}》`}</Button>}
            <Button variant="ghost" size="sm" isDisabled={!!busy} onPress={() => void kit.save(discussion, turn, shown, { kind: 'new', folder: newFolder })}>存为新笔记</Button>
            <Button variant="ghost" size="sm" isDisabled={!!busy} onPress={() => kit.setWriting({ discussion, turn, answer: shown, sources, notes: notes ?? (appendTo ? [{ name: appendTo, title: appendLabel ?? title(appendTo) }] : []), defaultNote: appendTo, newFolder })}>写入…</Button></>}
          {!active && <Button variant="ghost" size="sm" isDisabled={!!busy || noModel} onPress={() => void kit.guard('retry' + turn.id, () => kit.answer(discussion.id, turn))}>{shown ? '重新回答' : finishedBad ? '重试' : '生成回答'}</Button>}
          {shown && <Button variant="ghost" size="sm" aria-pressed={choosing.includes(turn.id)} isDisabled={!!busy} onPress={() => kit.toggle(discussion, turn)}>{choosing.includes(turn.id) ? '已选 · 取消' : '选择比较'}</Button>}
          <Button variant="ghost" size="sm" isDisabled={!!busy} onPress={() => void kit.showContext(discussion, turn)}>查看上下文</Button>
          <Button variant="ghost" size="sm" isDisabled={!!busy || noModel || !shown} onPress={() => setFollowUp(followUp?.turn === turn.id ? null : { turn: turn.id, text: '' })}>追问</Button>
        </div>
        {followUp?.turn === turn.id && <div className="explore-follow">
          <TextArea aria-label="追问" rows={2} autoFocus value={followUp.text} placeholder="基于这条回答继续问"
            onChange={event => setFollowUp({ turn: turn.id, text: event.target.value })}
            onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void kit.askFollowUp(discussion, turn) } }}/>
          <div className="explore-actions"><Button variant="ghost" size="sm" onPress={() => setFollowUp(null)}>取消</Button><Button size="sm" isDisabled={!!busy || !followUp.text.trim()} onPress={() => void kit.askFollowUp(discussion, turn)}>发送追问</Button></div></div>}
      </article>
    })}
    {choosing.length >= 2 && <div className="explore-compare" role="group" aria-label="比较所选回答">
      <p className="muted">已选 {choosing.length} 条回答。比较会保留各分支，不会把它们合并掉。</p>
      <TextArea aria-label="比较的问题" rows={2} value={compareText} onChange={event => setCompareText(event.target.value)}/>
      <div className="explore-actions"><Button variant="ghost" size="sm" onPress={() => kit.setPicked({ discussion: '', turns: [] })}>取消</Button><Button size="sm" isDisabled={!!busy || noModel || !compareText.trim()} onPress={() => void kit.compare(discussion)}>发送比较</Button></div></div>}
  </section>
}

export function DiscussionDialogs({ kit }: { kit: DiscussionKit }) {
  const { preview, setPreview, basis, setBasis, writing, setWriting } = kit
  return <>
    {writing && <WriteBackDialog key={writing.answer.id} subject={writing} onClose={() => setWriting(null)} onSaved={saved => { setWriting(null); void kit.reload(); if (saved.kind === 'new') kit.onOpenNote(saved.notePath) }}/>}
    <Dialog title="发送给模型的上下文" open={!!preview} onClose={() => setPreview(null)}>
      {preview && <><p className={preview.exceeded ? 'ai-error' : 'muted'}>约 {preview.estimatedTokens} / {preview.budget} 单位（粗略估计，不同模型的计数不同）。{preview.exceeded ? '超出上限，发送会被拒绝：请缩小选区或减少分支。' : '这就是发送时的全部内容；未选中的分支和笔记其他部分都不在其中。'}</p>
        <div className="explore-context">{preview.messages.map((entry, index) => <section key={index}><h4>{{ system: '指令', user: '提问与原文', assistant: '先前的回答' }[entry.role]}</h4><pre>{entry.content}</pre></section>)}</div></>}
    </Dialog>
    <Dialog title="查看依据" open={!!basis} onClose={() => setBasis(null)}>
      {basis && <><p className="muted">《{title(basis.notePath ?? basis.source.notePath)}》{basis.source.section ? ' · ' + basis.source.section : ''}</p>
        <blockquote className="explore-quote">{basis.source.quote}</blockquote>
        <p className="muted">{statusText[basis.status]}</p>
        {basis.notePath && <Button size="sm" variant="secondary" onPress={() => { kit.onOpenNote(basis.notePath!); setBasis(null) }}>打开笔记</Button>}</>}
    </Dialog>
  </>
}
