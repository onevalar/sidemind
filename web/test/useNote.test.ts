// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteDTO } from '../shared/types'
import { api, type ServerEvent } from '../src/api'
import { useNote } from '../src/useNote'

const { listeners } = vi.hoisted(() => ({ listeners: new Set<(event: ServerEvent) => void>() }))
vi.mock('../src/api', () => ({
  api: { loadNote: vi.fn(), saveContent: vi.fn() },
  subscribeEvents: (listener: (event: ServerEvent) => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
}))

let disk: NoteDTO
beforeEach(() => {
  disk = { name: 'Thought.md', content: '# Original\n\nKeep this paragraph.\n', space: '个人灵感' }
  vi.mocked(api.loadNote).mockImplementation(async () => structuredClone(disk))
  vi.mocked(api.saveContent).mockImplementation(async (_, content, expected) => {
    if (disk.content !== expected) throw new Error('笔记已在其他地方修改，请重新载入后再保存。')
    disk = { ...disk, content }
    return structuredClone(disk)
  })
})
afterEach(() => { cleanup(); listeners.clear(); vi.resetAllMocks() })

const emit = (event: ServerEvent) => act(() => { for (const listener of listeners) listener(event) })
const open = async () => {
  const hook = renderHook(() => useNote(disk.name))
  await waitFor(() => expect(hook.result.current.status).toBe('saved'))
  return hook.result
}

describe('open note session', () => {
  it('autosaves and can undo multiple local saves, including after layout-only refreshes', async () => {
    const original = disk.content
    const result = await open()
    act(() => result.current.setDraft('# First save\n\nKeep this paragraph.\n'))
    await waitFor(() => expect(disk.content).toContain('First save'), { timeout: 2000 })
    await act(() => result.current.replace('# Second save\n\nA changed paragraph.\n'))
    disk.space = '项目研究'
    emit({ type: 'note-changed', name: disk.name })
    await waitFor(() => expect(result.current.note?.space).toBe('项目研究'))
    expect(result.current.undoCount).toBe(2)
    await act(() => result.current.undo())
    expect(disk.content).toBe('# First save\n\nKeep this paragraph.\n')
    await act(() => result.current.undo())
    expect(disk.content).toBe(original)
    expect(result.current.undoCount).toBe(0)
  })

  it('does not let old undo history overwrite an accepted external edit', async () => {
    const result = await open()
    await act(() => result.current.replace('# Local change\n'))
    const external = '# External change\n\nDo not lose this.\n'
    disk.content = external
    emit({ type: 'note-changed', name: disk.name })
    await waitFor(() => expect(result.current.draft).toBe(external))
    expect(result.current.undoCount).toBe(0)
    await act(() => result.current.undo())
    expect(disk.content).toBe(external)
  })

  it('refreshes a clean open note when the event connection is restored', async () => {
    const result = await open()
    disk.content = '# Changed while disconnected\n'
    emit({ type: 'hello' })
    await waitFor(() => expect(result.current.draft).toBe(disk.content))
    expect(result.current.status).toBe('saved')
  })

  it('preserves a conflicting draft on reconnect and refuses to overwrite the external file', async () => {
    const result = await open()
    const local = '# Unsaved local draft\n'
    act(() => result.current.setDraft(local))
    disk.content = '# External file\n'
    emit({ type: 'hello' })
    await waitFor(() => expect(result.current.status).toBe('conflict'), { timeout: 300 })
    expect(result.current.draft).toBe(local)
    let saved: boolean | undefined
    await act(async () => { saved = await result.current.save() })
    expect(saved).toBe(false)
    expect(disk.content).toBe('# External file\n')
    expect(result.current.draft).toBe(local)
    await act(() => result.current.reload())
    expect(result.current.draft).toBe('# External file\n')
    expect(result.current.status).toBe('saved')
    expect(result.current.undoCount).toBe(0)
  })

  it('does not lose an external change notification while a save response is pending', async () => {
    const result = await open()
    let release!: () => void
    const response = new Promise<void>(resolve => { release = resolve })
    vi.mocked(api.saveContent).mockImplementationOnce(async (_, content) => {
      disk.content = content
      const saved = structuredClone(disk)
      await response
      return saved
    })
    let saving!: Promise<boolean>
    act(() => { saving = result.current.replace('# Browser save\n') })
    disk.content = '# External edit after the write\n'
    emit({ type: 'note-changed', name: disk.name })
    await act(async () => { release(); await saving })
    await waitFor(() => expect(result.current.draft).toBe('# External edit after the write\n'))
    expect(result.current.undoCount).toBe(0)
  })

  it('does not overwrite newer content returned after a successful write', async () => {
    const result = await open()
    vi.mocked(api.saveContent).mockImplementationOnce(async () => {
      disk.content = '# Externally changed before the save response\n'
      return structuredClone(disk)
    })
    const draft = '# The requested browser save\n'
    await act(async () => { expect(await result.current.replace(draft)).toBe(false) })
    expect(result.current.draft).toBe(draft)
    expect(result.current.status).toBe('conflict')
    expect(disk.content).toBe('# Externally changed before the save response\n')
  })

  it('does not let an older read response roll back a newer save', async () => {
    const result = await open()
    const old = structuredClone(disk)
    let release!: (note: NoteDTO) => void
    vi.mocked(api.loadNote).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    emit({ type: 'note-changed', name: disk.name })
    await act(() => result.current.replace('# Latest saved content\n'))
    await act(async () => { release(old) })
    await waitFor(() => expect(result.current.draft).toBe('# Latest saved content\n'))
    expect(disk.content).toBe('# Latest saved content\n')
    expect(result.current.status).toBe('saved')
    expect(result.current.undoCount).toBe(1)
  })

  it('does not treat newer external content in an undo response as a local revision', async () => {
    const result = await open()
    await act(() => result.current.replace('# Local first\n'))
    await act(() => result.current.replace('# Local second\n'))
    vi.mocked(api.saveContent).mockImplementationOnce(async () => {
      disk.content = '# External edit during undo\n'
      return structuredClone(disk)
    })
    await act(() => result.current.undo())
    expect(result.current.status).toBe('conflict')
    await act(() => result.current.undo())
    expect(disk.content).toBe('# External edit during undo\n')
    await act(() => result.current.reload())
    expect(result.current.draft).toBe('# External edit during undo\n')
    expect(result.current.undoCount).toBe(0)
  })

  it('keeps text typed while an undo response is pending', async () => {
    const original = disk.content
    const result = await open()
    await act(() => result.current.replace('# Saved local revision\n'))
    let release!: () => void
    const response = new Promise<void>(resolve => { release = resolve })
    vi.mocked(api.saveContent).mockImplementationOnce(async (_, content) => {
      disk.content = content
      const saved = structuredClone(disk)
      await response
      return saved
    })
    let undoing!: Promise<void>
    act(() => { undoing = result.current.undo() })
    await waitFor(() => expect(disk.content).toBe(original))
    act(() => result.current.setDraft('# New typing during undo\n'))
    await act(async () => { release(); await undoing })
    expect(result.current.draft).toBe('# New typing during undo\n')
    await act(() => result.current.save())
    expect(disk.content).toBe('# New typing during undo\n')
  })

  it('finishes saving the latest draft before allowing navigation', async () => {
    const result = await open()
    let release!: () => void
    const response = new Promise<void>(resolve => { release = resolve })
    vi.mocked(api.saveContent).mockImplementationOnce(async (_, content) => {
      disk.content = content
      const saved = structuredClone(disk)
      await response
      return saved
    })
    act(() => result.current.setDraft('# First draft\n'))
    let saving!: Promise<boolean>
    act(() => { saving = result.current.save() })
    act(() => result.current.setDraft('# Latest draft typed during save\n'))
    await act(async () => { release(); expect(await saving).toBe(true) })
    expect(disk.content).toBe('# Latest draft typed during save\n')
    expect(result.current.draft).toBe(disk.content)
    expect(result.current.status).toBe('saved')
  })
})
