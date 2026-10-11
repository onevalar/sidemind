import { useEffect, useRef, useState } from 'react'
import type { PublicChatGPTConfig } from '../shared/types'
import { api } from './api'
import { Button, Select } from './ui'

export function ChatGPTSettings({ config, onSaved }: { config: PublicChatGPTConfig | null; onSaved: (config: PublicChatGPTConfig) => void }) {
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [models, setModels] = useState<{ slug: string; displayName: string }[]>([])
  const [removing, setRemoving] = useState<string | null>(null)
  const saved = useRef(onSaved)
  saved.current = onSaved
  useEffect(() => {
    if (config?.loginStatus !== 'waiting') return
    let active = true, timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try { const next = await api.chatGPT(); if (active) { saved.current(next); if (next.loginStatus === 'waiting') timer = setTimeout(() => void poll(), 1000) } }
      catch (error) { if (active) setError((error as Error).message) }
    }
    timer = setTimeout(() => void poll(), 1000)
    return () => { active = false; clearTimeout(timer) }
  }, [config?.loginStatus])
  useEffect(() => {
    setModels([])
    if (!config?.configured) return
    let active = true
    void api.chatGPTModels().then(models => { if (active) setModels(models) }).catch(error => { if (active) setError((error as Error).message) })
    return () => { active = false }
  }, [config?.activeAccountId, config?.configured])
  async function act(action: () => Promise<PublicChatGPTConfig>) {
    if (busy) return
    setBusy(true); setError('')
    try { onSaved(await action()); setRemoving(null) }
    catch (error) { setError((error as Error).message) }
    finally { setBusy(false) }
  }
  async function login(accountId?: string) {
    if (busy || !local) return
    const popup = window.open('about:blank', '_blank')
    if (!popup) { setError('登录页被浏览器拦截，请允许弹出窗口后重试。'); return }
    popup.opener = null
    setBusy(true); setError('')
    try {
      const { authorizationUrl } = await api.loginChatGPT(accountId)
      popup.location.replace(authorizationUrl)
      onSaved(await api.chatGPT())
    } catch (error) { popup.close(); setError((error as Error).message) }
    finally { setBusy(false) }
  }
  const waiting = config?.loginStatus === 'waiting'
  return <div className="settings-section chatgpt-settings">
    <div className="section-header"><h3>ChatGPT</h3><span className="count">{config?.configured ? '当前使用' : config?.activeAccountId ? '需要重新连接' : '未启用'}</span></div>
    <p className="muted">通过官方登录使用符合条件的 ChatGPT 方案，不需要粘贴 API 密钥。登录不会授予读取 ChatGPT 对话的权限。</p>
    {!local && <p className="connection-note">这是远程预览。请在自己的电脑上运行笔记服务，再使用 ChatGPT 登录；官方回调需返回运行服务的同一台电脑。</p>}
    {config?.accounts.map(account => <div className="chatgpt-account" key={account.id}><span>{account.label}</span>{account.id === config.activeAccountId && <span className="count">已选择</span>}<Button size="sm" variant="outline" isDisabled={busy || waiting || (!account.signedIn && !local)} onPress={() => account.signedIn ? void act(() => api.selectChatGPT(account.id)) : void login(account.id)}>{account.signedIn ? '使用此账号' : '重新登录'}</Button><Button variant="ghost" size="sm" isDisabled={busy || waiting || !account.signedIn} onPress={() => setRemoving(account.id)}>退出</Button></div>)}
    {config?.configured && <div className="ai-connection-fields"><Select id="chatgpt-model" label="ChatGPT 模型" value={config.model} disabled={busy || !models.length} onValueChange={value => void act(() => api.selectChatGPT(config.activeAccountId, value))} options={models.length ? models.map(model => ({ value: model.slug, label: model.displayName })) : [{ value: config.model, label: config.model + ' · 读取可用模型中' }]}/></div>}
    <div className="ai-connection-actions"><Button variant="outline" isDisabled={!local || !config || busy || waiting} onPress={() => void login()}>Continue with ChatGPT</Button>{waiting && <Button variant="ghost" isDisabled={busy} onPress={() => void act(api.cancelChatGPTLogin)}>取消登录</Button>}{config?.activeAccountId && <Button variant="ghost" isDisabled={busy || waiting} onPress={() => void act(() => api.selectChatGPT(null))}>改用 API 密钥连接</Button>}</div>
    <div role="status">{waiting && <p className="muted">请在登录页完成授权。连接后这里会自动更新。</p>}{config?.configured && <p className="muted">仅在你发送修改要求时使用模型。额度与授权可在 <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">ChatGPT 使用设置</a> 中管理。</p>}</div>
    {(error || config?.error) && <p role="alert" className="error-text">{error || config?.error}</p>}
    {removing && <div className="ai-remove-confirm"><p>退出后清除本机登录凭据，并尝试撤销远程会话。文章不会删除，之后仍可重新登录。</p><Button variant="ghost" size="sm" isDisabled={busy} onPress={() => setRemoving(null)}>取消</Button><Button variant="danger" size="sm" isDisabled={busy} onPress={() => void act(() => api.logoutChatGPT(removing))}>确认退出</Button></div>}
  </div>
}
