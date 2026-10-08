import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BadNameError, ConflictError, NoteStore } from '../server/store'

let dir: string
let store: NoteStore
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cn-'))
  store = new NoteStore(dir)
  await store.init()
})
afterEach(() => fs.rm(dir, { recursive: true, force: true }))

describe('NoteStore', () => {
  it('seeds a welcome note in an empty folder', async () => {
    expect((await store.list()).map((n) => n.name)).toEqual(['Welcome.md'])
  })

  it('rejects names that could escape the folder or hit hidden files', async () => {
    for (const bad of ['../x.md', 'a/b.md', '.hidden.md', 'x.txt', 'a\\b.md']) {
      await expect(store.load(bad)).rejects.toBeInstanceOf(BadNameError)
    }
  })

  it('create never overwrites an existing note', async () => {
    const a = await store.create('Idea')
    await fs.writeFile(path.join(dir, a), 'mine', 'utf8')
    const b = await store.create('Idea')
    expect(b).not.toBe(a)
    expect(await fs.readFile(path.join(dir, a), 'utf8')).toBe('mine')
  })

  it('keeps block ids and saved positions across loads and external edits', async () => {
    await fs.writeFile(path.join(dir, 't.md'), 'A\n\nB', 'utf8')
    const first = await store.load('t.md')
    await store.savePositions('t.md', { [first.blocks[1]!.id]: { x: 400, y: 80 } })

    await fs.writeFile(path.join(dir, 't.md'), 'A edited\n\nB', 'utf8')
    const second = await store.load('t.md')
    expect(second.blocks.map((b) => b.id)).toEqual(first.blocks.map((b) => b.id))
    expect(second.blocks[1]).toMatchObject({ x: 400, y: 80 })
    expect(second.blocks[0]).toMatchObject({ x: null, y: null })
  })

  it('does not modify the Markdown file when loading or moving cards', async () => {
    const src = '# T\r\n\r\npara\r\n'
    await fs.writeFile(path.join(dir, 'c.md'), src, 'utf8')
    const note = await store.load('c.md')
    await store.savePositions('c.md', { [note.blocks[0]!.id]: { x: 1, y: 2 } })
    expect(await fs.readFile(path.join(dir, 'c.md'), 'utf8')).toBe(src)
  })

  it('survives a corrupt sidecar', async () => {
    await fs.writeFile(path.join(dir, 'z.md'), 'A', 'utf8')
    await fs.writeFile(path.join(dir, '.canvasnote', 'z.md.board.json'), '{not json', 'utf8')
    expect((await store.load('z.md')).blocks).toHaveLength(1)
  })

  it('saves and undoes content without accepting stale writes', async () => {
    const first = await store.load('Welcome.md')
    await store.saveContent(first.name, 'New\r\n\r\nText\r\n', first.content)
    await expect(store.saveContent(first.name, 'Stale', first.content)).rejects.toBeInstanceOf(ConflictError)
    const next = await store.load(first.name)
    await store.saveContent(first.name, first.content, next.content)
    expect((await store.load(first.name)).content).toBe(first.content)
  })

  it('preserves groups across edits and position writes, rejects duplicate membership', async () => {
    const first = await store.load('Welcome.md')
    const group = { id: 'g', title: 'Ideas', x: 1, y: 2, blockIds: [first.blocks[0]!.id] }
    await store.saveGroups(first.name, [group])
    await store.savePositions(first.name, { [first.blocks[0]!.id]: { x: 10, y: 20 } })
    await store.saveContent(first.name, first.content.replace('欢迎', '你好'), first.content)
    expect((await store.load(first.name)).groups).toEqual([group])
    await expect(store.saveGroups(first.name, [group, { ...group, id: 'g2' }])).rejects.toBeInstanceOf(BadNameError)
  })

  it('searches content and returns snippets', async () => {
    const name = await store.create('Travel', '# Travel\n\nA quiet botanical garden.')
    expect((await store.search('BOTANICAL')).map((n) => n.name)).toEqual([name])
    expect(await store.search('absent text')).toEqual([])
  })
})
