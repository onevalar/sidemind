import { useCallback, useEffect, useRef, useState } from 'react'
import type { NoteDTO } from '../shared/types'
import { api, subscribeEvents } from './api'

export function useNote(name: string) {
  const [note, setNote] = useState<NoteDTO | null>(null)
  const [draft, setDraftState] = useState('')
  const [status, setStatus] = useState<'loading' | 'saved' | 'dirty' | 'saving' | 'conflict'>('loading')
  const [error, setError] = useState<string | null>(null)
  const base = useRef('')
  const current = useRef('')
  const pending = useRef<Promise<boolean> | null>(null)
  const undoStack = useRef<string[]>([])
  const [undoCount, setUndoCount] = useState(0)

  const accept = useCallback((next: NoteDTO, preserveUndo = false) => {
    // Undo belongs to the accepted content, never to a newer external revision.
    if (!preserveUndo && next.content !== base.current) { undoStack.current = []; setUndoCount(0) }
    base.current = next.content; current.current = next.content
    setNote(next); setDraftState(next.content); setStatus('saved'); setError(null)
  }, [])
  useEffect(() => {
    let active = true
    let request = 0
    let controller: AbortController | null = null
    const load = async () => {
      const id = ++request
      controller?.abort()
      // Notifications during a write must be reconciled after its response, not dropped.
      while (pending.current) await pending.current
      if (!active || id !== request) return
      controller = new AbortController()
      try {
        const expected = base.current
        const next = await api.loadNote(name, controller.signal)
        if (!active || id !== request) return
        if (pending.current || expected !== base.current) { void load(); return }
        if (current.current !== base.current) {
          if (next.content !== base.current) { setStatus('conflict'); setError('文件已在其他编辑器中修改。你的草稿仍保留，请复制草稿或重新载入。') }
          else setNote(next)
        } else accept(next)
      } catch (e) { if (active && id === request) setError((e as Error).message) }
    }
    void load()
    const unsubscribe = subscribeEvents((e) => { if (e.type === 'hello' || (e.type === 'note-changed' && e.name === name)) void load() })
    return () => { active = false; controller?.abort(); unsubscribe() }
  }, [name, accept])

  const setDraft = useCallback((text: string) => { current.current = text; setDraftState(text); setStatus(text === base.current ? 'saved' : 'dirty') }, [])
  const save = useCallback(async (): Promise<boolean> => {
    if (pending.current) { if (!await pending.current) return false; return save() }
    const content = current.current
    const expected = base.current
    if (content === expected) return true
    setStatus('saving')
    const run = (async () => {
      try {
        const next = await api.saveContent(name, content, expected)
        if (next.content !== content) throw new Error('保存后正文又发生变化。你的草稿仍保留，请重新载入后再继续。')
        undoStack.current.push(expected); setUndoCount(undoStack.current.length)
        base.current = next.content; setNote(next); setError(null)
        setStatus(current.current === next.content ? 'saved' : 'dirty')
        return true
      } catch (e) { setError((e as Error).message); setStatus('conflict'); return false }
    })()
    pending.current = run
    let saved: boolean
    try { saved = await run } finally { pending.current = null }
    return saved && current.current !== base.current ? save() : saved
  }, [name])

  useEffect(() => {
    if (status !== 'dirty') return
    const timer = setTimeout(() => void save(), 900)
    return () => clearTimeout(timer)
  }, [draft, status, save])
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (current.current !== base.current) { e.preventDefault(); e.returnValue = '' } }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])

  const replace = async (content: string) => { setDraft(content); return save() }
  const undo = async () => {
    if (!await save()) return
    const previous = undoStack.current.pop()
    if (previous === undefined) return
    const expected = base.current
    const run = (async () => {
      try {
        const next = await api.saveContent(name, previous, expected)
        if (next.content !== previous) throw new Error('撤销后正文又发生变化。请重新载入后再继续。')
        if (current.current === expected) accept(next, true)
        else { base.current = next.content; setNote(next); setStatus('dirty'); setError(null) }
        setUndoCount(undoStack.current.length)
        return true
      }
      catch (e) { undoStack.current.push(previous); setError((e as Error).message); setStatus('conflict'); return false }
    })()
    pending.current = run
    try { await run } finally { pending.current = null }
  }
  const reload = async () => { try { accept(await api.loadNote(name)) } catch (e) { setError((e as Error).message) } }
  return { note, draft, status, error, setDraft, save, replace, undo, undoCount, reload }
}
