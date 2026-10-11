import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { Viewport } from '@xyflow/react'
import type { NoteSummary } from '../shared/types'
import { api, subscribeEvents } from './api'
import { LibraryCanvas } from './LibraryCanvas'
import { NotePreview } from './NotePreview'
import { AIConnectionSettings } from './AIConnectionSettings'
import { ChatGPTSettings } from './ChatGPTSettings'
import { QuickSearch } from './QuickSearch'
import { captureContent } from './note-links'
import { Button, Dialog, Icon, IconButton, Input, TextArea, Select, SegmentedControl } from './ui'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/arc/tabs/tabs'

const loadNoteWorkspace = () => import('./NoteWorkspace')

type Theme = 'system' | 'light' | 'dark'
const darkPreference = () => matchMedia('(prefers-color-scheme: dark)')
const subscribeAppearance = (listener: () => void) => { const media = darkPreference(); media.addEventListener('change', listener); return () => media.removeEventListener('change', listener) }
const folderLabel = (folder: string) => folder || '笔记文件夹'

export function App() {
  const [NoteWorkspace, setNoteWorkspace] = useState<typeof import('./NoteWorkspace')['NoteWorkspace'] | null>(null)
  const [notes, setNotes] = useState<NoteSummary[]>([])
  const [folders, setFolders] = useState<string[]>([''])
  const [selected, setSelected] = useState<string | null>(null)
  const [space, setSpace] = useState('')
  const [preview, setPreview] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [openingFolder, setOpeningFolder] = useState(false)
  const folderRequest = useRef(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [referenceOpen, setReferenceOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [capture, setCapture] = useState('')
  const [destination, setDestination] = useState('')
  const [references, setReferences] = useState<NoteSummary[]>([])
  const [formError, setFormError] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settings, setSettings] = useState<Awaited<ReturnType<typeof api.settings>> | null>(null)
  const [newFolderOpen, setNewFolderOpen] = useState(false)
  const [folderName, setFolderName] = useState('')
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('canvas.theme') as Theme) || 'system')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('canvas.sidebar-collapsed') === 'true')
  const [views] = useState(() => { try { return new Map<string, Viewport>(JSON.parse(localStorage.getItem('canvas.views') || '[]')) } catch { return new Map<string, Viewport>() } })
  const systemDark = useSyncExternalStore(subscribeAppearance, () => darkPreference().matches, () => false)
  const resolvedTheme = theme === 'system' ? systemDark ? 'dark' : 'light' : theme
  const beforeLeave = useRef<() => Promise<boolean>>(async () => true)
  const creating = useRef(false)
  const requestVersion = useRef(0)
  const navigationVersion = useRef(0)
  const newAction = useRef<() => void>(() => {})
  const refreshList = useCallback(async () => {
    const revision = ++requestVersion.current
    try {
      const [notes, folders] = await Promise.all([api.listNotes(), api.listFolders()])
      if (revision !== requestVersion.current) return
      setNotes(notes); setFolders(folders); setLoaded(true); setError('')
    } catch (error) { if (revision === requestVersion.current) setError('无法读取笔记：' + (error as Error).message) }
  }, [])
  useEffect(() => {
    void refreshList()
    return subscribeEvents(event => { if (event.type === 'notes-changed' || event.type === 'hello') void refreshList() })
  }, [refreshList])
  useEffect(() => {
    if (!loaded) return
    // Show the canvas first, then warm the small editor chunk without loading language grammars.
    let active = true
    const preload = () => { void loadNoteWorkspace().then(module => { if (active) setNoteWorkspace(() => module.NoteWorkspace) }).catch(() => {}) }
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(preload)
      return () => { active = false; window.cancelIdleCallback(id) }
    }
    const timer = setTimeout(preload, 1000)
    return () => { active = false; clearTimeout(timer) }
  }, [loaded])
  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme
    localStorage.setItem('canvas.theme', theme)
  }, [theme, resolvedTheme])
  useEffect(() => { localStorage.setItem('canvas.sidebar-collapsed', String(sidebarCollapsed)) }, [sidebarCollapsed])
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.repeat || event.altKey || event.shiftKey || !(event.metaKey || event.ctrlKey)) return
      if (event.key.toLowerCase() === 'k') { event.preventDefault(); setSearchOpen(value => !value) }
      if (event.key.toLowerCase() === 'n' && !document.querySelector('[role="dialog"]')) { event.preventDefault(); newAction.current() }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])
  useEffect(() => {
    let active = true
    void api.settings().then(value => { if (active) setSettings(value) }).catch(error => { if (active) setError((error as Error).message) })
    return () => { active = false }
  }, [settingsOpen])

  const navigate = useCallback(async (name: string | null, folder?: string) => {
    const revision = ++navigationVersion.current
    if (name && !NoteWorkspace) {
      try { const module = await loadNoteWorkspace(); setNoteWorkspace(() => module.NoteWorkspace) }
      catch { if (revision === navigationVersion.current) setError('编辑器加载失败，请重新打开文章。'); return }
    }
    if (revision !== navigationVersion.current) return
    if (!await beforeLeave.current()) return
    if (revision !== navigationVersion.current) return
    setSelected(name); setPreview(null); setSearchOpen(false)
    if (name) {
      setSpace(name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '')
      // The server broadcasts notes-changed after recording the visit; don't scan twice.
      try { await api.recordOpen(name) }
      catch (error) { setError('无法记录最近打开：' + (error as Error).message) }
    } else if (folder !== undefined) setSpace(folder)
  }, [NoteWorkspace])
  const openNote = useCallback((name: string) => { void navigate(name) }, [navigate])
  const openCreate = () => { setDestination(space); setFormError(''); setCreateOpen(true); setSearchOpen(false) }
  newAction.current = openCreate
  const create = async () => {
    if (creating.current) return
    creating.current = true; setBusy(true); setFormError('')
    try {
      if (!await beforeLeave.current()) { setFormError('请先处理尚未保存的文章或画布位置。'); return }
      const captured = captureContent(capture, references, destination)
      const title = newTitle.trim() || (capture.trim() || references.length ? captured.title : '新笔记')
      const content = captured.content.replace(/^# .*$/m, '# ' + title)
      const { name } = await api.createNote(title, content, destination)
      setCreateOpen(false); setNewTitle(''); setCapture(''); setReferences([])
      await navigate(name)
    } catch (error) { setFormError((error as Error).message) }
    finally { creating.current = false; setBusy(false) }
  }
  const openFolder = async () => {
    if (folderRequest.current) return
    folderRequest.current = true; setOpeningFolder(true); setError('')
    try { await api.openWorkspaceFolder() }
    catch (error) { setError((error as Error).message) }
    finally { folderRequest.current = false; setOpeningFolder(false) }
  }
  const addFolder = async () => {
    if (creating.current || !folderName.trim()) return
    creating.current = true; setBusy(true); setFormError('')
    try {
      if (!await beforeLeave.current()) { setFormError('请先保存当前文章或画布位置。'); return }
      const folder = (space ? space + '/' : '') + folderName.trim()
      await api.createFolder(folder); await refreshList(); setFolderName(''); setNewFolderOpen(false); await navigate(null, folder)
    } catch (error) { setFormError((error as Error).message) }
    finally { creating.current = false; setBusy(false) }
  }
  const visible = useMemo(() => notes.filter(note => note.space === space), [notes, space])
  const recent = notes.filter(note => note.lastOpenedAt > 0).sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
  const aiModel = settings?.chatgpt.unavailable ? null : settings?.chatgpt.activeAccountId ? settings.chatgpt.configured ? 'ChatGPT · ' + settings.chatgpt.model : null : settings?.ai.configured ? settings.ai.model : null
  return <div className={'app' + (sidebarCollapsed ? ' sidebar-collapsed' : '')}>
    <aside className="sidebar" aria-label="笔记导航">
      <div className="brand"><span className="brand-mark"><Icon name="note" size={19}/></span><strong>Canvas Note</strong><Button variant="ghost" size="sm" isIconOnly aria-label={sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'} title={sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'} aria-expanded={!sidebarCollapsed} aria-controls="sidebar-navigation" onPress={() => setSidebarCollapsed(value => !value)}><Icon name="panel"/></Button></div>
      <button type="button" aria-label="搜索笔记" className="search-trigger nav-item" onClick={() => setSearchOpen(true)}><Icon name="search" size={16}/><span>搜索文章</span></button>
      <button type="button" aria-label="新建文章" className="nav-item" onClick={openCreate} disabled={busy}><Icon name="plus"/><span>新建文章</span></button>
      {sidebarCollapsed && <IconButton icon="grid" label="返回当前文件夹画布" onPress={() => void navigate(null)}/>}
      <div id="sidebar-navigation" className="sidebar-navigation" hidden={sidebarCollapsed}>
      <div className="section-header sidebar-section"><span className="section-label">文件夹画布</span><IconButton icon="plus" label="新建文件夹" onPress={() => { setFormError(''); setNewFolderOpen(true) }}/></div>
      <nav className="spaces" aria-label="文件夹">{folders.map(folder => <button type="button" aria-label={folderLabel(folder)} aria-current={space === folder && !selected ? 'page' : undefined} key={folder} className={'nav-item ' + (space === folder && !selected ? 'is-active' : '')} onClick={() => void navigate(null, folder)}><Icon name="folder" size={16}/><span title={folderLabel(folder)}>{folderLabel(folder)}</span><span className="count">{notes.filter(note => note.space === folder).length}</span></button>)}</nav>
      <span className="section-label sidebar-section">最近打开</span>
      <div className="recent-notes">{recent.slice(0, 8).map(note => <button type="button" aria-label={note.title} aria-current={selected === note.name ? 'page' : undefined} key={note.name} className={'nav-item ' + (selected === note.name ? 'is-active' : '')} onClick={() => openNote(note.name)}><Icon name="note" size={16}/><span title={note.title}>{note.title}</span></button>)}{!recent.length && <p className="recent-empty muted">打开过的文章会显示在这里。</p>}</div>
      </div>
      <div className="sidebar-footer"><button type="button" aria-label="设置与外观" className="nav-item" onClick={() => setSettingsOpen(true)}><Icon name="settings" size={18}/><span>设置与外观</span></button></div>
    </aside>
    <main className="stage">
      {error && <div className="global-error" role="alert"><span>{error}</span><Button size="sm" variant="ghost" onPress={() => void refreshList()}>重试</Button><IconButton icon="close" label="关闭提示" onPress={() => setError('')}/></div>}
      {selected && NoteWorkspace ? <NoteWorkspace key={selected} name={selected} theme={resolvedTheme} beforeLeave={beforeLeave} onOpenNote={openNote} onBack={() => void navigate(null)} aiModel={aiModel} onConfigureAI={() => setSettingsOpen(true)} onUpdated={refreshList}/> : <>
        <header className="topbar library-topbar"><div className="breadcrumb"><Icon name="folder" size={17}/><span className="library-folder" title={folderLabel(space)}>{folderLabel(space)}</span><span className="count">{visible.length} 篇</span></div><div className="toolbar"><Button size="sm" variant="ghost" className="open-folder-button" aria-label="在系统文件管理器中打开笔记工作区" onPress={() => void openFolder()} isDisabled={openingFolder}><Icon name="folder" size={16}/>{openingFolder ? '正在打开…' : '打开文件夹'}</Button><Button size="sm" onPress={openCreate}><Icon name="plus" size={16}/>新建文章</Button></div></header>
        {!loaded ? <div className="empty">{error ? '笔记尚未载入，请重试。' : '正在载入画布…'}</div> : <LibraryCanvas key={space} folder={space} notes={visible} theme={resolvedTheme} viewport={views.get(space) ?? { x: 0, y: 0, zoom: 1 }} onViewport={viewport => { views.set(space, viewport); localStorage.setItem('canvas.views', JSON.stringify([...views])) }} beforeLeave={beforeLeave} onOpen={openNote} onPreview={setPreview} onCreate={openCreate}/>}
      </>}
    </main>
    {preview && <NotePreview key={preview} name={preview} onClose={() => setPreview(null)} onOpen={openNote}/>}
    {searchOpen && <QuickSearch notes={notes} spaces={folders} onClose={() => setSearchOpen(false)} onNote={openNote} onSpace={folder => void navigate(null, folder)} onNew={openCreate}/>}
    {referenceOpen && <QuickSearch reference notes={notes} spaces={folders} onClose={() => setReferenceOpen(false)} onNote={name => { const note = notes.find(note => note.name === name); if (note) setReferences(current => [...current.filter(item => item.name !== name), note]); setReferenceOpen(false) }} onSpace={() => {}} onNew={() => {}}/>}
    <Dialog title="新建文章" open={createOpen} onClose={() => { if (!busy) setCreateOpen(false) }} footer={<><Button variant="ghost" isDisabled={busy} onPress={() => setCreateOpen(false)}>取消</Button><Button type="submit" form="new-note-form" isDisabled={busy}>{busy ? '正在创建…' : '创建并编辑'}</Button></>}>
      <form id="new-note-form" aria-label="新建文章" aria-busy={busy} aria-describedby={formError ? 'new-note-error' : undefined} onSubmit={event => { event.preventDefault(); void create() }} onKeyDown={event => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault() }}>
      <div className="new-note-fields"><label htmlFor="new-note-title">标题 <span className="muted">（可留空）</span></label><Input id="new-note-title" value={newTitle} onChange={event => setNewTitle(event.target.value)} placeholder="给这篇文章起个名字" aria-describedby="new-note-title-hint" maxLength={120} fullWidth disabled={busy} autoFocus/><p id="new-note-title-hint" className="field-hint muted">留空时自动命名，可稍后在正文中修改标题。</p><Select id="new-note-folder" label="文件夹" value={destination || '/'} disabled={busy} onValueChange={value => setDestination(value === '/' ? '' : value)} options={folders.map(folder => ({ value: folder || '/', label: folderLabel(folder) }))}/><label htmlFor="new-note-body">正文 <span className="muted">（可留空）</span></label><TextArea id="new-note-body" value={capture} disabled={busy} onChange={event => setCapture(event.target.value)} placeholder="快速记下一点什么，稍后继续编辑…" rows={4}/></div>
      <Button type="button" size="sm" variant="ghost" isDisabled={busy} onPress={() => setReferenceOpen(true)}>引用已有文章</Button>{!!references.length && <div className="capture-references">{references.map(note => <span className="capture-reference" key={note.name}><span>{note.title}</span><IconButton icon="close" label={'移除引用：' + note.title} isDisabled={busy} onPress={() => setReferences(current => current.filter(item => item.name !== note.name))}/></span>)}</div>}{formError && <p id="new-note-error" role="alert" className="error-text">创建失败：{formError}<br/>输入已保留，可重试。</p>}
      </form>
    </Dialog>
    <Dialog title="设置与外观" open={settingsOpen} onClose={() => setSettingsOpen(false)}>
      <Tabs defaultValue="general" className="settings-tabs">
        <TabsList aria-label="设置分类"><TabsTrigger value="general">通用</TabsTrigger><TabsTrigger value="chatgpt">ChatGPT</TabsTrigger><TabsTrigger value="api">API 连接</TabsTrigger></TabsList>
        <TabsContent value="general" forceMount>
          <div className="settings-section"><h3>外观</h3><SegmentedControl className="theme-options" label="外观" value={theme} onValueChange={value => setTheme(value as Theme)} options={[{ value: 'system', label: '跟随系统' }, { value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }]}/></div>
          <div className="settings-section"><h3>Markdown 工作区</h3><p className="muted">每个真实文件夹对应一个画布；文章位置保存在独立的布局文件中。</p><code className="setting-path">{settings?.notesDirectory || '正在读取…'}</code></div>
        </TabsContent>
        <TabsContent value="chatgpt" forceMount><ChatGPTSettings config={settings?.chatgpt ?? null} onSaved={chatgpt => setSettings(current => current ? { ...current, chatgpt } : current)}/></TabsContent>
        <TabsContent value="api" forceMount><AIConnectionSettings config={settings?.ai || null} onSaved={ai => setSettings(current => current ? { ...current, ai } : current)}/></TabsContent>
      </Tabs>
    </Dialog>
    <Dialog title="新建文件夹" open={newFolderOpen} onClose={() => { if (!busy) setNewFolderOpen(false) }} footer={<><Button variant="ghost" isDisabled={busy} onPress={() => setNewFolderOpen(false)}>取消</Button><Button type="submit" form="new-folder-form" isDisabled={busy || !folderName.trim()}>{busy ? '正在创建…' : '创建文件夹'}</Button></>}>
      <form id="new-folder-form" aria-label="新建文件夹" aria-busy={busy} aria-describedby={formError ? 'new-folder-error' : undefined} onSubmit={event => { event.preventDefault(); void addFolder() }} onKeyDown={event => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault() }}>
        <p id="new-folder-hint" className="muted">将在「{folderLabel(space)}」中创建真实文件夹。</p>
        <div className="new-note-fields"><label htmlFor="new-folder-name">文件夹名称</label><Input id="new-folder-name" aria-describedby="new-folder-hint" placeholder="例如：阅读与思考" value={folderName} maxLength={120} required disabled={busy} onChange={event => setFolderName(event.target.value)} fullWidth autoFocus/></div>
        {formError && <p id="new-folder-error" role="alert" className="error-text">创建失败：{formError}<br/>名称已保留，可修改后重试。</p>}
      </form>
    </Dialog>
  </div>
}
