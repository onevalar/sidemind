import { useEffect, useState } from 'react'
import type { MemoryFileDTO, MemoryTargetKind } from '../shared/types'
import { api } from './api'
import { NoteMarkdown } from './NoteMarkdown'
import { Button, Dialog, TextArea } from './ui'

/** Memory is visible and editable by the user; edits are committed with the next push. */
export function MemoryDialog({ target, name, title, open, onClose }: { target: MemoryTargetKind; name: string; title: string; open: boolean; onClose: () => void }) {
  const [memory, setMemory] = useState<MemoryFileDTO | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (!open) return
    let active = true
    setMemory(null); setDraft(null); setError('')
    api.memory(target, name).then(value => { if (active) setMemory(value) }, caught => { if (active) setError((caught as Error).message) })
    return () => { active = false }
  }, [open, target, name])
  const save = async () => {
    if (!memory || draft === null) return
    setSaving(true); setError('')
    try {
      await api.saveMemory(target, name, draft, memory.exists ? memory.content : null)
      setMemory(await api.memory(target, name)); setDraft(null)
    } catch (caught) { setError('未保存：' + (caught as Error).message + '。请重新打开后再编辑。') }
    finally { setSaving(false) }
  }
  const body = memory?.content.replace(/^---\n[\s\S]*?\n---\n?/, '') ?? ''
  const meta = memory?.content.match(/^---\n([\s\S]*?)\n---/)?.[1]
  return <Dialog title={title} open={open} onClose={() => { if (!saving) onClose() }} className="memory-dialog" footer={draft === null
    ? <><Button variant="ghost" onPress={onClose}>关闭</Button><Button variant="outline" isDisabled={!memory} onPress={() => setDraft(memory?.content ?? '')}>编辑</Button></>
    : <><Button variant="ghost" isDisabled={saving} onPress={() => setDraft(null)}>取消</Button><Button isDisabled={saving} onPress={() => void save()}>{saving ? '正在保存…' : '保存记忆'}</Button></>}>
    <p className="muted">记忆用于以后使用这些笔记时提醒助手注意什么，会在推送时随笔记一起提交。{memory && <> 文件：<code>memory/{memory.file}</code></>}</p>
    {error && <p className="ai-error" role="alert">{error}</p>}
    {!memory && !error && <p className="muted" role="status">正在读取…</p>}
    {memory && draft === null && (memory.exists ? <>{meta && <pre className="memory-meta">{meta}</pre>}<div className="memory-body"><NoteMarkdown>{body}</NoteMarkdown></div></> : <p className="muted">还没有记忆。推送后会根据内容生成；也可以在对话中让助手记住。</p>)}
    {draft !== null && <TextArea aria-label="记忆内容" className="memory-editor" value={draft} rows={18} onChange={event => setDraft(event.target.value)}/>}
  </Dialog>
}
