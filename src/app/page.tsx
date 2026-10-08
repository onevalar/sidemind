'use client';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { CanvasBoard } from '../components/canvas/CanvasBoard';
import { SelectionPopover } from '../components/SelectionPopover';
import { ChatInput } from '../components/ChatInput';
import { SettingsPage } from '../components/SettingsPage';
import { LinearChatView } from '../components/LinearChatView';
import { ContentOutline } from '../components/ContentOutline';
import { ConversationSpaces, ConversationLocation } from '../components/ConversationSpaces';
import { Button, Input, Icon, Dialog } from '../components/ui';
import { useTextSelection } from '../hooks/useTextSelection';
import { useChatStore } from '../store';
import { useStoreHydrated } from '../hooks/useStoreHydrated';
import { snapshotConversation } from '../history';
function subscribeAppearance(listener: () => void) {
  const media = matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener('change', listener);
  return () => media.removeEventListener('change', listener);
}
const systemIsDark = () => matchMedia('(prefers-color-scheme: dark)').matches;
export default function Home() {
  useTextSelection();
  const hydrated = useStoreHydrated();
  const state = useChatStore();
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [appearance, setAppearance] = useState<'system'|'light'|'dark'>(() => {
    if (typeof window === 'undefined') return 'system';
    const saved = localStorage.getItem('chatgit-appearance');
    return saved === 'light' || saved === 'dark' ? saved : 'system';
  });
  const [removeId, setRemoveId] = useState<string | null>(null);
  const systemDark = useSyncExternalStore(subscribeAppearance, systemIsDark, () => false);
  const resolvedTheme = appearance === 'system' ? (systemDark ? 'dark' : 'light') : appearance;
  useEffect(() => {
    document.documentElement.dataset.theme = 'linear-' + resolvedTheme;
  }, [resolvedTheme]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setSearchOpen(value => !value); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') { event.preventDefault(); setSettingsOpen(false); useChatStore.getState().resetToEmpty(); }
      if ((event.metaKey || event.ctrlKey) && event.key === ',') { event.preventDefault(); useChatStore.getState().setPendingSelection(null); setSettingsOpen(true); }
    };
    window.addEventListener('keydown', keydown); return () => window.removeEventListener('keydown', keydown);
  }, []);
  if (!hydrated) return <main className="app-loading">正在恢复工作区…</main>;
  const current = snapshotConversation(state, state.activeConversationId);
  const history = Object.values({ ...state.conversations, [current.id]: current }).filter(c => Object.keys(c.messages).length).sort((a,b) => b.updatedAt - a.updatedAt);
  const results = history.filter(c => (c.title + ' ' + Object.values(c.messages).map(m => m.content).join(' ')).toLowerCase().includes(search.toLowerCase()));
  const visibleHistory = state.activeSpaceId ? history.filter(c => state.conversationSpaces[c.id] === state.activeSpaceId) : history;
  const branchId = state.ui.activeBranchPanelId || state.rootBranchId;
  const branch = state.branches[branchId];
  const source = branch?.sourceMessageId && state.messages[branch.sourceMessageId];
  const sourceAnchor = branch?.sourceAnchorId && state.anchors[branch.sourceAnchorId];
  function choose(id: string) { state.switchConversation(id); setSearchOpen(false); setSettingsOpen(false); }
  function changeAppearance(value: 'system'|'light'|'dark') { setAppearance(value); localStorage.setItem('chatgit-appearance', value); }
  function closeSettings() {
    setSettingsOpen(false);
    requestAnimationFrame(() => document.getElementById('workspace-settings-trigger')?.focus());
  }
  function returnToSource() {
    if (!source) return;
    state.revealMessage(source.id);
  }
  return <main className="app-shell">
    <aside className="workspace-sidebar">
      <div className="workspace-brand"><span className="brand-symbol"><Icon name="branch" /></span><strong>ChatGit</strong><span className="workspace-badge">个人空间</span></div>
      <Button variant="outline" className="new-conversation" onPress={() => { setSettingsOpen(false); state.resetToEmpty(); }}><Icon name="plus" size={16} />新建对话<span>⌘ N</span></Button>
      <Button variant="ghost" className="sidebar-search" onPress={() => setSearchOpen(true)}><Icon name="search" size={16} />搜索对话<kbd>⌘ K</kbd></Button>
      <ConversationSpaces history={history} onNavigate={() => setSettingsOpen(false)}/>
      <div className="sidebar-section-label">{state.activeSpaceId ? '空间中的对话' : '最近对话'}<span>{visibleHistory.length}</span></div>
      <div className="conversation-history">{visibleHistory.map(c => <div key={c.id} className={'history-row ' + (c.id === current.id ? 'active' : '')}>
        <Button variant="ghost" aria-label={'打开对话：' + c.title} onPress={() => choose(c.id)}><Icon name="chat" size={15} /><span>{c.title}</span></Button>
        <Button variant="ghost" size="sm" isIconOnly aria-label={'删除对话：' + c.title} className="history-delete" onPress={() => setRemoveId(c.id)}><Icon name="trash" size={13} /></Button>
      </div>)}{!visibleHistory.length && <p className="history-empty">{state.activeSpaceId ? '在这个空间开始一段新对话。' : '你的思考会保存在这里。'}</p>}</div>
      <div className="sidebar-bottom"><Button variant="ghost" size="sm" onPress={() => {
        const next = appearance === 'system' ? 'light' : appearance === 'light' ? 'dark' : 'system'; changeAppearance(next);
      }}><Icon name="sun" size={16} />外观<span>{appearance === 'system' ? '跟随系统' : appearance === 'light' ? '浅色' : '深色'}</span></Button>
        <Button id="workspace-settings-trigger" variant={settingsOpen ? 'secondary' : 'ghost'} size="sm" aria-label="设置" aria-current={settingsOpen ? 'page' : undefined} onPress={() => { state.setPendingSelection(null); setSettingsOpen(true); }}><Icon name="settings" size={16}/>设置</Button><div className="local-account"><span className="account-avatar">我</span><div><strong>我的工作区</strong><small>对话仅保存在本机</small></div></div>
      </div>
    </aside>
    <section className="workspace-main">
      {settingsOpen && <SettingsPage appearance={appearance} resolvedTheme={resolvedTheme} onAppearanceChange={changeAppearance} onClose={closeSettings}/>}
      <div className="workspace-view" hidden={settingsOpen}>
      <header className="workspace-toolbar"><div className="conversation-title"><ConversationLocation/><span className="breadcrumb-separator">/</span><span>{current.title}</span>{source && <><span className="breadcrumb-separator">/</span><strong>{branch.label}</strong></>}</div>
        <div className="view-switch"><Button size="sm" variant={state.ui.viewMode === 'linear' ? 'secondary' : 'ghost'} onPress={() => state.setViewMode('linear')}><Icon name="chat" size={15} />对话</Button><Button size="sm" variant={state.ui.viewMode === 'canvas' ? 'secondary' : 'ghost'} onPress={() => state.setViewMode('canvas')}><Icon name="grid" size={15} />画布</Button></div>
      </header>
      <div className="workspace-content"><section className="conversation-pane">
        {state.ui.viewMode === 'canvas' ? <CanvasBoard theme={resolvedTheme} /> : <>
          {source && <div className="branch-source"><Button variant="ghost" size="sm" onPress={returnToSource}><Icon name="back" size={14} />返回引用位置</Button><blockquote>{sourceAnchor ? sourceAnchor.slice.selectedText : source.content.slice(0, 180)}</blockquote></div>}
          <LinearChatView key={state.activeConversationId + ':' + branchId} branchId={branchId} />
          {!Object.keys(state.messages).length && <Button className="demo-link" size="sm" variant="ghost" onPress={state.resetToMock}>查看示例对话</Button>}
          <ChatInput key={state.activeConversationId + ':' + branchId + ':input'} branchId={branchId} />
        </>}
      </section>{state.ui.viewMode === 'linear' && <ContentOutline branchId={branchId} />}</div>
      </div>
    </section>
    {!settingsOpen && <SelectionPopover />}
    <Dialog open={searchOpen} onClose={() => setSearchOpen(false)} title="搜索对话">
      <Input fullWidth autoFocus aria-label="搜索关键词" placeholder="搜索标题和对话内容…" value={search} onChange={event => setSearch(event.target.value)} />
      <div className="search-results">{results.map(c => <Button key={c.id} variant="ghost" onPress={() => choose(c.id)}><Icon name="chat" /><span>{c.title}<small>{Object.keys(c.messages).length} 条消息 · {new Date(c.updatedAt).toLocaleDateString()}</small></span></Button>)}{!results.length && <p className="field-help">没有匹配的对话。</p>}</div>
    </Dialog>
    <Dialog open={Boolean(removeId)} onClose={() => setRemoveId(null)} title="删除这个对话？" footer={<><Button variant="tertiary" onPress={() => setRemoveId(null)}>取消</Button><Button variant="danger" onPress={() => { if (removeId) state.deleteConversation(removeId); setRemoveId(null); }}>删除对话</Button></>}>
      <p className="field-help">对话、分支和共享结论将从本机移除，此操作无法撤销。</p>
    </Dialog>
  </main>;
}
