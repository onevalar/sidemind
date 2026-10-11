import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { AgentScope, ChangeSetDetail, ChangeSetSummary, PlanStep, ProposalDetail, ProposalSummary } from '../shared/types'
import { api, subscribeEvents } from './api'
import { AiComposer, type AiComposerMessage } from './components/arc/blocks/ai-composer/ai-composer'
import { ModificationPreview } from './ModificationPreview'
import { Button, Dialog, Icon, IconButton, Select } from './ui'

type Conversation = {
  session?: string; messages: AiComposerMessage[]; input: string; error: string; streaming: string
  changes: ChangeSetSummary[]; proposals: ProposalSummary[]; plan: PlanStep[]; restored: boolean
}
const blank = (): Conversation => ({ messages: [], input: '', error: '', streaming: '', changes: [], proposals: [], plan: [], restored: false })
const upsert = <T extends { id: string }>(list: T[], item: T) => { const index = list.findIndex(entry => entry.id === item.id); if (index < 0) list.push(item); else list[index] = item }
const fileName = (name: string) => name.split('/').at(-1)!
const kindLabel = { create: '新建', edit: '修改', delete: '删除' } as const

function describe(set: { files: { name: string; kind: 'create' | 'edit' | 'delete' }[]; layouts: string[]; memory?: number }): string {
  const parts = [set.files.length && `${set.files.length} 篇文章`, set.memory && `记忆 ${set.memory} 处`, set.layouts.length && `画布 ${set.layouts.length} 个`].filter(Boolean)
  return parts.join(' · ') || '无文件修改'
}

export function AgentPanel({ folder, name, model, beforeSend, selection, onConfigure, onClose, onOpenNote, onFocus }: {
  folder: string; name: string | null; model: string | null; beforeSend: MutableRefObject<() => Promise<boolean>>; selection: MutableRefObject<() => string | undefined>
  onConfigure: () => void; onClose: () => void; onOpenNote: (name: string) => void; onFocus?: (folder: string, names: string[]) => void
}) {
  const [mode, setMode] = useState<'context' | 'folder' | 'chat'>('context')
  const scope: AgentScope = mode === 'chat' ? { kind: 'chat', folder: '' } : mode === 'context' && name ? { kind: 'note', folder, name } : { kind: 'folder', folder }
  const key = JSON.stringify(scope)
  const conversations = useRef(new Map<string, Conversation>())
  if (!conversations.current.has(key)) conversations.current.set(key, blank())
  const conversation = conversations.current.get(key)!
  const [, redraw] = useState(0)
  const update = () => redraw(value => value + 1)
  const request = useRef<AbortController | null>(null)
  const [busy, setBusy] = useState(false)
  const [activity, setActivity] = useState('正在思考…')
  const [acting, setActing] = useState<string | null>(null)
  const [viewing, setViewing] = useState<{ title: string; subtitle: string; diffs: { name: string; before: string | null; after: string | null }[] } | null>(null)
  useEffect(() => () => request.current?.abort(), [])

  // Restore the latest conversation of this scope (survives reloads and restarts), then keep undo state fresh.
  useEffect(() => {
    let active = true
    const current = conversation
    const refresh = async () => {
      if (scope.kind === 'chat') return
      try {
        if (!current.restored && !current.messages.length && !request.current) {
          const state = await api.conversation(scope)
          if (!active || current.messages.length) return
          current.restored = true
          if (state) Object.assign(current, { session: state.id, messages: state.messages.map((message, id) => ({ id, ...message })), changes: state.changes, proposals: state.proposals, plan: state.plan })
          update()
          return
        }
        if (!current.changes.length) return
        const fresh = await api.changeSets(scope.kind === 'note' ? { name: scope.name } : { folder: scope.folder })
        if (!active) return
        for (const change of current.changes) { const latest = fresh.find(item => item.id === change.id); if (latest) Object.assign(change, latest) }
        update()
      } catch (error) { if (active) { current.error = '无法读取对话记录：' + (error as Error).message; update() } }
    }
    void refresh()
    const unsubscribe = subscribeEvents(event => { if (event.type === 'notes-changed' || event.type === 'memory-changed') void refresh() })
    return () => { active = false; unsubscribe() }
  }, [key])

  const ask = async () => {
    if (!model || !conversation.input.trim() || request.current || acting) return
    const controller = new AbortController(), target = conversation
    request.current = controller; setBusy(true); setActivity('正在准备…'); target.error = ''; target.restored = true; update()
    try {
      // Flush the current draft first; file tools must never work from an older autosaved version.
      if (scope.kind !== 'chat' && !await beforeSend.current()) throw new Error('请先处理未保存的修改，再交给助手。')
      controller.signal.throwIfAborted()
      const message = target.input.trim(), selected = scope.kind === 'note' ? selection.current() : undefined
      target.messages.push({ id: target.messages.length, role: 'user', text: message }); target.input = ''; target.plan = []; setActivity('正在思考…'); update()
      await api.agent({ scope, session: target.session, message, ...(selected ? { selection: selected } : {}) }, event => {
        if (controller.signal.aborted) return
        if (event.type === 'session') target.session = event.id
        else if (event.type === 'activity') { setActivity(event.text); target.streaming = '' }
        else if (event.type === 'delta') target.streaming += event.text
        else if (event.type === 'message') { target.messages.push({ id: target.messages.length, role: 'assistant', text: event.text }); target.streaming = '' }
        else if (event.type === 'plan') target.plan = event.steps
        else if (event.type === 'changeset') upsert(target.changes, event.change)
        else if (event.type === 'proposal') upsert(target.proposals, event.proposal)
        else if (event.type === 'focus') onFocus?.(event.folder, event.names)
        else if (event.type === 'error') target.error = event.text
        update()
      }, controller.signal)
    } catch (error) {
      target.error = controller.signal.aborted ? '已停止。已完成的修改仍保留，可在修改记录中撤销。' : (error as Error).message
    } finally { target.streaming = ''; update(); if (request.current === controller) { request.current = null; setBusy(false) } }
  }

  const run = async (id: string, action: () => Promise<void>, failure: string) => {
    if (acting || request.current) return
    setActing(id); conversation.error = ''
    try { await action() } catch (error) { conversation.error = failure + (error as Error).message }
    finally { setActing(null); update() }
  }
  const undo = (change: ChangeSetSummary) => run(change.id, async () => {
    if (!await beforeSend.current()) throw new Error('请先保存当前草稿。')
    upsert(conversation.changes, await api.undoChangeSet(change.id))
  }, '未撤销：')
  const accept = (proposal: ProposalSummary) => run(proposal.id, async () => {
    if (!await beforeSend.current()) throw new Error('请先保存当前草稿。')
    try {
      const result = await api.acceptProposal(proposal.id)
      upsert(conversation.proposals, result.proposal); upsert(conversation.changes, result.changeset)
    } catch (error) { upsert(conversation.proposals, { ...proposal, status: 'stale' }); throw error }
  }, '未执行提案：')
  const reject = (proposal: ProposalSummary) => run(proposal.id, async () => { upsert(conversation.proposals, await api.rejectProposal(proposal.id)) }, '无法忽略提案：')
  const viewChange = (change: ChangeSetSummary) => run('view', async () => {
    const detail: ChangeSetDetail = await api.changeSet(change.id)
    setViewing({ title: '助手修改记录', subtitle: change.request, diffs: detail.diffs.map(diff => ({ name: (diff.area === 'memory' ? '记忆 · ' : '') + diff.name, before: diff.before, after: diff.after })) })
  }, '无法查看修改：')
  const viewProposal = (proposal: ProposalSummary) => run('view', async () => {
    const detail: ProposalDetail = await api.proposal(proposal.id)
    setViewing({ title: '待确认的提案', subtitle: proposal.reason, diffs: detail.diffs })
  }, '无法查看提案：')

  const folderLabel = folder || '笔记文件夹'
  const pending = conversation.proposals.filter(proposal => proposal.status === 'pending')
  const settled = conversation.proposals.filter(proposal => proposal.status !== 'pending')
  const working = !!acting || busy
  return <aside className="ai-panel" aria-label="AI 助手">
    <AiComposer title="AI 助手" subtitle={<Button className="ai-model" variant="ghost" size="sm" onPress={onConfigure}><Icon name="settings" size={13}/>{model || '连接模型'}</Button>}
      headerActions={<div className="toolbar"><IconButton icon="plus" label="开始新对话" isDisabled={working} onPress={() => { conversations.current.set(key, { ...blank(), restored: true }); update() }}/><IconButton icon="close" label="关闭 AI 助手" onPress={onClose}/></div>}
      context={<><Select label="对话范围" value={mode} disabled={working} onValueChange={value => setMode(value as typeof mode)} options={[{ value: 'context', label: name ? '当前文章' : '当前文件夹' }, ...(name ? [{ value: 'folder', label: '整个文件夹' }] : []), { value: 'chat', label: '纯聊天 · 不读取笔记' }]}/><p className="agent-context-target" title={scope.kind === 'note' ? scope.name : folderLabel}><Icon name={scope.kind === 'chat' ? 'spark' : scope.kind === 'note' ? 'note' : 'folder'} size={14}/><span>{scope.kind === 'chat' ? '不向模型提供笔记或文件工具' : (scope.kind === 'note' ? fileName(scope.name) : folderLabel) + ' · 可查阅整个笔记库'}</span></p></>}
      messages={conversation.messages} streaming={conversation.streaming} value={conversation.input} onValueChange={value => { conversation.input = value; update() }} busy={busy} activity={activity} disabled={!model || !!acting}
      onSend={() => void ask()} onStop={() => request.current?.abort()} onOpenNote={onOpenNote}
      emptyTitle={scope.kind === 'chat' ? '想聊些什么？' : '你的笔记，也能一起思考'} emptyText={scope.kind === 'chat' ? '聊日常、聊想法，不读取或修改笔记。' : '讨论、整理、批量修改、重命名或整理画布，\n它会记住这些笔记以后怎么用。'}
      suggestions={scope.kind === 'chat' ? [{ label: '聊一聊', prompt: '你好，我们随便聊聊吧。' }] : scope.kind === 'note' ? [{ label: '讨论文章', prompt: '读一下这篇文章，和我讨论其中值得进一步思考的问题。' }, { label: '我改了什么', prompt: '自上次推送以来，这篇文章改了哪些地方？改动对结论有什么影响？' }, { label: '修正错别字', prompt: '直接修正这篇文章中的错别字，保留其他内容和格式，并告诉我改了哪里。' }] : [{ label: '了解这些笔记', prompt: '看看这个文件夹的文章和记忆，介绍主要主题和它们之间的联系。' }, { label: '整理画布', prompt: '读一下这个文件夹的文章，按主题把画布整理成几个文档区。' }, { label: '寻找关联', prompt: '找出这个文件夹里适合放在一起讨论的文章，读相关内容后解释它们的联系。' }]}>
      {!!conversation.plan.length && <ol className="agent-plan" aria-label="任务计划">{conversation.plan.map((step, index) => <li key={index} data-status={step.status}><Icon name={step.status === 'done' ? 'check' : step.status === 'active' ? 'arrow' : 'clock'} size={13}/><span>{step.text}</span></li>)}</ol>}
      {conversation.error && <p className="ai-error" role="alert">{conversation.error}</p>}
      {!!pending.length && <section className="agent-proposals" aria-label="待确认的提案">
        <h3 className="agent-section-title">待你确认 · {pending.length}</h3>
        {pending.map(proposal => <div className="agent-change" key={proposal.id}>
          <div className="agent-change-file"><strong>{proposal.reason}</strong><span>{proposal.files.map(file => kindLabel[file.kind] + ' ' + fileName(file.name)).join('、') || describe(proposal)}</span></div>
          <div className="agent-change-actions"><Button variant="ghost" size="sm" isDisabled={working} onPress={() => void viewProposal(proposal)}>查看</Button><Button variant="ghost" size="sm" isDisabled={working} onPress={() => void reject(proposal)}>忽略</Button><Button size="sm" isDisabled={working} onPress={() => void accept(proposal)}>{acting === proposal.id ? '执行中…' : '执行'}</Button></div>
        </div>)}
      </section>}
      {!!(conversation.changes.length || settled.length) && <details className="agent-changes" open><summary>修改记录 · {conversation.changes.length}</summary>
        {[...conversation.changes].reverse().map(change => <div className="agent-change" key={change.id}>
          <div className="agent-change-file"><span>{change.undone ? '已撤销' : change.origin === 'proposal' ? '已执行提案' : '已修改'} · {describe(change)}</span>
            {change.files.slice(0, 6).map(file => <Button key={file.name} variant="ghost" size="sm" isDisabled={file.kind === 'delete' || change.undone && file.kind === 'create'} onPress={() => onOpenNote(file.name)} title={file.name}>{kindLabel[file.kind]} · {fileName(file.name)}</Button>)}
            {change.files.length > 6 && <span>另有 {change.files.length - 6} 篇</span>}</div>
          <div className="agent-change-actions"><Button variant="ghost" size="sm" isDisabled={working} onPress={() => void viewChange(change)}>查看</Button><Button variant="ghost" size="sm" isDisabled={working || change.undone || !change.undoable} title={!change.undone && !change.undoable ? '之后又有修改，撤销会覆盖新内容' : undefined} onPress={() => void undo(change)}>{acting === change.id ? '撤销中…' : change.undone ? '已撤销' : change.undoable ? '整组撤销' : '无法撤销'}</Button></div>
        </div>)}
        {settled.map(proposal => <p className="muted agent-settled" key={proposal.id}>提案「{proposal.reason}」{proposal.status === 'applied' ? '已执行' : proposal.status === 'rejected' ? '已忽略' : '已过期：内容已变化'}</p>)}
      </details>}
    </AiComposer>
    <Dialog title={viewing?.title ?? ''} open={!!viewing} onClose={() => setViewing(null)}>
      {viewing && <><p className="muted">{viewing.subtitle}</p>{viewing.diffs.map(diff => <section key={diff.name} className="agent-diff"><h4>{diff.name} · {diff.before === null ? '新建' : diff.after === null ? '删除' : '修改'}</h4><ModificationPreview original={diff.before ?? ''} replacement={diff.after ?? ''}/></section>)}</>}
    </Dialog>
  </aside>
}
