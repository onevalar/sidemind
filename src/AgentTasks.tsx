import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentRunDTO } from '../shared/types'
import { api, subscribeEvents } from './api'
import { Button, Dialog, Icon } from './ui'
import { TextShimmer } from './components/arc/text-shimmer/text-shimmer'
import { prefs } from './prefs'
import './agent-tasks.css'

export const isActiveTask = (run: AgentRunDTO) => run.status === 'queued' || run.status === 'running'
export const taskTarget = (run: AgentRunDTO) => run.scope.kind === 'note' ? run.scope.name.split('/').at(-1)!.replace(/\.md$/i, '') : run.scope.kind === 'folder' ? run.scope.folder || '笔记文件夹' : '自由对话'
const statusText = (run: AgentRunDTO) => ({ queued: '准备中', running: '进行中', completed: '已完成', cancelled: '已停止', failed: '执行失败', interrupted: '已中断', recovery_required: '需要检查', waiting_confirmation: '待你确认' }[run.status] ?? run.status)

/** Lives above page navigation: a closed assistant or a different article must not hide background work. */
export function useAgentTasks() {
  const [runs, setRuns] = useState<AgentRunDTO[]>([])
  const [error, setError] = useState('')
  const refreshRef = useRef<() => void>(() => {})
  const refresh = useCallback(() => refreshRef.current(), [])
  useEffect(() => {
    let live = true, pending = false, again = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      if (pending) { again = true; return }
      pending = true; clearTimeout(timer)
      let active = false
      try {
        const result = await api.agentRuns()
        if (!live) return
        active = result.some(isActiveTask)
        setRuns(result); setError('')
      } catch { if (live) setError('任务状态暂时无法连接') }
      finally {
        pending = false
        if (live) { const delay = again ? 0 : active ? 1200 : 4000; again = false; timer = setTimeout(() => void load(), delay) }
      }
    }
    refreshRef.current = () => void load()
    void load()
    const unsubscribe = subscribeEvents(event => { if (event.type === 'hello' || event.type === 'notes-changed') void load() })
    const onFocus = () => void load()
    window.addEventListener('focus', onFocus)
    return () => { live = false; clearTimeout(timer); unsubscribe(); window.removeEventListener('focus', onFocus); refreshRef.current = () => {} }
  }, [])
  return { runs, error, refresh }
}

export function AgentTasks({ runs, error, refresh, collapsed, onOpen }: {
  runs: AgentRunDTO[]; error: string; refresh: () => void; collapsed: boolean; onOpen: (run: AgentRunDTO) => void
}) {
  const [open, setOpen] = useState(false)
  const [stopping, setStopping] = useState<string | null>(null)
  const [actionError, setActionError] = useState('')
  const [seenAt, setSeenAt] = useState(() => {
    const saved = Number(prefs.get('agent-tasks-seen'))
    const at = saved || Date.now(); if (!saved) prefs.set('agent-tasks-seen', String(at)); return at
  })
  const active = runs.filter(isActiveTask)
  const unread = runs.filter(run => !isActiveTask(run) && run.updatedAt > seenAt)
  const featured = active[0] ?? unread[0]
  const acknowledge = () => { const at = Date.now(); prefs.set('agent-tasks-seen', String(at)); setSeenAt(at) }
  const show = () => { setOpen(true); acknowledge(); refresh() }
  const visit = (run: AgentRunDTO) => { setOpen(false); acknowledge(); onOpen(run) }
  const stop = async (run: AgentRunDTO) => {
    setStopping(run.id); setActionError('')
    try { await api.stopAgentRun(run.id); refresh() }
    catch (cause) { setActionError((cause as Error).message) }
    finally { setStopping(null) }
  }
  const label = error ? 'AI 任务 · 连接中断' : active.length ? `AI 任务 · ${active.length} 项进行中` : unread.length ? `AI 任务 · ${unread.length} 项有更新` : 'AI 任务'
  return <div className="global-agent-tasks">
    <Button size="sm" variant={featured ? 'secondary' : 'ghost'} className="nav-item" aria-label={label} title={label} isIconOnly={collapsed} onPress={show}>
      <Icon name={active.length ? 'spark' : 'clock'} size={17}/>
      {!collapsed && <><span>{error ? '任务状态连接中断' : active.length ? 'AI 正在处理' : unread.length ? 'AI 任务有更新' : 'AI 任务'}</span>{!!(active.length || unread.length) && <span className="count">{active.length || unread.length}</span>}</>}
    </Button>
    {!collapsed && featured && <Button size="sm" variant="ghost" className="task-shortcut" title={'返回任务：' + taskTarget(featured)} aria-label={'返回任务：' + taskTarget(featured)} onPress={() => visit(featured)}><span className="task-shortcut-content"><span>{taskTarget(featured)}</span><span className="muted">{error ? '连接中断，点击查看' : isActiveTask(featured) ? <TextShimmer>{featured.activity || '正在处理…'}</TextShimmer> : statusText(featured)}</span></span><Icon name="arrow" size={14}/></Button>}
    <Dialog title="AI 任务" className="agent-tasks-dialog" open={open} onClose={() => setOpen(false)}>
      {(error || actionError) && <p role="alert" className="error-text">{actionError || error}<Button variant="secondary" size="sm" onPress={refresh}>刷新状态</Button></p>}
      {!runs.length && <p className="muted">还没有任务。向助手提出要求后，可在这里查看进展和结果。</p>}
      <div className="task-list">{runs.map(run => <section key={run.id} className="task-list-item" aria-label={taskTarget(run) + ' · ' + statusText(run)}>
        <div className="task-list-heading"><strong>{taskTarget(run)}</strong><span className="muted">{statusText(run)}</span></div>
        {run.request && <p className="task-request">{run.request}</p>}
        {isActiveTask(run) && <div className="task-current-step" role="status"><Icon name="spark" size={14}/><TextShimmer>{run.activity || '正在处理…'}</TextShimmer></div>}
        {run.error && !isActiveTask(run) && <p className="muted task-result">{run.error}</p>}
        <div className="task-list-actions"><Button size="sm" variant="secondary" onPress={() => visit(run)}>{isActiveTask(run) ? '返回任务' : run.status === 'waiting_confirmation' ? '查看提案' : '查看对话与改动'}</Button>{isActiveTask(run) && <Button size="sm" variant="secondary" isDisabled={stopping === run.id} onPress={() => void stop(run)}>{stopping === run.id ? '正在停止…' : '停止任务'}</Button>}</div>
      </section>)}</div>
    </Dialog>
  </div>
}
