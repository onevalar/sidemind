import { useEffect, useRef, useState } from 'react'
import { Command } from '@onevalar/pro/command'
import type { NoteSummary } from '../shared/types'
import { api } from './api'
import { Button, Icon } from './ui'

type SearchResult = NoteSummary & { snippet?: string }
const alreadyFiltered = () => true

export function QuickSearch({ notes, spaces, reference = false, onClose, onNote, onSpace, onNew }: {
  notes: NoteSummary[]; spaces: string[]; reference?: boolean; onClose: () => void
  onNote: (name: string) => void; onSpace: (space: string) => void; onNew: () => void
}) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<'notes' | 'spaces'>('notes')
  const [remote, setRemote] = useState<{ query: string; items: SearchResult[]; error?: string } | null>(null)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!query.trim() || category !== 'notes') return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      void api.search(query, controller.signal).then(items => {
        if (!controller.signal.aborted) setRemote({ query, items })
      }).catch(error => {
        if (!controller.signal.aborted) setRemote({ query, items: [], error: (error as Error).message })
      })
    }, 200)
    return () => { clearTimeout(timer); controller.abort() }
  }, [query, category])
  const searching = category === 'notes' && !!query.trim() && remote?.query !== query
  const found: SearchResult[] = query.trim() ? remote?.query === query ? remote.items : [] : notes
  const foundSpaces = spaces.filter(space => (space || '笔记文件夹').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const error = category === 'notes' && remote?.query === query ? remote.error : undefined
  const changeCategory = (next: 'notes' | 'spaces') => { setCategory(next); input.current?.focus() }
  return <div style={{ display: 'contents' }} onKeyDownCapture={event => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); onClose() }
  }}><Command><Command.Backdrop isOpen onOpenChange={open => { if (!open) onClose() }}><Command.Container size="lg">
    <Command.Dialog aria-label={reference ? '引用笔记' : '搜索文章和文件夹'} inputValue={query} onInputChange={setQuery} filter={alreadyFiltered}>
      <Command.InputGroup aria-label={reference ? '查找要引用的笔记' : '搜索标题或正文'}>
        <Command.InputGroup.Prefix><Icon name="search"/></Command.InputGroup.Prefix>
        <Command.InputGroup.Input ref={input} placeholder={category === 'spaces' ? '搜索文件夹…' : '搜索标题或正文…'}/>
        <Command.InputGroup.Suffix><Button variant="ghost" size="sm" aria-label="关闭搜索" onPress={onClose}>Esc</Button></Command.InputGroup.Suffix>
      </Command.InputGroup>
      <Command.Header>
        {reference ? <span className="muted">选择笔记，添加到快速记录</span> : <>
          <Button variant="ghost" size="sm" onPress={onNew}><Icon name="plus" size={14}/>新建笔记</Button>
          <Button variant={category === 'notes' ? 'secondary' : 'ghost'} size="sm" aria-pressed={category === 'notes'} onPress={() => changeCategory('notes')}>所有笔记</Button>
          <Button variant={category === 'spaces' ? 'secondary' : 'ghost'} size="sm" aria-pressed={category === 'spaces'} onPress={() => changeCategory('spaces')}>文件夹</Button>
        </>}
      </Command.Header>
      {error && <p role="alert" className="search-error error-text">搜索失败：{error}</p>}
      <Command.List key={category} aria-label={category === 'notes' ? '笔记结果' : '文件夹结果'} aria-busy={searching}
        renderEmptyState={() => searching ? '正在搜索…' : error ? '请修改关键词后重试。' : '没有找到匹配的' + (category === 'notes' ? '文章' : '文件夹')}
        onAction={key => { if (category === 'spaces') onSpace(key === '/' ? '' : String(key)); else onNote(String(key)) }}>
        {category === 'notes' ? found.map(note => <Command.Item key={note.name} id={note.name} textValue={note.title} className="note-command-result">
          <Icon name="note"/><span className="command-note-text"><strong>{note.title}</strong><small>{note.space || '笔记文件夹'} · {query.trim() ? note.snippet || note.excerpt : note.excerpt || '还没有正文'}</small></span><span className="command-enter" aria-hidden="true">↵</span>
        </Command.Item>) : foundSpaces.map(space => <Command.Item key={space} id={space || '/'} textValue={space || '笔记文件夹'}>
          <Icon name="folder"/><span>{space || '笔记文件夹'}</span><span className="command-space-count muted">{notes.filter(note => note.space === space).length} 篇文章</span>
        </Command.Item>)}
      </Command.List>
      <Command.Footer><span>↑ ↓ 选择 · ↵ {reference ? '引用' : '打开'}</span><span>Esc 关闭</span></Command.Footer>
    </Command.Dialog>
  </Command.Container></Command.Backdrop></Command></div>
}
