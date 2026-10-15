import { useEffect, useRef, useState } from 'react'
import type { AnswerVersionDTO, DiscussionDTO, SourceRefDTO, TurnDTO } from '../shared/types'
import { api, type CapturePreview, type CaptureRequest, type CaptureTarget } from './api'
import { ModificationPreview } from './ModificationPreview'
import { Button, Dialog, SegmentedControl, Select, TextArea } from './ui'

export interface WriteBackSubject {
  discussion: DiscussionDTO; turn: TurnDTO; answer: AnswerVersionDTO
  /** More answers compared with this one; present means one organized write for all of them. */
  extra?: { discussion: DiscussionDTO; turn: TurnDTO; answer: AnswerVersionDTO }[]
  sources: Record<string, SourceRefDTO>
  /** Notes an answer can be appended to; the first is preselected. */
  notes: { name: string; title: string }[]
  defaultNote: string | null
  newFolder: string
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const clip = (text: string, max: number) => { const flat = text.replace(/\s+/g, ' ').trim(); return flat.length > max ? flat.slice(0, max) + '…' : flat }

/**
 * Write one answer into a note, with a choice the user can see: copy it as it is or have it organized first (and edit
 * the result), append / create / replace the passage it answers, and a difference to confirm before anything is written.
 */
export function WriteBackDialog({ subject, onClose, onSaved }: { subject: WriteBackSubject; onClose: () => void; onSaved: (target: { kind: 'new' | 'append' | 'replace'; notePath: string }) => void }) {
  const { discussion, turn, answer, sources } = subject
  const many = !!subject.extra?.length
  const refs = [{ discussion, turn, answer }, ...(subject.extra ?? [])].map(entry => ({ discussionId: entry.discussion.id, turnId: entry.turn.id, answerId: entry.answer.id }))
  const cited = many ? [] : turn.sourceIds.filter(id => sources[id])
  const [mode, setMode] = useState<'verbatim' | 'organized'>(many ? 'organized' : 'verbatim')
  const [organized, setOrganized] = useState('')
  const [kind, setKind] = useState<CaptureTarget['kind']>('append')
  const [note, setNote] = useState(subject.defaultNote ?? subject.notes[0]?.name ?? '')
  const [sourceId, setSourceId] = useState(cited[0] ?? '')
  const [preview, setPreview] = useState<CapturePreview | null>(null)
  const [busy, setBusy] = useState<'organize' | 'preview' | 'save' | null>(null)
  const [error, setError] = useState('')
  const key = useRef<{ signature: string; id: string } | null>(null)
  const diff = useRef<HTMLElement>(null)
  // The difference is the thing to check before confirming; bring it into view when it appears.
  useEffect(() => { if (preview) diff.current?.scrollIntoView({ block: 'nearest' }) }, [preview])

  const target = (): CaptureTarget | null => kind === 'append' ? note ? { kind, note } : null : kind === 'replace' ? sourceId ? { kind, sourceId } : null : { kind, folder: subject.newFolder }
  const request = (): CaptureRequest | null => {
    const chosen = target()
    if (!chosen) return null
    const text = mode === 'organized' ? { text: organized } : {}
    return many ? { answers: refs, target: chosen, mode, ...text } : { discussionId: discussion.id, turnId: turn.id, answerId: answer.id, target: chosen, mode, ...text }
  }
  /** Any change to what would be written invalidates the shown difference. */
  const change = <T,>(set: (value: T) => void) => (value: T) => { set(value); setPreview(null); setError('') }
  const run = async (what: NonNullable<typeof busy>, action: () => Promise<void>) => {
    if (busy) return
    setBusy(what); setError('')
    try { await action() } catch (failure) { setError(message(failure)) } finally { setBusy(null) }
  }
  const organize = () => run('organize', async () => { setOrganized((await api.organize(many ? { answers: refs } : { discussionId: discussion.id, turnId: turn.id, answerId: answer.id })).text); setPreview(null) })
  const show = () => run('preview', async () => { const input = request(); if (!input) throw new Error('请先选择写入的位置。'); setPreview(await api.capturePreview(input)) })
  const confirm = () => run('save', async () => {
    const input = request()
    if (!input || !preview) return
    // A retry of the same write (e.g. after a lost response) reuses its key, so it can only ever write once.
    const signature = JSON.stringify([input, preview.expectedVersion])
    if (key.current?.signature !== signature) key.current = { signature, id: crypto.randomUUID() }
    try {
      const result = await api.capture({ ...input, requestKey: key.current.id, expectedVersion: preview.expectedVersion })
      onSaved({ kind: result.capture.target.kind, notePath: result.capture.target.notePath })
    } catch (failure) {
      // The note moved on after the preview: show a fresh difference instead of leaving a stale one on screen.
      if (/预览之后被修改/.test(message(failure))) setPreview(null)
      throw failure
    }
  })

  const organizedReady = mode === 'verbatim' || !!organized.trim()
  const targetOptions = [
    { value: 'append', label: '追加到笔记末尾' },
    { value: 'new', label: '存为新笔记' },
    ...(cited.length ? [{ value: 'replace', label: '替换它所依据的原文片段' }] : []),
  ]
  return <Dialog title="写入笔记" open onClose={() => { if (!busy) onClose() }} className="write-dialog"
    footer={<><Button variant="ghost" isDisabled={!!busy} onPress={onClose}>取消</Button>
      {preview ? <Button isDisabled={!!busy} onPress={() => void confirm()}>{busy === 'save' ? '正在写入…' : '确认写入'}</Button>
        : <Button isDisabled={!!busy || !organizedReady || !target()} onPress={() => void show()}>{busy === 'preview' ? '正在生成差异…' : '预览差异'}</Button>}</>}>
    <div className="write-body">
      <section className="write-field" aria-label="写入的内容">
        <h4>写入的内容</h4>
        {many ? <p className="muted">将把所选的 {refs.length} 条回答一起整理成共识、分歧、成立条件和待验证问题；各分支保持各自的结论，不会被混成一个观点。</p> : <SegmentedControl label="写入的内容" value={mode} onValueChange={value => change(setMode)(value as typeof mode)} options={[{ value: 'verbatim', label: '原样' }, { value: 'organized', label: '整理后' }]}/>}
        {mode === 'verbatim' ? <p className="muted">回答原文，不经过模型改写：<br/>{clip(answer.text, 140)}</p> : <>
          <p className="muted">{many ? '整理结果不会自动写入，你可以先修改。' : '让模型把这条回答（连同它的依据）整理成适合放进笔记的文字。整理结果不会自动写入，你可以先修改。'}</p>
          <TextArea aria-label="整理后的文字" rows={7} value={organized} placeholder="点击“生成整理结果”" disabled={busy === 'organize'} onChange={event => change(setOrganized)(event.target.value)}/>
          <div className="explore-actions"><Button variant="ghost" size="sm" isDisabled={!!busy} onPress={() => void organize()}>{busy === 'organize' ? '正在整理…' : organized ? '重新整理' : '生成整理结果'}</Button></div></>}
      </section>
      <section className="write-field" aria-label="写入的位置">
        <h4>写入的位置</h4>
        <Select id="write-kind" label="方式" value={kind} onValueChange={value => change(setKind)(value as typeof kind)} options={targetOptions}/>
        {kind === 'append' && <Select id="write-note" label="笔记" value={note} onValueChange={change(setNote)} options={subject.notes.map(item => ({ value: item.name, label: item.title }))}/>}
        {kind === 'replace' && <>
          {cited.length > 1 && <Select id="write-source" label="要替换的片段" value={sourceId} onValueChange={change(setSourceId)} options={cited.map(id => ({ value: id, label: clip(sources[id]!.quote, 40) }))}/>}
          <blockquote className="explore-quote">{clip(sources[sourceId]?.quote ?? '', 200)}</blockquote>
          <p className="muted">只替换这一段原文；如果笔记已修改到无法确定位置，会拒绝写入。</p></>}
        {kind === 'new' && <p className="muted">会在{subject.newFolder ? '「' + subject.newFolder + '」' : '笔记文件夹'}新建一篇笔记，并附上依据。</p>}
      </section>
      {error && <p className="ai-error" role="alert">{error}</p>}
      {preview && <section ref={diff} className="write-field" aria-label="写入前后的差异">
        <h4>将写入《{subject.notes.find(item => item.name === preview.noteName)?.title ?? preview.noteName.replace(/\.md$/, '')}》</h4>
        <ModificationPreview original={preview.before ?? ''} replacement={preview.after}/>
        <p className="muted">确认后可以随时撤销；写入前笔记若被改动会拒绝覆盖。</p></section>}
    </div>
  </Dialog>
}
