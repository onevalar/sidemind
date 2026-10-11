import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { AgentChange, AgentEdit, AgentScope } from '../shared/types'
import { api, subscribeEvents } from './api'
import { AiComposer, type AiComposerMessage } from './components/arc/blocks/ai-composer/ai-composer'
import { ModificationPreview } from './ModificationPreview'
import { Button, Dialog, Icon, IconButton, Select } from './ui'

type Conversation = { session?: string; messages: AiComposerMessage[]; input: string; error: string; changes: (AgentChange & { undone?: boolean })[] }
export function AgentPanel({ folder, name, model, beforeSend, selection, onConfigure, onClose, onOpenNote }: {
  folder: string; name: string | null; model: string | null; beforeSend: MutableRefObject<() => Promise<boolean>>; selection: MutableRefObject<() => string | undefined>
  onConfigure: () => void; onClose: () => void; onOpenNote: (name: string) => void
}) {
  const [mode, setMode] = useState<'context' | 'folder' | 'chat'>('context')
  const scope: AgentScope = mode === 'chat' ? { kind: 'chat', folder: '' } : mode === 'context' && name ? { kind: 'note', folder, name } : { kind: 'folder', folder }
  const key = JSON.stringify(scope)
  const conversations = useRef(new Map<string, Conversation>())
  if (!conversations.current.has(key)) conversations.current.set(key, { messages: [], input: '', error: '', changes: [] })
  const conversation = conversations.current.get(key)!
  const [, redraw] = useState(0)
  const update = () => redraw(value => value + 1)
  const request = useRef<AbortController | null>(null)
  const [busy, setBusy] = useState(false)
  const [activity, setActivity] = useState('正在思考…')
  const [undoing, setUndoing] = useState<string | null>(null)
  const [viewing, setViewing] = useState<AgentEdit | null>(null)
  useEffect(() => () => request.current?.abort(), [])
  useEffect(() => {
    request.current?.abort()
    setViewing(null)
    let active = true, revision = 0
    const refresh = async () => {
      const current = ++revision
      if (scope.kind === 'chat') return
      try {
        const changes = await api.agentChanges(scope.folder, scope.kind === 'note' ? scope.name : undefined)
        if (!active || current !== revision) return
        const known = new Set(conversation.changes.map(change => change.id))
        conversation.changes.push(...changes.filter(change => !known.has(change.id)))
        update()
      } catch (error) { if (active && current === revision) { conversation.error = '无法读取修改记录：' + (error as Error).message; update() } }
    }
    void refresh()
    const unsubscribe = subscribeEvents(event => { if (event.type === 'notes-changed' || event.type === 'hello') void refresh() })
    return () => { active = false; unsubscribe() }
  }, [key])

  const ask = async () => {
    if (!model || !conversation.input.trim() || request.current || undoing) return
    const controller = new AbortController()
    request.current = controller; setBusy(true); setActivity('正在准备…'); conversation.error = ''; update()
    try {
      // Flush the current draft first; file tools must never work from an older autosaved version.
      if (scope.kind !== 'chat' && !await beforeSend.current()) throw new Error('请先处理未保存的修改，再交给助手。')
      controller.signal.throwIfAborted()
      const message = conversation.input.trim(), selected = scope.kind === 'note' ? selection.current() : undefined
      conversation.messages.push({ id: conversation.messages.length, role: 'user', text: message }); conversation.input = ''; setActivity('正在思考…'); update()
      await api.agent({ scope, session: conversation.session, message, ...(selected ? { selection: selected } : {}) }, event => {
        if (controller.signal.aborted) return
        if (event.type === 'session') conversation.session = event.id
        else if (event.type === 'activity') setActivity(event.text)
        else if (event.type === 'message') conversation.messages.push({ id: conversation.messages.length, role: 'assistant', text: event.text })
        else if (event.type === 'change' && !conversation.changes.some(change => change.id === event.change.id)) conversation.changes.push(event.change)
        else if (event.type === 'error') conversation.error = event.text
        update()
      }, controller.signal)
    } catch (error) {
      conversation.error = controller.signal.aborted ? '已停止。已完成的修改仍保留，可在修改记录中撤销。' : (error as Error).message
      update()
    } finally { if (request.current === controller) { request.current = null; setBusy(false) } }
  }
  const undo = async (change: AgentChange) => {
    if (undoing || request.current) return
    setUndoing(change.id); conversation.error = ''
    try {
      if (!await beforeSend.current()) throw new Error('请先保存当前草稿，再撤销助手修改。')
      await api.undoAgentChange(change.id)
      const item = conversation.changes.find(item => item.id === change.id)
      if (item) item.undone = true
    } catch (error) { conversation.error = '未撤销：' + (error as Error).message }
    finally { setUndoing(null); update() }
  }
  const view = async (change: AgentChange) => {
    try { setViewing(await api.agentChange(change.id)) }
    catch (error) { conversation.error = '无法查看修改：' + (error as Error).message; update() }
  }
  const folderLabel = folder || '笔记文件夹'
  return <aside className="ai-panel" aria-label="AI 助手">
    <AiComposer title="AI 助手" subtitle={<Button className="ai-model" variant="ghost" size="sm" onPress={onConfigure}><Icon name="settings" size={13}/>{model || '连接模型'}</Button>}
      headerActions={<div className="toolbar"><IconButton icon="plus" label="开始新对话" isDisabled={busy || !!undoing} onPress={() => { conversation.session = undefined; conversation.messages = []; conversation.error = ''; update() }}/><IconButton icon="close" label="关闭 AI 助手" onPress={onClose}/></div>}
      context={<><Select label="对话范围" value={mode} disabled={busy || !!undoing} onValueChange={value => setMode(value as typeof mode)} options={[{ value: 'context', label: name ? '当前文章' : '当前文件夹' }, ...(name ? [{ value: 'folder', label: '整个文件夹' }] : []), { value: 'chat', label: '纯聊天 · 不读取笔记' }]}/><p className="agent-context-target" title={scope.kind === 'note' ? scope.name : folderLabel}><Icon name={scope.kind === 'chat' ? 'spark' : scope.kind === 'note' ? 'note' : 'folder'} size={14}/><span>{scope.kind === 'chat' ? '不向模型提供笔记或文件工具' : scope.kind === 'note' ? scope.name.split('/').at(-1) : folderLabel + ' · 含子文件夹'}</span></p></>}
      messages={conversation.messages} value={conversation.input} onValueChange={value => { conversation.input = value; update() }} busy={busy} activity={activity} disabled={!model || !!undoing}
      onSend={() => void ask()} onStop={() => request.current?.abort()} onOpenNote={onOpenNote}
      emptyTitle={scope.kind === 'chat' ? '想聊些什么？' : '你的笔记，也能一起思考'} emptyText={scope.kind === 'chat' ? '聊日常、聊想法，不读取或修改笔记。' : '聊文章里的问题，梳理不同观点，\n也可以交给我修改和整理。'}
      suggestions={scope.kind === 'chat' ? [{ label: '聊一聊', prompt: '你好，我们随便聊聊吧。' }] : scope.kind === 'note' ? [{ label: '讨论文章', prompt: '读一下这篇文章，和我讨论其中值得进一步思考的问题。' }, { label: '总结要点', prompt: '总结这篇文章的核心观点，只在对话里回复，不修改文件。' }, { label: '修正错别字', prompt: '直接修正这篇文章中的错别字，保留其他内容和格式，并告诉我改了哪里。' }] : [{ label: '了解这些笔记', prompt: '看看这个文件夹的文章概述，介绍主要主题和它们之间的联系。' }, { label: '寻找关联', prompt: '找出这个文件夹里适合放在一起讨论的文章，读相关内容后解释它们的联系。' }]}>
      {conversation.error && <p className="ai-error" role="alert">{conversation.error}</p>}
      {!!conversation.changes.length && <details className="agent-changes" open><summary>修改记录 · {conversation.changes.length}</summary>{[...conversation.changes].reverse().map(change => <div className="agent-change" key={change.id}><div className="agent-change-file"><span>{change.undone ? '已撤销' : change.kind === 'create' ? '已新建 · 来源保留' : '已修改'}</span><Button variant="ghost" size="sm" onPress={() => onOpenNote(change.name)} title={change.name}>{change.name.split('/').at(-1)}</Button></div>{change.kind === 'edit' && <div className="agent-change-actions"><Button variant="ghost" size="sm" onPress={() => void view(change)}>查看修改</Button><Button variant="ghost" size="sm" isDisabled={busy || !!undoing || change.undone} onPress={() => void undo(change)}>{undoing === change.id ? '撤销中…' : '撤销'}</Button></div>}</div>)}</details>}
    </AiComposer>
    <Dialog title="助手修改记录" open={!!viewing} onClose={() => setViewing(null)}>
      {viewing && <><p className="muted">{viewing.name} · 本次已保存的修改</p><ModificationPreview original={viewing.before} replacement={viewing.after}/></>}
    </Dialog>
  </aside>
}
