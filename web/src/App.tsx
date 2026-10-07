import { useCallback, useEffect, useState } from 'react'
import type { NoteSummary } from '../shared/types'
import { api, subscribeEvents } from './api'
import { NoteCanvas } from './NoteCanvas'

export function App() {
  const [notes, setNotes] = useState<NoteSummary[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refreshList = useCallback(async () => {
    try {
      const list = await api.listNotes()
      setNotes(list)
      setSelected((cur) => (cur && list.some((n) => n.name === cur) ? cur : (list[0]?.name ?? null)))
      setError(null)
    } catch (e) {
      setError(`无法连接笔记服务：${(e as Error).message}`)
    }
  }, [])

  useEffect(() => {
    void refreshList()
    return subscribeEvents((e) => {
      if (e.type === 'notes-changed' || e.type === 'hello') void refreshList()
    })
  }, [refreshList])

  const createNote = async () => {
    try {
      const { name } = await api.createNote()
      await refreshList()
      setSelected(name)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-head">
          <strong>画布笔记</strong>
          <button onClick={createNote}>＋ 新建</button>
        </div>
        <ul className="note-list">
          {notes.map((n) => (
            <li key={n.name}>
              <button className={n.name === selected ? 'active' : ''} onClick={() => setSelected(n.name)}>
                {n.name.replace(/\.md$/, '')}
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <main className="stage">
        {error && <div className="banner">{error}</div>}
        {selected ? <NoteCanvas key={selected} name={selected} /> : <div className="empty">还没有笔记，点左上角“新建”</div>}
      </main>
    </div>
  )
}
