'use client';
import { useEffect, useRef, useState } from 'react';
import { useChatStore } from '../store';
import { Button, Input, Icon } from './ui';
import { connectionDefaults as defaults, connectionKey, conversationConnection, modelConnection } from '../connections';
import { ConnectionTest, type ConnectionTestResult } from '../connection-test';
import { snapshotConversation } from '../history';
import type { Provider } from '../types';

type Appearance = 'system' | 'light' | 'dark';
const sections = [
  { id: 'connection', label: '模型连接', icon: 'settings' },
  { id: 'data', label: '对话与数据', icon: 'chat' },
  { id: 'appearance', label: '外观', icon: 'sun' },
  { id: 'shortcuts', label: '快捷键', icon: 'grid' },
] as const;
type Section = typeof sections[number]['id'];

export function SettingsPage({ appearance, resolvedTheme, onAppearanceChange, onClose }: {
  appearance: Appearance; resolvedTheme: 'light' | 'dark';
  onAppearanceChange: (value: Appearance) => void; onClose: () => void;
}) {
  const state = useChatStore();
  const [section, setSection] = useState<Section>('connection');
  const [provider, setProvider] = useState(state.provider);
  const [key, setKey] = useState(state.apiKey);
  const [baseUrl, setBaseUrl] = useState(state.baseUrl);
  const [model, setModel] = useState(state.model);
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<ConnectionTestResult | null>(null);
  const [saved, setSaved] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const tester = useRef<ConnectionTest | null>(null);
  if (tester.current === null) tester.current = new ConnectionTest();
  useEffect(() => {
    heading.current?.focus();
    const pending = tester.current;
    return () => pending?.cancel();
  }, []);
  const current = conversationConnection(state);
  const conversations = Object.values({ ...state.conversations,
    [state.activeConversationId]: snapshotConversation(state, state.activeConversationId),
  }).filter(conversation => Object.keys(conversation.messages).length);
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  const shortcutModifier = isMac ? '⌘' : 'Ctrl';
  function invalidateTest() { tester.current?.cancel(); setTesting(false); setTest(null); setSaved(false); }
  function loadConnection(config: { provider: Provider; model: string; baseUrl: string }) {
    invalidateTest(); setProvider(config.provider); setBaseUrl(config.baseUrl); setModel(config.model);
    setKey(state.connectionCredentials[connectionKey(config)] || '');
  }
  function changeBaseUrl(value: string) {
    invalidateTest(); setBaseUrl(value);
    if (connectionKey({ provider, model, baseUrl: value }) !== connectionKey({ provider, model, baseUrl })) {
      setKey(state.connectionCredentials[connectionKey({ provider, model, baseUrl: value })] || '');
    }
  }
  async function testConnection() {
    setTesting(true); setTest(null); setSaved(false);
    const result = await tester.current!.run({ provider, model, baseUrl }, key);
    if (result) { setTest(result); setTesting(false); }
  }
  function save() {
    tester.current?.cancel(); setTesting(false);
    const config = modelConnection({ provider, model, baseUrl });
    state.saveConnection(config, key); setModel(config.model); setBaseUrl(config.baseUrl); setKey(key.trim()); setSaved(true);
  }
  function chooseSection(value: Section) {
    if (value !== section) { tester.current?.cancel(); setTesting(false); setTest(null); setSection(value); }
  }
  return <div className="settings-view">
    <header className="workspace-toolbar settings-toolbar"><h1>设置</h1><Button variant="ghost" size="sm" onPress={onClose}><Icon name="back" size={15}/>返回对话</Button></header>
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="设置分类">{sections.map(item => <Button key={item.id} variant={section === item.id ? 'secondary' : 'ghost'} aria-current={section === item.id ? 'page' : undefined} onPress={() => chooseSection(item.id)}><Icon name={item.icon} size={16}/>{item.label}</Button>)}</nav>
      <div className="settings-scroll"><div className="settings-sheet">
        <div className="settings-page-heading"><h2 ref={heading} tabIndex={-1}>{sections.find(item => item.id === section)!.label}</h2><p>{section === 'connection' ? '连接你自己的模型服务，随时切换。' : section === 'data' ? '你的思考保存在当前浏览器，随时回来继续。' : section === 'appearance' ? '选择适合你的阅读环境。' : '用熟悉的按键，让思路流动得更自然。'}</p></div>
        <section hidden={section !== 'connection'} aria-label="模型连接设置" className="connection-settings-panel">
          <div className="connection-summary"><div className="connection-identity"><span className="connection-symbol"><Icon name="branch" size={20}/></span><div><strong>{defaults[provider].name}</strong><p>用于新对话的默认服务</p></div></div><span className={'connection-badge ' + (test?.kind === 'success' ? 'is-success' : '')}>{testing ? '测试中' : test?.kind === 'success' ? '测试成功' : key.trim() ? '未测试' : '未配置密钥'}</span></div>
          <form className="connection-settings-form" onSubmit={event => { event.preventDefault(); save(); }}>
            <div className="settings-field"><label htmlFor="model-name">默认模型</label><Input id="model-name" fullWidth maxLength={200} value={model} onChange={event => { invalidateTest(); setModel(event.target.value); }} placeholder={defaults[provider].model}/><p>已有对话与分支会保留原先的模型和服务地址。</p></div>
            <div className="settings-field"><label htmlFor="base-url">API 地址 <span>可选</span></label><Input id="base-url" fullWidth type="url" value={baseUrl} onChange={event => changeBaseUrl(event.target.value)} placeholder={defaults[provider].url}/><p>使用服务商地址或兼容的自定义端点。切换地址后，请为新连接配置密钥。</p></div>
            <div className="settings-field"><label htmlFor="api-key">API 密钥</label><div className="key-field"><Input id="api-key" fullWidth autoComplete="off" type={showKey ? 'text' : 'password'} value={key} onChange={event => { invalidateTest(); setKey(event.target.value); }} placeholder="输入你的 API Key"/><Button type="button" variant="ghost" size="sm" aria-pressed={showKey} onPress={() => setShowKey(!showKey)}>{showKey ? '隐藏' : '显示'}</Button></div><p>保存在当前浏览器，按服务商与地址区分。留空保存会清除当前连接的密钥。</p></div>
            <div className="settings-actions"><Button type="button" variant="outline" isDisabled={!key.trim() && !testing} onPress={() => {
              if (testing) { tester.current?.cancel(); setTesting(false); setTest({ kind: 'stopped', message: '测试已停止。' }); }
              else void testConnection();
            }}><Icon name={testing ? 'stop' : 'settings'} size={15}/>{testing ? '停止测试' : '测试连接'}</Button><Button type="submit" variant="primary">保存更改</Button></div>
            <p className="settings-test-help">{testing ? '正在等待模型回复，可随时停止。' : '测试会发送一次最小请求，可能产生少量用量；测试不会保存设置。'}</p>
            {test && <p className={test.kind === 'success' ? 'test-success' : test.kind === 'stopped' ? 'field-help' : 'error-note'} role="status">{test.message}</p>}
            {saved && <p className="settings-save-status" role="status">设置已保存。已有对话继续使用原来的连接。</p>}
          </form>
          <div className="other-connections"><div><h3>其他模型服务</h3><p>选择服务商，再填写你的模型与连接信息。</p></div><div className="provider-options" aria-label="选择模型服务商">{(Object.keys(defaults) as Provider[]).map(value => <Button key={value} size="sm" variant={provider === value ? 'secondary' : 'outline'} aria-pressed={provider === value} onPress={() => loadConnection(state.providerConnections[value] || { provider: value, model: '', baseUrl: '' })}>{defaults[value].name}</Button>)}</div></div>
          {state.conversationModels[state.activeConversationId] && <div className="current-connection"><div><span>当前对话的连接</span><strong>{current.model}</strong><span>{defaults[current.provider].name}</span></div><Button variant="outline" size="sm" onPress={() => loadConnection(current)}>载入连接设置</Button></div>}
          <p className="settings-privacy">请求时，本应用服务端会将密钥和对话上下文转交给你选择的模型服务。对话历史保存在本机。</p>
        </section>
        {section === 'data' && <section className="settings-data-panel" aria-label="本机对话数据"><dl className="settings-data-counts"><div><dt>已保存的对话</dt><dd>{conversations.length}</dd></div><div><dt>对话与分支</dt><dd>{conversations.reduce((sum, conversation) => sum + Object.keys(conversation.branches).length, 0)}</dd></div></dl><div className="settings-info-row"><h3>保存在这台设备</h3><p>对话、分支、空间和共享结论保存在当前浏览器的本地存储中。清除网站数据、使用其他浏览器或其他设备时，这些内容不会自动出现。</p></div><div className="settings-info-row"><h3>每段对话保留自己的模型</h3><p>更换默认模型只影响新对话。你可以在模型连接中载入当前对话的配置，替换或清除该连接的密钥。</p></div><Button variant="outline" onPress={() => { state.setActiveSpace(null); onClose(); }}>返回所有对话</Button></section>}
        {section === 'appearance' && <section className="settings-appearance-panel" aria-label="外观设置"><div className="appearance-options">{(['light', 'dark', 'system'] as Appearance[]).map(value => <Button key={value} className="appearance-option" variant="outline" aria-pressed={appearance === value} onPress={() => onAppearanceChange(value)}><span className="appearance-preview" data-theme={'linear-' + (value === 'system' ? resolvedTheme : value)} aria-hidden="true"><span/><span><i/><i/><i/></span></span><span>{value === 'light' ? '浅色' : value === 'dark' ? '深色' : '跟随系统'}</span></Button>)}</div><p className="field-help">外观会应用到整个工作区。跟随系统会自动响应系统的浅色与深色切换。</p></section>}
        {section === 'shortcuts' && <section aria-label="键盘快捷键" className="settings-shortcuts">{[
          ['新建对话', `${shortcutModifier} N`], ['搜索对话', `${shortcutModifier} K`], ['打开设置', `${shortcutModifier} ,`], ['发送消息', 'Enter'], ['在消息中换行', 'Shift Enter'],
        ].map(([label, shortcut]) => <div key={label}><span>{label}</span><kbd>{shortcut}</kbd></div>)}</section>}
      </div></div>
    </div>
  </div>;
}
