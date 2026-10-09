import { useEffect, useRef, useState } from 'react'
import type { PublicAIConfig } from '../shared/types'
import { api } from './api'
import { Button, Icon, Input } from './ui'

function sameAddress(first: string, second: string): boolean {
  try { return new URL(first.trim()).toString().replace(/\/+$/, '') === new URL(second.trim()).toString().replace(/\/+$/, '') } catch { return false }
}

export function AIConnectionSettings({ config, onSaved }: { config: PublicAIConfig | null; onSaved: (next: PublicAIConfig) => void }) {
  const [model, setModel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [key, setKey] = useState('')
  const [visible, setVisible] = useState(false)
  const [busy, setBusy] = useState<'save' | 'test' | 'clear' | null>(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [removing, setRemoving] = useState(false)
  const pendingTest = useRef<AbortController | null>(null)
  useEffect(() => { if (config) { setModel(config.model); setBaseUrl(config.baseUrl); setKey(''); setVisible(false) } }, [config])
  useEffect(() => () => pendingTest.current?.abort(), [])
  const canReuse = Boolean(config?.keySaved && sameAddress(baseUrl, config.baseUrl))
  const ready = Boolean(config && model.trim() && baseUrl.trim() && (key.trim() || canReuse))
  async function act(action: 'save' | 'test' | 'clear') {
    if (busy) return
    setBusy(action); setError(''); setMessage('')
    const controller = new AbortController()
    if (action === 'test') pendingTest.current = controller
    try {
      const input = { model, baseUrl, ...(key.trim() ? { key: key.trim() } : {}) }
      if (action === 'test') { await api.testAIConnection(input, controller.signal); setMessage('连接正常，模型已响应。测试不会保存设置。') }
      else {
        const next = action === 'save' ? await api.saveAIConnection(input) : await api.clearAIConnection()
        setKey(''); setRemoving(false); onSaved(next)
        setMessage(action === 'save' ? '连接已保存在本机。' : '连接已移除。')
      }
    } catch (e) { if (!controller.signal.aborted) setError((e as Error).message) }
    finally { if (pendingTest.current === controller) pendingTest.current = null; setBusy(null) }
  }
  return <div className="settings-section ai-connection-settings">
    <div className="section-header"><h3>其他模型服务 · API 密钥</h3><span className="count">{!config ? '读取中…' : config.configured ? '已保存连接' : '未配置'}</span></div>
    <p className="muted">也可连接自己的 OpenAI 兼容服务。启用 ChatGPT 时优先使用 ChatGPT，需在上方明确切换才会改用此连接。</p>
    {config?.source === 'environment' && <p className="muted">当前使用本机启动时提供的连接。保存后，将使用这里的设置。</p>}
    <div className="ai-connection-fields">
      <label htmlFor="canvas-ai-url">服务地址</label>
      <Input id="canvas-ai-url" fullWidth type="url" value={baseUrl} placeholder="https://api.openai.com/v1" disabled={Boolean(busy) || !config} onChange={e => { setBaseUrl(e.target.value); setKey(''); setMessage(''); setError('') }}/>
      <label htmlFor="canvas-ai-model">模型名称</label>
      <Input id="canvas-ai-model" fullWidth value={model} placeholder="例如：gpt-4o-mini" maxLength={200} disabled={Boolean(busy) || !config} onChange={e => { setModel(e.target.value); setMessage('') }}/>
      <label htmlFor="canvas-ai-key">API 密钥</label>
      <div className="ai-key-field"><Input id="canvas-ai-key" fullWidth autoComplete="off" spellCheck={false} type={visible ? 'text' : 'password'} value={key} placeholder={canReuse ? '已保存在本机，留空保持不变' : '输入这个服务的 API 密钥'} disabled={Boolean(busy) || !config} onChange={e => { setKey(e.target.value); setMessage('') }}/><Button variant="ghost" size="sm" aria-label={visible ? '隐藏 API 密钥' : '显示 API 密钥'} onPress={() => setVisible(!visible)}>{visible ? '隐藏' : '显示'}</Button></div>
      <p className="muted">密钥保存在本机的笔记服务中，不保存在浏览器，也不随笔记同步。切换服务地址时需重新填写。</p>
    </div>
    {(error || config?.error) && <p className="error-text" role="alert">{error || config?.error}</p>}
    {message && <p className="ai-connection-message" role="status"><Icon name="check" size={14}/>{message}</p>}
    <div className="ai-connection-actions"><Button variant="outline" size="sm" isDisabled={!ready || Boolean(busy)} onPress={() => void act('test')}>{busy === 'test' ? '正在测试…' : '测试连接'}</Button><Button size="sm" isDisabled={!ready || Boolean(busy)} onPress={() => void act('save')}>{busy === 'save' ? '正在保存…' : '保存连接'}</Button>{busy === 'test' && <Button variant="ghost" size="sm" onPress={() => { pendingTest.current?.abort(); setMessage('已停止测试。') }}>停止测试</Button>}</div>
    <p className="muted ai-test-hint">测试会向所填服务发送一条简短消息，可能使用模型额度。修改笔记前会先显示预览。</p>
    {(config?.configured || config?.error) && !removing && <Button variant="ghost" size="sm" isDisabled={Boolean(busy)} onPress={() => setRemoving(true)}>移除连接</Button>}
    {removing && <div className="ai-remove-confirm"><p>移除后，本机不再保存这条连接的密钥。笔记内容会保留。</p><Button variant="tertiary" size="sm" isDisabled={Boolean(busy)} onPress={() => setRemoving(false)}>取消</Button><Button variant="danger" size="sm" isDisabled={Boolean(busy)} onPress={() => void act('clear')}>确认移除</Button></div>}
  </div>
}
