import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { PushReport, RepoStatus } from '../shared/types'
import { api, subscribeEvents } from './api'
import { Button, Dialog, Icon, Input } from './ui'

const kindLabel: Record<string, string> = { new: '新建', deleted: '删除', wording: '措辞', addition: '新增内容', semantic: '关键表述', unchanged: '未改正文' }
const memoryLabel: Record<string, string> = { updated: '已更新记忆', unchanged: '记忆无需更新', pending: '记忆待补', removed: '已删除记忆', moved: '记忆随文件移动' }

/**
 * The single 推送 button: reads changes, lets the summary model update memory and write the
 * commit message, commits and pushes. Saving stays automatic; committing is the user's choice.
 */
export function PushControl({ beforeLeave, collapsed }: { beforeLeave: MutableRefObject<() => Promise<boolean>>; collapsed: boolean }) {
  const [status, setStatus] = useState<RepoStatus | null>(null)
  const [open, setOpen] = useState(false)
  const [running, setRunning] = useState(false)
  const [steps, setSteps] = useState<string[]>([])
  const [warnings, setWarnings] = useState<string[]>([])
  const [report, setReport] = useState<PushReport | null>(null)
  const [error, setError] = useState('')
  const controller = useRef<AbortController | null>(null)
  const refresh = useCallback(async () => { try { setStatus(await api.repoStatus()) } catch { setStatus(null) } }, [])
  useEffect(() => {
    void refresh()
    let timer: ReturnType<typeof setTimeout>
    const unsubscribe = subscribeEvents(event => {
      if (event.type === 'hello' || event.type === 'notes-changed' || event.type === 'canvas-changed' || event.type === 'memory-changed' || event.type === 'repo-changed') { clearTimeout(timer); timer = setTimeout(() => void refresh(), 400) }
    })
    return () => { clearTimeout(timer); unsubscribe() }
  }, [refresh])
  useEffect(() => () => controller.current?.abort(), [])

  const push = async () => {
    if (running) return
    setOpen(true); setRunning(true); setSteps([]); setWarnings([]); setReport(null); setError('')
    const abort = new AbortController()
    controller.current = abort
    try {
      if (!await beforeLeave.current()) throw new Error('请先处理尚未保存的文章或画布位置，再推送。')
      await api.push(event => {
        if (event.type === 'step') setSteps(current => [...current, event.text])
        else if (event.type === 'note') setSteps(current => [...current, `${event.name} · ${kindLabel[event.kind] ?? event.kind}${event.detail ? '：' + event.detail : ''}`])
        else if (event.type === 'warning') setWarnings(current => [...current, event.text])
        else if (event.type === 'report') setReport(event.report)
        else if (event.type === 'error') setError(event.text)
      }, abort.signal)
    } catch (caught) { setError(abort.signal.aborted ? '已停止推送。已更新的记忆保留在工作区，下次推送时一起提交。' : (caught as Error).message) }
    finally { setRunning(false); controller.current = null; void refresh() }
  }
  const pending = status?.git ? status.changes + (status.ahead ?? 0) : 0
  const label = !status ? '推送' : !status.git ? '推送不可用：未找到 Git' : pending ? `推送 · ${status.changes} 处改动${status.ahead ? `，${status.ahead} 个未推送提交` : ''}` : '推送 · 没有新改动'
  return <>
    <button type="button" className="nav-item push-item" aria-label={label} title={label} disabled={!status?.git || running} onClick={() => void push()}>
      <Icon name="send" size={18}/><span>{running ? '正在推送…' : '推送'}</span>{!collapsed && !!status?.changes && <span className="count">{status.changes}</span>}
    </button>
    <Dialog title="推送" open={open} onClose={() => { if (!running) setOpen(false) }} footer={running
      ? <Button variant="ghost" onPress={() => controller.current?.abort()}>停止</Button>
      : <Button onPress={() => setOpen(false)}>完成</Button>}>
      <div className="push-dialog" aria-busy={running}>
        <ol className="push-steps" aria-label="推送进度">{steps.map((step, index) => <li key={index}><Icon name={index === steps.length - 1 && running ? 'arrow' : 'check'} size={13}/><span>{step}</span></li>)}</ol>
        {running && !steps.length && <p className="muted" role="status">正在准备…</p>}
        {warnings.map((warning, index) => <p key={index} className="push-warning" role="status">{warning}</p>)}
        {error && <p className="ai-error" role="alert">{error}</p>}
        {report && <section className="push-report" aria-label="推送结果">
          <p role="status"><strong>{report.committed ? `已提交 ${report.committed}` : '没有需要提交的改动'}</strong>{' · '}{report.pushed ? '已推送到远端' : report.pushError ?? '未推送'}</p>
          {report.message && <pre className="push-message">{report.message}</pre>}
          {!!report.notes.length && <ul className="push-notes">{report.notes.map(note => <li key={note.name}><span title={note.name}>{note.name}</span><span className="muted">{kindLabel[note.kind] ?? note.kind} · {memoryLabel[note.memory]}</span></li>)}</ul>}
          {!!report.stale.length && <div className="push-stale"><strong>依据已变化，建议核对：</strong><ul>{report.stale.map(item => <li key={item.name}>{item.name}：{item.because}</li>)}</ul></div>}
          {!!report.layout.length && <p className="muted">画布：{report.layout.join('；')}</p>}
        </section>}
      </div>
    </Dialog>
  </>
}

/** Settings: where the data repository lives and which remote 推送 sends to. */
export function RepoSettings() {
  const [status, setStatus] = useState<RepoStatus | null>(null)
  const [url, setUrl] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => { api.repoStatus().then(value => { setStatus(value); setUrl(value.remote ?? '') }, caught => setError((caught as Error).message)) }, [])
  const save = async () => {
    setSaving(true); setError(''); setMessage('')
    try { const next = await api.setRemote(url.trim() || null); setStatus(next); setMessage(next.remote ? '远端已保存，下次推送时使用。' : '已移除远端，推送只在本机提交。') }
    catch (caught) { setError((caught as Error).message) }
    finally { setSaving(false) }
  }
  return <div className="settings-section">
    <h3>数据仓库</h3>
    <p className="muted">笔记（notes/）、记忆（memory/）和画布布局（canvas/）在同一个 Git 仓库中。内容实时自动保存；点击侧栏「推送」时才提交并推送。</p>
    <code className="setting-path">{status?.dataDirectory ?? '正在读取…'}</code>
    {status && !status.git && <p className="error-text">未找到 git，推送不可用。安装 Git 后重启笔记服务。</p>}
    {status?.git && <form className="repo-remote" onSubmit={event => { event.preventDefault(); void save() }}>
      <label htmlFor="repo-remote-url">远端仓库地址</label>
      <div className="ai-key-field"><Input id="repo-remote-url" fullWidth value={url} placeholder="git@github.com:you/notes.git" spellCheck={false} autoComplete="off" disabled={saving} onChange={event => { setUrl(event.target.value); setMessage('') }}/><Button type="submit" size="sm" isDisabled={saving || url.trim() === (status.remote ?? '')}>{saving ? '正在保存…' : '保存'}</Button></div>
      <p className="muted">使用这台电脑上 Git 已有的登录方式（SSH 密钥或凭据管理器），应用不保存 Git 密码。当前分支：{status.branch}{status.head ? ` · 最近提交 ${status.head}` : ' · 尚未提交'}</p>
    </form>}
    {message && <p className="ai-connection-message" role="status"><Icon name="check" size={14}/>{message}</p>}
    {error && <p className="error-text" role="alert">{error}</p>}
  </div>
}
