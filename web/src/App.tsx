import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { NoteSummary } from '../shared/types'
import { api, subscribeEvents } from './api'
import { NoteWorkspace } from './NoteWorkspace'
import { AIConnectionSettings } from './AIConnectionSettings'
import { QuickSearch } from './QuickSearch'
import { captureContent } from './note-links'
import { Button, Dialog, Icon, IconButton, Input, TextArea } from './ui'

type Theme = 'system' | 'light' | 'dark'
const darkPreference = () => matchMedia('(prefers-color-scheme: dark)')
const subscribeAppearance = (listener: () => void) => { const media = darkPreference(); media.addEventListener('change', listener); return () => media.removeEventListener('change', listener) }
export function App() {
  const [notes, setNotes] = useState<NoteSummary[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [space, setSpace] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [capture, setCapture] = useState('')
  const [busy, setBusy] = useState(false)
  const [openingFolder, setOpeningFolder] = useState(false)
  const folderRequest = useRef(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [referenceOpen, setReferenceOpen] = useState(false)
  const [captureSpace, setCaptureSpace] = useState<string | null>(null)
  const [captureSpaceOpen, setCaptureSpaceOpen] = useState(false)
  const [references, setReferences] = useState<NoteSummary[]>([])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settings, setSettings] = useState<Awaited<ReturnType<typeof api.settings>> | null>(null)
  const [newSpaceOpen, setNewSpaceOpen] = useState(false)
  const [spaceName, setSpaceName] = useState('')
  const [extraSpaces, setExtraSpaces] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem('canvas.spaces') || '[]') } catch { return [] } })
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('canvas.theme') as Theme) || 'system')
  const systemDark = useSyncExternalStore(subscribeAppearance, () => darkPreference().matches, () => false)
  const resolvedTheme = theme === 'system' ? systemDark ? 'dark' : 'light' : theme
  const beforeLeave = useRef<() => Promise<boolean>>(async () => true)
  const creating = useRef(false)
  const createAction = useRef<() => void>(() => {})
  const spaces = [...new Set(['个人灵感', '项目研究', ...extraSpaces, ...notes.map((n) => n.space)])]

  const refreshList = useCallback(async () => {
    try { setNotes((await api.listNotes()).sort((a, b) => b.mtime - a.mtime)); setError('') }
    catch (e) { setError('无法连接笔记服务：' + (e as Error).message) }
  }, [])
  useEffect(() => {
    void refreshList()
    return subscribeEvents((e) => { if (e.type === 'notes-changed' || e.type === 'hello') void refreshList() })
  }, [refreshList])
  useEffect(() => {
    document.documentElement.dataset.theme = 'linear-' + resolvedTheme
    localStorage.setItem('canvas.theme', theme)
  }, [theme, resolvedTheme])
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.repeat || e.altKey || e.shiftKey || !(e.metaKey || e.ctrlKey)) return
      if (e.key.toLowerCase() === 'k') { e.preventDefault(); setSearchOpen(v => !v) }
      if (e.key.toLowerCase() === 'n' && !document.querySelector('[role="dialog"]')) { e.preventDefault(); createAction.current() }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])
  useEffect(() => {
    let active = true
    void api.settings().then(value => { if (active) setSettings(value) }).catch(e => { if (active) setError((e as Error).message) })
    return () => { active = false }
  }, [settingsOpen])

  const navigate = async (name: string | null, filter = space) => {
    if (!await beforeLeave.current()) return
    setSelected(name); setSpace(filter); setSearchOpen(false)
    if (name) {
      try { await api.recordOpen(name); await refreshList() }
      catch (e) { setError('无法记录最近访问：' + (e as Error).message) }
    }
  }
  const create = async (text?: string, destination = space, linked: NoteSummary[] = []) => {
    if (creating.current) return
    creating.current = true
    setBusy(true); setError('')
    try {
      if (!await beforeLeave.current()) return
      const { title, content } = captureContent(text || '', linked)
      const { name } = await api.createNote(title, text?.trim() || linked.length ? content : undefined)
      // Once created, show the real file even if a subsequent metadata write fails.
      setSelected(name); setSearchOpen(false)
      if (text !== undefined) { setCapture(''); setReferences([]); setCaptureSpace(null) }
      let metadataError = ''
      try { if (destination) await api.saveSpace(name, destination); await api.recordOpen(name) }
      catch (e) { metadataError = '笔记已创建，但分类或最近访问未保存：' + (e as Error).message }
      await refreshList()
      if (metadataError) setError(metadataError)
    } catch (e) { setError((e as Error).message) }
    finally { creating.current = false; setBusy(false) }
  }
  createAction.current = () => { void create() }
  const openFolder = async () => {
    if (folderRequest.current) return
    folderRequest.current = true; setOpeningFolder(true); setError('')
    try { await api.openWorkspaceFolder() }
    catch (e) { setError((e as Error).message) }
    finally { folderRequest.current = false; setOpeningFolder(false) }
  }
  const addSpace = () => {
    const name = spaceName.trim().slice(0, 80)
    if (!name) return
    const next = [...new Set([...extraSpaces, name])]
    setExtraSpaces(next); localStorage.setItem('canvas.spaces', JSON.stringify(next)); setSpaceName(''); setNewSpaceOpen(false)
    void navigate(null, name)
  }
  const visible = notes.filter((n) => !space || n.space === space)
  const recent = notes.filter(n => n.lastOpenedAt > 0).sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
  const continuing = recent.filter(n => !space || n.space === space).slice(0, 3)
  const activeNote = notes.find((n) => n.name === selected)
  const date = (timestamp: number) => new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(timestamp)
  return <div className="app">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark"><Icon name="note" size={19}/></span><strong>Canvas Note</strong><span className="local-badge">本地</span></div>
      <Button aria-label="搜索笔记" className="search-trigger" variant="outline" onPress={() => setSearchOpen(true)}><Icon name="search" size={16}/><span>搜索笔记</span><kbd>⌘ K</kbd></Button>
      <Button className={'nav-item ' + (!selected && !space ? 'is-active' : '')} variant="ghost" onPress={() => void navigate(null, null)}><Icon name="grid"/>工作台</Button>
      <Button className="nav-item" variant="ghost" onPress={() => void create()} isDisabled={busy}><Icon name="plus"/>新建笔记</Button>
      <div className="section-header sidebar-section"><span className="section-label">空间</span><IconButton icon="plus" label="新建空间" onPress={() => setNewSpaceOpen(true)}/></div>
      <div className="spaces">{spaces.map((s) => <Button aria-label={s} key={s} className={'nav-item ' + (space === s && !selected ? 'is-active' : '')} variant="ghost" onPress={() => void navigate(null, s)}><Icon name="folder" size={16}/><span>{s}</span><span className="count">{notes.filter((n) => n.space === s).length}</span></Button>)}</div>
      <span className="section-label sidebar-section">最近打开</span>
      <div className="recent-notes">{recent.slice(0, 8).map((n) => <Button aria-label={n.title} key={n.name} className={'nav-item ' + (selected === n.name ? 'is-active' : '')} variant="ghost" onPress={() => void navigate(n.name)}><Icon name="note" size={15}/><span>{n.title}</span></Button>)}{!recent.length && <p className="recent-empty muted">打开过的笔记会显示在这里。</p>}</div>
      <div className="sidebar-footer"><div className="local-status"><span className="status-dot"/>Markdown 保存在你的电脑</div><Button className="nav-item" variant="ghost" onPress={() => setSettingsOpen(true)}><Icon name="settings" size={16}/>设置与外观</Button></div>
    </aside>
    <main className="stage">
      {error && <div className="global-error" role="alert">{error}<IconButton icon="close" label="关闭提示" onPress={() => setError('')}/></div>}
      {selected ? <NoteWorkspace key={selected} name={selected} theme={resolvedTheme} beforeLeave={beforeLeave} onOpenNote={name => void navigate(name)} aiModel={settings?.ai.configured ? settings.ai.model : null} onConfigureAI={() => setSettingsOpen(true)} onUpdated={() => void refreshList()} spaces={spaces.includes(activeNote?.space ?? '') ? spaces : [...spaces, activeNote?.space ?? '个人灵感']}/> : <>
        <header className="topbar"><div className="breadcrumb"><Icon name={space ? 'folder' : 'grid'} size={16}/><span>{space || '工作台'}</span></div><Button size="sm" variant="outline" aria-label="在系统文件管理器中打开笔记工作区" onPress={() => void openFolder()} isDisabled={openingFolder}><Icon name="folder" size={16}/>{openingFolder ? '正在打开…' : '打开文件夹'}</Button></header>
        <div className="home-scroll"><div className="home">
          <div className="home-heading"><span className="eyebrow">YOUR PERSONAL WORKSPACE</span><h1>{space || '把想法，慢慢变成作品。'}</h1><p className="muted">{space ? '在同一个空间中整理相关的笔记和灵感。' : '捕捉灵感、整理知识，在文档和画布之间自由切换。'}</p></div>
          <div className="capture"><TextArea aria-label="快速记录灵感" value={capture} disabled={busy} onChange={(e) => setCapture(e.target.value)} placeholder="记下一点什么，或连接已有想法…" rows={3}/>
            {!!references.length && <div className="capture-references" aria-label="引用的笔记">{references.map(note => <span className="capture-reference" key={note.name}><Icon name="note" size={14}/><span>{note.title}</span><IconButton icon="close" label={'移除引用：' + note.title} isDisabled={busy} onPress={() => setReferences(current => current.filter(item => item.name !== note.name))}/></span>)}</div>}
            <div className="capture-footer"><div className="capture-tools"><Button size="sm" variant="ghost" isDisabled={busy} onPress={() => setCaptureSpaceOpen(true)}><Icon name="folder" size={14}/>{captureSpace || space || '选择空间'}</Button><Button size="sm" variant="ghost" isDisabled={busy} onPress={() => setReferenceOpen(true)}>引用笔记</Button><span className="muted capture-local">Markdown · 本地保存</span></div><Button size="sm" onPress={() => void create(capture, captureSpace || space || '个人灵感', references)} isDisabled={(!capture.trim() && !references.length) || busy}>{busy ? '正在保存…' : '创建笔记'}</Button></div>
          </div>
          {!!continuing.length && <section className="continue-section"><div className="section-header"><h2>继续上次的思考</h2><Button size="sm" variant="ghost" onPress={() => setSearchOpen(true)}>查看全部</Button></div><div className="note-grid">{continuing.map(note => <Button key={note.name} variant="ghost" className="note-preview" onPress={() => void navigate(note.name)}><span className="section-label">{note.space}</span><strong>{note.title}</strong><p>{note.excerpt || '打开后继续记录。'}</p><span className="preview-meta"><span>上次打开 · {date(note.lastOpenedAt)}</span><span>{note.blockCount} 个内容块</span></span></Button>)}</div></section>}
          <div className="section-header"><h2>最近更新 <span className="count">{visible.length} 篇笔记</span></h2><Button size="sm" variant="ghost" onPress={() => setSearchOpen(true)}><Icon name="search" size={15}/>查找笔记</Button></div>
          {visible.length ? <div className="updated-notes">{visible.map(n => <Button key={n.name} variant="ghost" className="updated-note" onPress={() => void navigate(n.name)}><Icon name="note" size={16}/><strong>{n.title}</strong><span className="muted updated-space">{n.space}</span><span className="muted updated-date">{date(n.mtime)}</span></Button>)}</div> : <div className="home-empty"><Icon name="note" size={28}/><strong>留一点空间给新想法</strong><p>写下第一条灵感，或者创建一篇空白笔记。</p><Button variant="outline" onPress={() => void create()}>创建笔记</Button></div>}
          <div className="home-tip"><Icon name="grid" size={17}/><span>一份内容，两种视角。打开笔记，切换到画布整理内容块。</span></div>
        </div></div>
      </>}
    </main>
    {searchOpen && <QuickSearch notes={notes} spaces={spaces} onClose={() => setSearchOpen(false)} onNote={name => void navigate(name)} onSpace={name => void navigate(null, name)} onNew={() => void create()}/>}
    {referenceOpen && <QuickSearch reference notes={notes} spaces={spaces} onClose={() => setReferenceOpen(false)} onNote={name => { const note = notes.find(item => item.name === name); if (note) setReferences(current => [...current.filter(item => item.name !== name), note]); setReferenceOpen(false) }} onSpace={() => {}} onNew={() => {}}/>}
    <Dialog title="保存到空间" open={captureSpaceOpen} onClose={() => setCaptureSpaceOpen(false)}><div className="spaces">{spaces.map(name => <Button key={name} className="nav-item" variant={name === (captureSpace || space || '个人灵感') ? 'secondary' : 'ghost'} onPress={() => { setCaptureSpace(name); setCaptureSpaceOpen(false) }}><Icon name="folder"/>{name}{name === (captureSpace || space || '个人灵感') && <Icon name="check"/>}</Button>)}</div></Dialog>
    <Dialog title="设置与外观" open={settingsOpen} onClose={() => setSettingsOpen(false)}><div className="settings-section"><h3>外观</h3><p className="muted">使用统一的 Linear 主题。</p><div className="theme-options">{(['system', 'light', 'dark'] as const).map((v) => <Button key={v} variant={theme === v ? 'secondary' : 'outline'} onPress={() => setTheme(v)}><Icon name="sun" size={16}/>{({ system: '跟随系统', light: '浅色', dark: '深色' })[v]}</Button>)}</div></div><div className="settings-section"><h3>本地工作区</h3><p className="muted">所有正文都是普通 Markdown 文件。</p><code className="setting-path">{settings?.notesDirectory || '正在读取…'}</code><Button variant="outline" isDisabled={openingFolder} onPress={() => void openFolder()}><Icon name="folder" size={16}/>{openingFolder ? '正在打开…' : '打开笔记文件夹'}</Button></div><AIConnectionSettings config={settings?.ai || null} onSaved={ai => setSettings(current => current ? { ...current, ai } : current)}/></Dialog>
    <Dialog title="新建空间" open={newSpaceOpen} onClose={() => setNewSpaceOpen(false)} footer={<><Button variant="ghost" onPress={() => setNewSpaceOpen(false)}>取消</Button><Button onPress={addSpace} isDisabled={!spaceName.trim()}>创建空间</Button></>}><Input aria-label="空间名称" placeholder="例如：阅读与思考" value={spaceName} onChange={(e) => setSpaceName(e.target.value)} fullWidth autoFocus/></Dialog>
  </div>
}
