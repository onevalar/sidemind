import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { RepoStatus, SyncJobDTO } from '../shared/types'
import { api, subscribeEvents } from './api'
import { Accordion, Button, Dialog, Icon, Input } from './ui'

const kindLabel: Record<string, string> = { new: '新建', deleted: '删除', wording: '措辞', addition: '新增内容', semantic: '关键表述', unchanged: '未改正文' }
const active = (job: SyncJobDTO | null) => job?.status === 'running' || job?.status === 'stopping'

/** The server owns sync. This control observes it; dismissing details never cancels work. */
export function PushControl({ beforeLeave, collapsed }: { beforeLeave: MutableRefObject<() => Promise<boolean>>; collapsed: boolean }) {
  const [status, setStatus] = useState<RepoStatus | null>(null)
  const [job, setJob] = useState<SyncJobDTO | null>(null)
  const [open, setOpen] = useState(false)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')
  const [connectionError, setConnectionError] = useState('')
  const mounted = useRef(true)
  const inFlight = useRef(false)
  const refresh = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      const [repo, next] = await Promise.all([api.repoStatus(), api.syncStatus()])
      if (mounted.current) { setStatus(repo); setJob(current => !current ? next : next && next.updatedAt >= current.updatedAt ? next : current); setConnectionError('') }
    } catch (caught) { if (mounted.current) setConnectionError('无法读取同步状态：' + (caught as Error).message) }
    finally { inFlight.current = false }
  }, [])
  const running = active(job) || starting
  useEffect(() => {
    mounted.current = true
    void refresh()
    const timer = setInterval(() => void refresh(), running || open ? 1000 : 10000)
    const unsubscribe = subscribeEvents(event => { if (event.type === 'hello' || event.type === 'repo-changed' || event.type === 'notes-changed') void refresh() })
    return () => { mounted.current = false; clearInterval(timer); unsubscribe() }
  }, [refresh, running, open])

  const start = async (enrich = false) => {
    if (running) { setOpen(true); return }
    setStarting(true); setError('')
    try {
      if (!await beforeLeave.current()) throw new Error('请先处理未保存的修改，再同步。')
      const next = await api.startSync({ enrich })
      if (mounted.current) setJob(next)
    } catch (caught) { if (mounted.current) { setError((caught as Error).message); setOpen(true) } }
    finally { if (mounted.current) setStarting(false) }
  }
  const stop = async () => {
    if (!job || !active(job)) return
    try { setJob(await api.stopSync(job.id)) } catch (caught) { setError((caught as Error).message) }
  }
  const report = job?.report
  const failed = !!error || !!connectionError || job?.status === 'failed' || job?.status === 'interrupted' || !!(report?.pushError && status?.remote)
  const title = starting ? '正在准备同步' : active(job) ? job?.enrich ? '正在整理 AI 记忆' : '正在同步' : failed ? '同步需要处理' : job?.status === 'cancelled' ? '同步已停止' : report?.pushed ? '已与远端同步' : report ? '已保存到本机' : '同步'
  const pending = status?.git ? status.changes + (status.ahead ?? 0) : 0
  const label = running ? title + ' · 查看进度' : !status ? '正在读取同步状态' : !status.git ? '同步不可用：未找到 Git' : pending ? `同步 · ${status.changes} 处改动${status.ahead ? `，${status.ahead} 个待同步提交` : ''}` : status.remote ? '同步 · 检查远端更新' : '同步 · 未配置远端'
  const warnings = [...new Set(job?.events.flatMap(event => event.type === 'warning' ? [event.text] : []) ?? [])]
  const steps = job?.events.filter(event => event.type === 'step') ?? []
  const pendingMemory = report?.notes.filter(note => note.memory === 'pending') ?? []
  return <>
    <div className="sync-control">
      <Button variant="ghost" size="sm" className="nav-item push-item" aria-label={label} title={label} isDisabled={!status?.git || starting} onPress={() => { if (collapsed && job) setOpen(true); else void start() }}>
        <Icon name={failed ? 'clock' : 'sync'} size={18}/><span>{running ? '同步中' : failed ? '需处理' : report && !pending ? report.pushed ? '已同步' : '已存本机' : '同步'}</span>{!collapsed && !running && !!status?.noteChanges && <span className="count">{status.noteChanges}</span>}
      </Button>
      {!collapsed && (job || error) && <Button variant="ghost" size="sm" isIconOnly aria-label="同步详情" title={title} onPress={() => setOpen(true)}><Icon name="more" size={16}/></Button>}
      <span className="sync-announcement" role="status">{title}</span>
    </div>
    <Dialog title={job?.enrich ? 'AI 记忆整理' : '同步'} open={open} onClose={() => setOpen(false)} footer={<>
      {active(job) ? <Button variant="ghost" isDisabled={job?.status === 'stopping'} onPress={() => void stop()}>{job?.status === 'stopping' ? '正在停止…' : '停止任务'}</Button> : <Button variant="ghost" isDisabled={starting || !status?.git} onPress={() => void start()}>{failed ? '重试同步' : '再次同步'}</Button>}
      <Button onPress={() => setOpen(false)}>{running ? '后台继续' : '完成'}</Button>
    </>}>
      <div className="sync-details">
        <section aria-label="同步结果" className="sync-summary">
          <h3>{title}</h3>
          {running ? <p role="status">{starting ? '正在保存当前修改…' : job?.activity || '正在准备…'}</p> : <p>{report?.pushed ? '本机改动与远端已同步。' : report && !status?.remote ? '尚未配置远端仓库，本次只保存在本机。' : job?.status === 'cancelled' ? '任务已停止，已完成的本机改动会保留。' : '可从左下角开始同步。'}</p>}
          {running && <p className="muted">可关闭此窗口继续使用，刷新后也能查看进度。</p>}
          {!!report && <p className="muted">{report.notes.length} 篇笔记 · {report.layout.length} 项画布记录{report.committed ? ` · 本机版本 ${report.committed}` : ''}</p>}
          {(error || connectionError || job?.error || failed && report?.pushError) && <p className="ai-error" role="alert">{error || connectionError || job?.error || report?.pushError}</p>}
        </section>
        {report && !!pendingMemory.length && <Accordion defaultOpen={-1} items={[{ title: `AI 记忆 · ${pendingMemory.length} 篇待整理`, content: <p className="muted">日常同步只保存和传输数据，不再等待 AI 整理。笔记已保存，记忆状态不代表同步失败。</p> }]}/>}
        {(!!warnings.length || !!report?.stale.length) && <Accordion defaultOpen={-1} items={[{ title: `需要留意 · ${warnings.length + (report?.stale.length ?? 0)}`, content: <ul className="sync-detail-list">{warnings.map(text => <li key={text}>{text}</li>)}{report?.stale.map(item => <li key={item.name}>{item.name}：{item.because}</li>)}</ul> }]}/>}
        {report && <Accordion defaultOpen={-1} items={[{ title: '查看本次内容', content: <div className="sync-records">
          {report.message && <p className="sync-commit-message">{report.message}</p>}
          <ul className="sync-detail-list">{report.notes.map(note => <li key={note.name}><span>{note.name}</span><span className="muted">{kindLabel[note.kind] ?? note.kind}</span></li>)}</ul>
          {!!report.layout.length && <ul className="sync-detail-list">{report.layout.map(text => <li key={text}>{text}</li>)}</ul>}
        </div> }]}/>}
        {!!steps.length && <Accordion defaultOpen={-1} items={[{ title: '运行记录', content: <ol className="sync-detail-list">{steps.map((event, index) => <li key={index}>{event.type === 'step' ? event.text : ''}</li>)}</ol> }]}/>}
      </div>
    </Dialog>
  </>
}

/** Settings: where the data repository lives and which remote 同步 uses. */
export function RepoSettings() {
  const [status, setStatus] = useState<RepoStatus | null>(null)
  const [url, setUrl] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => { api.repoStatus().then(value => { setStatus(value); setUrl(value.remote ?? '') }, caught => setError((caught as Error).message)) }, [])
  const save = async () => {
    setSaving(true); setError(''); setMessage('')
    try { const next = await api.setRemote(url.trim() || null); setStatus(next); setMessage(next.remote ? '远端已保存，下次同步时使用。' : '已移除远端，同步只在本机提交。') }
    catch (caught) { setError((caught as Error).message) }
    finally { setSaving(false) }
  }
  return <div className="settings-section">
    <h3>数据仓库</h3>
    <p className="muted">笔记、记忆和画布布局在同一个 Git 仓库中。内容实时自动保存；点击侧栏「同步」时提交本机改动、拉取远端更新并上传。未配置远端时只在本机提交；笔记正文冲突需手动处理。</p>
    <code className="setting-path">{status?.dataDirectory ?? '正在读取…'}</code>
    {status && !status.git && <p className="error-text">未找到 git，同步不可用。安装 Git 后重启笔记服务。</p>}
    {status?.git && <form className="repo-remote" onSubmit={event => { event.preventDefault(); void save() }}>
      <label htmlFor="repo-remote-url">远端仓库地址</label>
      <div className="ai-key-field"><Input id="repo-remote-url" fullWidth value={url} placeholder="git@github.com:you/notes.git" spellCheck={false} autoComplete="off" disabled={saving} onChange={event => { setUrl(event.target.value); setMessage('') }}/><Button type="submit" size="sm" isDisabled={saving || url.trim() === (status.remote ?? '')}>{saving ? '正在保存…' : '保存'}</Button></div>
      <p className="muted">使用这台电脑上 Git 已有的登录方式（SSH 密钥或凭据管理器），应用不保存 Git 密码。当前分支：{status.branch}{status.head ? ` · 最近提交 ${status.head}` : ' · 尚未提交'}</p>
    </form>}
    {message && <p className="ai-connection-message" role="status"><Icon name="check" size={14}/>{message}</p>}
    {error && <p className="error-text" role="alert">{error}</p>}
  </div>
}
