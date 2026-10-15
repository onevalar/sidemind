import { useEffect, useId, useRef, useState, type ReactNode, type MutableRefObject } from 'react'
import type { AgentEvent, AgentRunDTO, AgentScope, ChangeSetDetail, ChangeSetSummary, PlanStep, ProposalDetail, ProposalSummary } from '../shared/types'
import { api, subscribeEvents } from './api'
import { AiChat, type AiChatMessage } from './components/arc/blocks/ai-chat/ai-chat'
import { ModificationPreview } from './ModificationPreview'
import './agent-feedback.css'
import { Button, Dialog, Icon, DropdownMenu } from './ui'

type Conversation = {
  session?: string; messages: AiChatMessage[]; input: string; error: string; notice: string; streaming: string
  changes: ChangeSetSummary[]; proposals: ProposalSummary[]; plan: PlanStep[]; restored: boolean
  /** Runs a restart stopped after they had changed notes; shown until the user says they have checked. */
  recovery: AgentRunDTO[]
  runToFollow?: AgentRunDTO
}
const blank = (): Conversation => ({ messages: [], input: '', error: '', notice: '', streaming: '', changes: [], proposals: [], plan: [], restored: false, recovery: [] })
const upsert = <T extends { id: string }>(list: T[], item: T) => { const index = list.findIndex(entry => entry.id === item.id); if (index < 0) list.push(item); else list[index] = item }
const fileName = (name: string) => name.split('/').at(-1)!
const kindLabel = { create: '新建', edit: '修改', delete: '删除' } as const

function describe(set: { files: { name: string; kind: 'create' | 'edit' | 'delete' }[]; layouts: string[]; memory?: number }): string {
  const parts = [set.files.length && `${set.files.length} 篇文章`, set.memory && `记忆 ${set.memory} 处`, set.layouts.length && `画布 ${set.layouts.length} 个`].filter(Boolean)
  return parts.join(' · ') || '无文件修改'
}

/** A small Arc action opens supporting information; no page-level FAQ frame. */
function FeedbackDisclosure({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  return <div className="agent-feedback-disclosure">
    <Button variant="secondary" size="sm" aria-expanded={open} aria-controls={id} onPress={() => setOpen(value => !value)}>{label}<span className="agent-feedback-chevron" data-open={open}><Icon name="down" size={14}/></span></Button>
    {open && <div id={id} className="agent-feedback-content">{children}</div>}
  </div>
}

export function AgentPanel({ folder, name, model, beforeSend, selection, onConfigure, onClose, onOpenNote, onFocus, navigation, taskRequest, onTaskChange }: {
  taskRequest?: { run: AgentRunDTO; key: number }; onTaskChange?: () => void;
  navigation?: ReactNode; folder: string; name: string | null; model: string | null; beforeSend: MutableRefObject<() => Promise<boolean>>; selection: MutableRefObject<() => string | undefined>
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
  const mounted = useRef(true)
  const runId = useRef<string | null>(null)
  const runningTarget = useRef<Conversation | null>(null)
  const following = useRef<{ target: Conversation; scope: AgentScope; controller: AbortController; promise: Promise<AgentRunDTO | null> } | null>(null)
  const requestedSessions = useRef(new Map<string, string>())
  const pendingTaskScope = useRef<string | null>(null)
  const redirecting = useRef(false)
  const cancelAdjustment = useRef(false)
  const [interrupting, setInterrupting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [activity, setActivity] = useState('正在思考…')
  const [acting, setActing] = useState<string | null>(null)
  const [viewing, setViewing] = useState<{ title: string; subtitle: string; diffs: { name: string; before: string | null; after: string | null }[] } | null>(null)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; request.current?.abort() } // detach: the run keeps going on the server
  }, [])

  useEffect(() => {
    if (!taskRequest) return
    const targetScope = taskRequest.run.scope, targetKey = JSON.stringify(targetScope)
    pendingTaskScope.current = targetKey
    setMode(targetScope.kind === 'chat' ? 'chat' : targetScope.kind === 'folder' ? 'folder' : 'context')
    if (taskRequest.run.session) requestedSessions.current.set(targetKey, taskRequest.run.session)
    else requestedSessions.current.delete(targetKey)
    const existing = conversations.current.get(targetKey)
    if (['queued', 'running'].includes(taskRequest.run.status) && request.current && runId.current !== taskRequest.run.id) {
      // Follow the task the user selected. Detaching only closes this stream;
      // execution stays owned by the server and remains discoverable globally.
      const previous = request.current
      request.current = null; runId.current = null; runningTarget.current = null; following.current = null
      cancelAdjustment.current = true
      previous.abort(); setBusy(false)
    }
    const followed = following.current
    const isFollowedSession = request.current && followed && JSON.stringify(followed.scope) === targetKey &&
      (taskRequest.run.id === runId.current || !!taskRequest.run.session && taskRequest.run.session === followed.target.session)
    // A scope can have several sessions. Viewing an older task must not silently
    // show its currently running sibling; returning to that sibling reuses its live target.
    const target = { ...blank(), input: existing?.input ?? '' }
    if (!taskRequest.run.session) {
      // A failed start may never create a conversation. Its run record is the
      // authoritative source; loading the latest scope conversation would show unrelated work.
      target.restored = true
      if (taskRequest.run.request) target.messages = [{ id: 0, role: 'user', text: taskRequest.run.request }]
      if (['queued', 'running'].includes(taskRequest.run.status)) target.runToFollow = taskRequest.run
      else if (taskRequest.run.status === 'cancelled') target.notice = taskRequest.run.error || '任务已停止。'
      else if (taskRequest.run.error) target.error = taskRequest.run.error
      else target.notice = taskRequest.run.status === 'completed' ? '任务已完成，未创建对话记录。' : '任务未完成，未创建对话记录。'
    }
    conversations.current.set(targetKey, isFollowedSession ? followed.target : target)
    update()
  }, [taskRequest?.key])

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
  const watch = (target: Conversation, controller: AbortController, listen: () => Promise<AgentRunDTO | null>, runScope: AgentScope) => {
    const promise = (async () => {
      try {
        const final = await listen()
        // A stop the user asked for is a normal outcome; an interruption is not.
        if (final?.status === 'cancelled' && final.error) target.notice = final.error
        else if (final?.status === 'recovery_required') upsert(target.recovery, final)
        else if (final?.status === 'interrupted' && final.error) target.error = final.error
        return final
      } catch (error) {
        if (!controller.signal.aborted) target.error = (error as Error).message
        return null
      } finally {
        target.streaming = ''; update()
        if (request.current === controller) { request.current = null; runId.current = null; setBusy(false) }
        onTaskChange?.()
      }
    })()
    following.current = { target, scope: runScope, controller, promise }
    return promise
  }

  // Restore the latest conversation of this scope (survives reloads and restarts), then keep undo state fresh.
  useEffect(() => {
    let active = true
    const current = conversation
    const refresh = async () => {
      if (conversations.current.get(key) !== current) return
      if (pendingTaskScope.current && pendingTaskScope.current !== key) return
      pendingTaskScope.current = null
      try {
        if (current.runToFollow) {
          if (request.current) return
          const pendingRun = current.runToFollow
          delete current.runToFollow
          const controller = new AbortController()
          runningTarget.current = current; request.current = controller; runId.current = pendingRun.id; setBusy(true); setActivity(pendingRun.activity || '正在连接任务…')
          void watch(current, controller, () => api.followAgent(pendingRun.id, event => apply(current, event), controller.signal), pendingRun.scope)
          return
        }
        if (scope.kind === 'chat' && !requestedSessions.current.has(key)) return
        if (!current.restored && !current.messages.length && (!request.current || runningTarget.current !== current)) {
          const state = await api.conversation(scope, requestedSessions.current.get(key))
          if (!active || current.messages.length) return
          current.restored = true
          if (state) {
            const saved = state.activeRun && !request.current ? state.messages.slice(0, state.messages.map(message => message.role).lastIndexOf('user') + 1) : state.messages
            Object.assign(current, { session: state.id, messages: saved.map((message, id) => ({ id, ...message })), changes: state.changes, proposals: state.proposals, plan: state.plan, recovery: state.recovery ?? [] })
            // A request from before the reload is still running: follow it. Its events are replayed from the start,
            // so the messages it already wrote are dropped above and come back through the stream.
            if (state.activeRun && !request.current) {
              const controller = new AbortController(), id = state.activeRun.id
              runningTarget.current = current; request.current = controller; runId.current = id; setBusy(true); setActivity('任务仍在后台运行…')
              void watch(current, controller, () => api.followAgent(id, event => apply(current, event), controller.signal), scope)
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
  }, [key, conversation, busy])

  const ask = async (target = conversation, runScope = scope, correction?: string) => {
    const draft = target.input, message = (correction ?? draft).trim()
    if (!mounted.current || !model || !message || request.current || acting) return
    const selected = correction === undefined && runScope.kind === 'note' ? selection.current() : undefined
    const controller = new AbortController()
    runningTarget.current = target; request.current = controller; setBusy(true); setActivity('正在准备…'); target.error = ''; target.notice = ''; target.restored = true; update()
    try {
      // Flush the current draft first; file tools must never work from an older autosaved version.
      if (runScope.kind !== 'chat' && !await beforeSend.current()) throw new Error('请先处理未保存的修改，再交给助手。')
      controller.signal.throwIfAborted()
      target.messages.push({ id: target.messages.length, role: 'user', text: message })
      if (target.input === draft) target.input = ''
      target.plan = []; setActivity('正在思考…'); update()
      await watch(target, controller, () => api.agent({ scope: runScope, session: target.session, message, ...(selected ? { selection: selected } : {}) }, event => { if (!controller.signal.aborted) apply(target, event) }, controller.signal, { onRun: run => { runId.current = run.id; onTaskChange?.() } }), runScope)
    } catch (error) {
      if (!controller.signal.aborted) target.error = (error as Error).message
    } finally { target.streaming = ''; update(); if (request.current === controller) { request.current = null; runId.current = null; setBusy(false) } }
  }

  const interruptAndAsk = async () => {
    const active = following.current, id = runId.current, message = conversation.input.trim()
    if (redirecting.current || !active || active.target !== conversation || !id || !message) return
    redirecting.current = true; cancelAdjustment.current = false; setInterrupting(true); conversation.error = ''; setActivity('正在停止，随后发送调整…'); update()
    try {
      await api.stopAgentRun(id)
      // The stop acknowledgement may still say running. Wait for the original
      // stream's durable terminal record before starting another write-capable run.
      const terminal = await active.promise
      if (cancelAdjustment.current || !mounted.current) return
      if (!terminal || active.controller.signal.aborted || !['cancelled', 'completed', 'waiting_confirmation', 'failed'].includes(terminal.status)) throw new Error('未能确认原任务已停止，请检查任务状态后再发送。')
      if (!active.target.session) throw new Error('无法恢复原对话，调整内容已保留。')
      void ask(active.target, active.scope, message)
    } catch (error) { active.target.error = '调整尚未发送：' + (error as Error).message; update() }
    finally { redirecting.current = false; setInterrupting(false) }
  }

  const stop = () => {
    const target = following.current?.target ?? conversation
    if (redirecting.current) { cancelAdjustment.current = true; target.notice = '已取消待发送的调整，内容保留在输入框。'; update() }
    const id = runId.current
    if (id) void api.stopAgentRun(id).then(() => onTaskChange?.()).catch(error => { target.error = '无法停止：' + (error as Error).message; update() })
  }

  const run = async (id: string, action: () => Promise<void>, failure: string) => {
    if (acting || request.current) return
    setActing(id); conversation.error = ''
    try { await action() } catch (error) { conversation.error = failure + (error as Error).message }
    finally { setActing(null); update() }
  }
  const acknowledge = (item: AgentRunDTO) => run(item.id, async () => { await api.acknowledgeAgentRun(item.id); conversation.recovery = conversation.recovery.filter(entry => entry.id !== item.id) }, '无法确认：')
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
  const working = !!acting || busy || interrupting
  const currentBusy = (busy || interrupting) && runningTarget.current === conversation
  return <aside className="ai-panel" aria-label="AI 助手">
    <AiChat navigation={navigation} title="AI 助手" model={model} onConfigure={onConfigure} onClose={onClose} locked={working}
      onNew={() => { conversations.current.set(key, { ...blank(), restored: true }); update() }}
      context={<div className="agent-composer-context" title={scope.kind === 'chat' ? '不读取或修改笔记' : '当前上下文；助手也可按要求查阅其他笔记'}><DropdownMenu label="对话范围" align="start" trigger={<Button variant="ghost" size="sm" isDisabled={working} aria-label="对话范围"><Icon name={scope.kind === 'chat' ? 'chat' : scope.kind === 'note' ? 'note' : 'folder'} size={14}/><span className="agent-context-label">{scope.kind === 'chat' ? '纯聊天' : scope.kind === 'note' ? fileName(scope.name) : folderLabel}</span><Icon name="down" size={13}/></Button>} items={[{ label: name ? '当前文章 · ' + fileName(name) : '当前文件夹 · ' + folderLabel, onSelect: () => setMode('context') }, ...(name ? [{ label: '文件夹 · ' + folderLabel, onSelect: () => setMode('folder') }] : []), { label: '纯聊天 · 不读取笔记', onSelect: () => setMode('chat') }]}/></div>}
      threadNotice={busy && !currentBusy && <div className="agent-other-run" role="status"><div><strong>另一段对话的任务仍在运行</strong><span className="muted">{following.current?.scope.kind === 'note' ? fileName(following.current.scope.name) : '文件夹任务'}</span></div><div className="agent-change-actions">{following.current && <Button size="sm" variant="ghost" onPress={() => { const active = following.current; if (!active) return; const activeKey = JSON.stringify(active.scope); conversations.current.set(activeKey, active.target); if (active.target.session) requestedSessions.current.set(activeKey, active.target.session); setMode(active.scope.kind === 'chat' ? 'chat' : active.scope.kind === 'folder' ? 'folder' : 'context'); if (active.scope.kind === 'note') onOpenNote(active.scope.name); else if (active.scope.kind === 'folder') onFocus?.(active.scope.folder, []); update() }}>返回任务</Button>}<Button size="sm" variant="ghost" onPress={stop}>停止任务</Button></div></div>}
      activityDetails={conversation.plan.length > 1 ? <FeedbackDisclosure key={conversation.session + ':plan:' + conversation.messages.filter(message => message.role === 'user').length} label={`任务步骤 · ${conversation.plan.filter(step => step.status === 'done').length}/${conversation.plan.length}`}><ol className="agent-feedback-plan" aria-label="任务计划">{conversation.plan.map((step, index) => <li key={index} data-status={step.status}><Icon name={step.status === 'done' ? 'check' : step.status === 'active' ? 'arrow' : 'clock'} size={13}/><span>{step.text}</span></li>)}</ol></FeedbackDisclosure> : undefined}

      messages={conversation.messages} streaming={conversation.streaming} value={conversation.input} onValueChange={value => { conversation.input = value; update() }} busy={currentBusy} activity={activity} disabled={!model || !!acting || interrupting || busy && !currentBusy} readOnly={interrupting}
      onInterruptSend={runId.current && following.current?.target === conversation ? () => void interruptAndAsk() : undefined}
      onSend={() => void ask()} onStop={stop} onOpenNote={onOpenNote}
      emptyTitle={scope.kind === 'chat' ? '开始聊天' : scope.kind === 'note' ? '围绕这篇笔记继续思考' : '从这些笔记开始'} emptyText={scope.kind === 'chat' ? '直接输入问题，不读取或修改笔记。' : scope.kind === 'note' ? '讨论内容，或直接告诉我需要修改什么。选中原文后，可切换到探索深入提问。' : '梳理主题、连接知识，或直接告诉我想完成的任务。'}
      suggestions={scope.kind === 'chat' ? [{ label: '打个招呼', prompt: '你好，我们随便聊聊吧。' }] : scope.kind === 'note' ? [{ label: '讨论内容', prompt: '读一下这篇文章，和我讨论其中值得进一步思考的问题。' }, { label: '查看改动', prompt: '自上次同步以来，这篇文章改了哪些地方？改动对结论有什么影响？' }, { label: '修正错别字', prompt: '直接修正这篇文章中的错别字，保留其他内容和格式，并告诉我改了哪里。' }] : [{ label: '概括笔记', prompt: '看看这个文件夹的文章和记忆，介绍主要主题和它们之间的联系。' }, { label: '整理画布', prompt: '读一下这个文件夹的文章，按主题把画布整理成几个文档区。' }, { label: '查找关联', prompt: '找出这个文件夹里适合放在一起讨论的文章，读相关内容后解释它们的联系。' }]}>

      {conversation.notice && <p className="muted agent-background-note" role="status">{conversation.notice}</p>}
      {conversation.error && <p className="ai-error" role="alert">{conversation.error}</p>}
      {conversation.recovery.map(item => <section className="agent-recovery" role="alert" aria-label="需要检查的中断任务" key={item.id}>
        <strong>上次的任务被中断，需要你检查</strong>
        <p>{item.error}</p>
        <div className="agent-change-actions">
          {(item.changes ?? []).map(id => conversation.changes.find(change => change.id === id)).filter((change): change is ChangeSetSummary => !!change).map(change => <Button key={change.id} variant="ghost" size="sm" isDisabled={working} onPress={() => void viewChange(change)}>查看：{describe(change)}</Button>)}
          <Button size="sm" isDisabled={working} onPress={() => void acknowledge(item)}>{acting === item.id ? '确认中…' : '我已检查'}</Button></div>
      </section>)}
      {!!pending.length && <section className="agent-proposals" aria-label="待确认的提案">
        <h3 className="agent-section-title">待你确认 · {pending.length}</h3>
        {pending.map(proposal => <div className="agent-change" key={proposal.id}>
          <div className="agent-change-file"><strong>{proposal.reason}</strong><span>{proposal.files.map(file => kindLabel[file.kind] + ' ' + fileName(file.name)).join('、') || describe(proposal)}</span></div>
          <div className="agent-change-actions"><Button variant="ghost" size="sm" isDisabled={working} onPress={() => void viewProposal(proposal)}>查看</Button><Button variant="ghost" size="sm" isDisabled={working} onPress={() => void reject(proposal)}>忽略</Button><Button size="sm" isDisabled={working} onPress={() => void accept(proposal)}>{acting === proposal.id ? '执行中…' : '执行'}</Button></div>
        </div>)}
      </section>}
      {!!(conversation.changes.length || settled.length) && <div className="agent-feedback-results"><FeedbackDisclosure key={key} label={conversation.changes.length === 1 ? `${conversation.changes[0]!.undone ? '已撤销' : '已修改'} · ${describe(conversation.changes[0]!)}` : `修改记录 · ${conversation.changes.length}`}>
        {[...conversation.changes].reverse().map(change => <section className="agent-feedback-change" aria-label="一次修改" key={change.id}>
          {conversation.changes.length > 1 && <div className="agent-feedback-summary"><strong>{change.undone ? '已撤销' : change.origin === 'proposal' ? '已执行提案' : '已修改'} · {describe(change)}</strong><p title={change.request}>{change.request}</p></div>}
          <ul className="agent-feedback-files">{change.files.slice(0, 6).map(file => <li key={file.name}><span>{kindLabel[file.kind]}</span><Button variant="ghost" size="sm" isDisabled={file.kind === 'delete' || change.undone && file.kind === 'create'} onPress={() => onOpenNote(file.name)} title={file.name}><Icon name="note" size={14}/><span className="agent-feedback-filename">{fileName(file.name).replace(/\.md$/i, '')}</span></Button></li>)}</ul>
          {change.files.length > 6 && <span className="muted">另有 {change.files.length - 6} 篇</span>}
          <div className="agent-feedback-actions"><Button variant="secondary" size="sm" isDisabled={working} onPress={() => void viewChange(change)}><Icon name="search" size={14}/>查看改动</Button><Button variant="secondary" size="sm" isDisabled={working || change.undone || !change.undoable} title={!change.undone && !change.undoable ? '之后又有修改，撤销会覆盖新内容' : undefined} onPress={() => void undo(change)}><Icon name="undo" size={14}/>{acting === change.id ? '撤销中…' : change.undone ? '已撤销' : change.undoable ? '撤销这次修改' : '无法撤销'}</Button></div>
        </section>)}
        {settled.map(proposal => <p className="muted agent-settled" key={proposal.id}>提案「{proposal.reason}」{proposal.status === 'applied' ? '已执行' : proposal.status === 'rejected' ? '已忽略' : '已过期：内容已变化'}</p>)}
      </FeedbackDisclosure></div>}
    </AiChat>
    <Dialog title={viewing?.title ?? ''} open={!!viewing} onClose={() => setViewing(null)}>
      {viewing && <><p className="muted">{viewing.subtitle}</p>{viewing.diffs.map(diff => <section key={diff.name} className="agent-diff"><h4>{diff.name} · {diff.before === null ? '新建' : diff.after === null ? '删除' : '修改'}</h4><ModificationPreview original={diff.before ?? ''} replacement={diff.after ?? ''}/></section>)}</>}
    </Dialog>
  </aside>
}
