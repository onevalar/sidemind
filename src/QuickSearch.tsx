import { useEffect, useRef, useState } from 'react'
import { CommandPalette, type CommandItem } from './components/arc/command-palette/command-palette'
import type { NoteSummary } from '../shared/types'
import { api } from './api'
import { Button, Dialog, Icon, SegmentedControl } from './ui'
import { composing } from './ime'

type SearchResult = NoteSummary & { snippet?: string }

export function QuickSearch({ notes, spaces, reference = false, onClose, onNote, onSpace, onNew }: {
  notes: NoteSummary[]; spaces: string[]; reference?: boolean; onClose: () => void
  onNote: (name: string) => void; onSpace: (space: string) => void; onNew: () => void
}) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<'notes' | 'spaces'>('notes')
  const [remote, setRemote] = useState<{ query: string; items: SearchResult[]; error?: string } | null>(null)
  const panel = useRef<HTMLDivElement>(null)
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
  const items: CommandItem[] = category === 'notes' ? found.map(note => ({
    id: note.name, label: note.title, group: '文章', icon: <Icon name="note"/>,
    description: (note.space || '笔记文件夹') + ' · ' + (query.trim() ? note.snippet || note.excerpt : note.excerpt || '还没有正文'),
  })) : foundSpaces.map(space => ({ id: space || '/', label: space || '笔记文件夹', group: '文件夹', icon: <Icon name="folder"/>, description: notes.filter(note => note.space === space).length + ' 篇文章' }))
  return <Dialog title={reference ? '引用文章' : '搜索文章和文件夹'} bare open onClose={onClose} className="search-dialog" onOpenAutoFocus={event => { event.preventDefault(); panel.current?.querySelector<HTMLInputElement>('[role="combobox"]')?.focus() }}><div ref={panel} onKeyDownCapture={event => {
    if (event.key === 'Escape' && !composing(event)) { event.preventDefault(); event.stopPropagation(); onClose() }
  }}>
    <CommandPalette key={category} items={items} query={query} onQueryChange={setQuery} filter={false} autoFocus loading={searching} onClose={onClose}
      toolbar={<><div className="search-toolbar">{reference ? <p className="muted">选择文章，添加到新建笔记。</p> : <>
        <SegmentedControl label="搜索范围" value={category} options={[{ value: 'notes', label: '所有文章' }, { value: 'spaces', label: '文件夹' }]} onValueChange={value => { setCategory(value as typeof category); panel.current?.querySelector<HTMLInputElement>('[role="combobox"]')?.focus() }}/>
        <Button variant="ghost" size="sm" onPress={onNew}><Icon name="plus" size={16}/>新建文章</Button>
      </>}</div>{error && <p role="alert" className="search-error error-text">搜索失败：{error}</p>}</>}
      label={reference ? '查找要引用的笔记' : category === 'spaces' ? '搜索文件夹' : '搜索标题或正文'} placeholder={category === 'spaces' ? '搜索文件夹…' : '搜索标题或正文…'}
      emptyMessage={error ? '请修改关键词后重试。' : '没有找到匹配的' + (category === 'notes' ? '文章' : '文件夹')}
      onSelect={item => { if (category === 'spaces') onSpace(item.id === '/' ? '' : item.id); else onNote(item.id) }}/>
  </div></Dialog>
}
