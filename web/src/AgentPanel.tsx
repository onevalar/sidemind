import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { AgentEvent, AgentRunDTO, AgentScope, ChangeSetDetail, ChangeSetSummary, PlanStep, ProposalDetail, ProposalSummary } from '../shared/types'
import { api, subscribeEvents } from './api'
import { AiChat, type AiChatMessage } from './components/arc/blocks/ai-chat/ai-chat'
import { ModificationPreview } from './ModificationPreview'
import { Accordion, Button, Dialog, Icon, Select } from './ui'

type Conversation = {
  session?: string; messages: AiChatMessage[]; input: string; error: string; notice: string; streaming: string
  changes: ChangeSetSummary[]; proposals: ProposalSummary[]; plan: PlanStep[]; restored: boolean
}
const blank = (): Conversation => ({ messages: [], input: '', error: '', notice: '', streaming: '', changes: [], proposals: [], plan: [], restored: false })
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
  // `request` only detaches this page from a run (closing or leaving never stops it); `runId` is what Stop acts on.
  const request = useRef<AbortController | null>(null)
  const runId = useRef<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [activity, setActivity] = useState('正在思考…')
  const [acting, setActing] = useState<string | null>(null)
  const [viewing, setViewing] = useState<{ title: string; subtitle: string; diffs: { name: string; before: string | null; after: string | null }[] } | null>(null)
  useEffect(() => () => request.current?.abort(), [])  // detach: the run keeps going on the server

  const apply = (target: Conversation, event: AgentEvent) => {
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
  }
  /** Listen to a run until it ends. The run itself is never cancelled from here. */
  const watch = async (target: Conversation, controller: AbortController, listen: () => Promise<AgentRunDTO | null>) => {
    try {
      const final = await listen()
      // A stop the user asked for is a normal outcome; an interruption is not.
      if (final?.status === 'cancelled' && final.error) target.notice = final.error
      else if (final?.status === 'interrupted' && final.error) target.error = final.error
    } catch (error) {
      if (!controller.signal.aborted) target.error = (error as Error).message
    } finally {
      target.streaming = ''; update()
      if (request.current === controller) { request.current = null; runId.current = null; setBusy(false) }
    }
  }

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
          if (state) {
            const saved = state.activeRun ? state.messages.slice(0, state.messages.map(message => message.role).lastIndexOf('user') + 1) : state.messages
            Object.assign(current, { session: state.id, messages: saved.map((message, id) => ({ id, ...message })), changes: state.changes, proposals: state.proposals, plan: state.plan })
            // A request from before the reload is still running: follow it. Its events are replayed from the start,
            // so the messages it already wrote are dropped above and come back through the stream.
            if (state.activeRun && !request.current) {
              const controller = new AbortController(), id = state.activeRun.id
              request.current = controller; runId.current = id; setBusy(true); setActivity('任务仍在后台运行…')
              void watch(current, controller, () => api.followAgent(id, event => apply(current, event), controller.signal))
            }
          }
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
    request.current = controller; setBusy(true); setActivity('正在准备…'); target.error = ''; target.notice = ''; target.restored = true; update()
    try {
      // Flush the current draft first; file tools must never work from an older autosaved version.
      if (scope.kind !== 'chat' && !await beforeSend.current()) throw new Error('请先处理未保存的修改，再交给助手。')
      controller.signal.throwIfAborted()
      const message = target.input.trim(), selected = scope.kind === 'note' ? selection.current() : undefined
      target.messages.push({ id: target.messages.length, role: 'user', text: message }); target.input = ''; target.plan = []; setActivity('正在思考…'); update()
      await watch(target, controller, () => api.agent({ scope, session: target.session, message, ...(selected ? { selection: selected } : {}) }, event => { if (!controller.signal.aborted) apply(target, event) }, controller.signal, { onRun: run => { runId.current = run.id } }))
    } catch (error) {
      if (!controller.signal.aborted) target.error = (error as Error).message
    } finally { target.streaming = ''; update(); if (request.current === controller) { request.current = null; runId.current = null; setBusy(false) } }
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
    <AiChat title="AI 助手" model={model} onConfigure={onConfigure} onClose={onClose} locked={working}
      onNew={() => { conversations.current.set(key, { ...blank(), restored: true }); update() }}
      context={<div className="agent-composer-context" title={scope.kind === 'chat' ? '不读取或修改笔记' : `以${scope.kind === 'note' ? '文章：' + scope.name : '文件夹：' + folderLabel}为上下文，可查阅整个笔记库`}><Select label="对话范围" value={mode} disabled={working} onValueChange={value => setMode(value as typeof mode)} options={[{ value: 'context', label: name ? '文章 · ' + fileName(name) : '文件夹 · ' + folderLabel }, ...(name ? [{ value: 'folder', label: '文件夹 · ' + folderLabel }] : []), { value: 'chat', label: '纯聊天 · 不读取笔记' }]}/></div>}
      messages={conversation.messages} streaming={conversation.streaming} value={conversation.input} onValueChange={value => { conversation.input = value; update() }} busy={busy} activity={activity} disabled={!model || !!acting}
      onSend={() => void ask()} onStop={() => { const id = runId.current; if (id) void api.stopAgentRun(id).catch(error => { conversation.error = '无法停止：' + (error as Error).message; update() }) }} onOpenNote={onOpenNote}
      emptyTitle={scope.kind === 'chat' ? '开始聊天' : scope.kind === 'note' ? '处理当前文章' : '整理文件夹笔记'} emptyText={scope.kind === 'chat' ? '直接输入问题，不读取或修改笔记。' : scope.kind === 'note' ? '可以讨论内容、检查改动或修正错别字。' : '可以概括笔记、查找关联或整理画布。'}
      suggestions={scope.kind === 'chat' ? [{ label: '打个招呼', prompt: '你好，我们随便聊聊吧。' }] : scope.kind === 'note' ? [{ label: '讨论内容', prompt: '读一下这篇文章，和我讨论其中值得进一步思考的问题。' }, { label: '查看改动', prompt: '自上次同步以来，这篇文章改了哪些地方？改动对结论有什么影响？' }, { label: '修正错别字', prompt: '直接修正这篇文章中的错别字，保留其他内容和格式，并告诉我改了哪里。' }] : [{ label: '概括笔记', prompt: '看看这个文件夹的文章和记忆，介绍主要主题和它们之间的联系。' }, { label: '整理画布', prompt: '读一下这个文件夹的文章，按主题把画布整理成几个文档区。' }, { label: '查找关联', prompt: '找出这个文件夹里适合放在一起讨论的文章，读相关内容后解释它们的联系。' }]}>
      {!!conversation.plan.length && <ol className="agent-plan" aria-label="任务计划">{conversation.plan.map((step, index) => <li key={index} data-status={step.status}><Icon name={step.status === 'done' ? 'check' : step.status === 'active' ? 'arrow' : 'clock'} size={13}/><span>{step.text}</span></li>)}</ol>}
      {busy && <p className="muted agent-background-note" role="status">任务在后台运行：关闭面板、切换页面或刷新都不会中断它，需要时点“停止”。已完成的修改会保留，可以撤销。</p>}
      {conversation.notice && <p className="muted agent-background-note" role="status">{conversation.notice}</p>}
      {conversation.error && <p className="ai-error" role="alert">{conversation.error}</p>}
      {!!pending.length && <section className="agent-proposals" aria-label="待确认的提案">
        <h3 className="agent-section-title">待你确认 · {pending.length}</h3>
        {pending.map(proposal => <div className="agent-change" key={proposal.id}>
          <div className="agent-change-file"><strong>{proposal.reason}</strong><span>{proposal.files.map(file => kindLabel[file.kind] + ' ' + fileName(file.name)).join('、') || describe(proposal)}</span></div>
          <div className="agent-change-actions"><Button variant="ghost" size="sm" isDisabled={working} onPress={() => void viewProposal(proposal)}>查看</Button><Button variant="ghost" size="sm" isDisabled={working} onPress={() => void reject(proposal)}>忽略</Button><Button size="sm" isDisabled={working} onPress={() => void accept(proposal)}>{acting === proposal.id ? '执行中…' : '执行'}</Button></div>
        </div>)}
      </section>}
      {!!(conversation.changes.length || settled.length) && <div className="agent-changes"><Accordion items={[{ title: `修改记录 · ${conversation.changes.length}`, content: <>
        {[...conversation.changes].reverse().map(change => <div className="agent-change" key={change.id}>
          <div className="agent-change-file"><span>{change.undone ? '已撤销' : change.origin === 'proposal' ? '已执行提案' : '已修改'} · {describe(change)}</span>
            {change.files.slice(0, 6).map(file => <Button key={file.name} variant="ghost" size="sm" isDisabled={file.kind === 'delete' || change.undone && file.kind === 'create'} onPress={() => onOpenNote(file.name)} title={file.name}>{kindLabel[file.kind]} · {fileName(file.name)}</Button>)}
            {change.files.length > 6 && <span>另有 {change.files.length - 6} 篇</span>}</div>
          <div className="agent-change-actions"><Button variant="ghost" size="sm" isDisabled={working} onPress={() => void viewChange(change)}>查看</Button><Button variant="ghost" size="sm" isDisabled={working || change.undone || !change.undoable} title={!change.undone && !change.undoable ? '之后又有修改，撤销会覆盖新内容' : undefined} onPress={() => void undo(change)}>{acting === change.id ? '撤销中…' : change.undone ? '已撤销' : change.undoable ? '整组撤销' : '无法撤销'}</Button></div>
        </div>)}
        {settled.map(proposal => <p className="muted agent-settled" key={proposal.id}>提案「{proposal.reason}」{proposal.status === 'applied' ? '已执行' : proposal.status === 'rejected' ? '已忽略' : '已过期：内容已变化'}</p>)}
      </> }]}/></div>}
    </AiChat>
    <Dialog title={viewing?.title ?? ''} open={!!viewing} onClose={() => setViewing(null)}>
      {viewing && <><p className="muted">{viewing.subtitle}</p>{viewing.diffs.map(diff => <section key={diff.name} className="agent-diff"><h4>{diff.name} · {diff.before === null ? '新建' : diff.after === null ? '删除' : '修改'}</h4><ModificationPreview original={diff.before ?? ''} replacement={diff.after ?? ''}/></section>)}</>}
    </Dialog>
  </aside>
}
