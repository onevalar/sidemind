import { useEffect, useState } from 'react'
import type { NoteDTO } from '../shared/types'
import { api, subscribeEvents } from './api'
import { NoteMarkdown } from './NoteMarkdown'
import { Button, Dialog } from './ui'

export function NotePreview({ name, onClose, onOpen }: { name: string; onClose: () => void; onOpen: (name: string) => void }) {
  const [note, setNote] = useState<NoteDTO | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true, revision = 0
    const load = async () => {
      const request = ++revision
      try { const note = await api.loadNote(name); if (active && request === revision) { setNote(note); setError('') } }
      catch (error) { if (active && request === revision) setError((error as Error).message) }
    }
    void load()
    const stop = subscribeEvents(event => { if (event.type === 'hello' || event.type === 'note-changed' && event.name === name) void load() })
    return () => { active = false; stop() }
  }, [name])
  return <Dialog title="文章预览" className="note-preview-dialog" open onClose={onClose} footer={<><span className="muted preview-readonly">只读预览 · 不会修改正文</span><Button variant="outline" onPress={onClose}>关闭</Button><Button onPress={() => onOpen(name)}>打开并编辑</Button></>}>
    <article className="prose article-preview">
      {error ? <p role="alert" className="error-text">{error}</p> : note ? <NoteMarkdown name={name} onOpenNote={onOpen}>{note.content || '这篇文章还没有正文。'}</NoteMarkdown> : <p role="status" className="muted">正在载入文章…</p>}
    </article>
  </Dialog>
}
