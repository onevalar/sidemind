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
    expect(await store.load('Welcome.md')).toEqual({ name: 'Welcome.md', space: '', content: expect.stringContaining('# 欢迎') })
  })

  it('shows readable article summaries instead of Markdown syntax, without rewriting the source', async () => {
    const content = '# 摘要\n\n读**书**与[链接](https://example.test)。\n\n- [x] 已完成\n\n|区域|内容|\n|---|---|\n|左侧|阅读|\n\n```js\nconsole.log("hi")\n```\n\n<!-- private comment -->\n'
    const name = await store.create('Summary', content)
    expect((await store.list()).find(note => note.name === name)?.excerpt).toBe('读书与链接。 已完成 区域 内容 左侧 阅读 console.log("hi")')
    expect((await store.load(name)).content).toBe(content)
  })

  it('rejects traversal, hidden paths and non-Markdown names', async () => {
    for (const bad of ['../x.md', 'a/../x.md', '/x.md', '.hidden.md', '.canvasnote/x.md', 'a/.private/x.md', 'x.txt', 'a\\b.md', 'a\0.md']) {
      await expect(store.load(bad)).rejects.toBeInstanceOf(BadNameError)
      await expect(store.savePositions({ [bad]: { x: -17, y: 83 } })).rejects.toBeInstanceOf(BadNameError)
    }
    for (const folder of ['../outside', '/outside', '.private', 'a/../outside', 'a\\b']) {
      await expect(store.createFolder(folder)).rejects.toBeInstanceOf(BadNameError)
      await expect(store.create('X', '# X', folder)).rejects.toBeInstanceOf(BadNameError)
    }
  })

  it('excludes hidden files and symlink files from discovery and rejects opening them', async () => {
    await fs.mkdir(path.join(dir, '.private'))
    await fs.writeFile(path.join(dir, '.private', 'secret.md'), 'private')
    await fs.writeFile(path.join(dir, '.hidden.md'), 'private')
    await fs.symlink(path.join(dir, 'Welcome.md'), path.join(dir, 'alias.md'))
    expect(await store.folders()).toEqual([''])
    expect((await store.list()).map(note => note.name)).toEqual(['Welcome.md'])
    await expect(store.load('alias.md')).rejects.toBeInstanceOf(BadNameError)
    await expect(store.saveContent('alias.md', 'changed', 'anything')).rejects.toBeInstanceOf(BadNameError)
    await expect(store.savePositions({ 'alias.md': { x: 91, y: -73 } })).rejects.toBeInstanceOf(BadNameError)
  })

  it.each(['inside', 'outside'])('rejects directory symlinks pointing %s the workspace', async (location) => {
    const target = location === 'inside' ? path.join(dir, 'real') : await fs.mkdtemp(path.join(os.tmpdir(), 'cn-outside-'))
    try {
      await fs.mkdir(target, { recursive: true })
      await fs.writeFile(path.join(target, 'n.md'), '# Target')
      await fs.symlink(target, path.join(dir, 'alias'))
      expect(await store.folders()).not.toContain('alias')
      expect((await store.list()).map(note => note.name)).not.toContain('alias/n.md')
      await expect(store.load('alias/n.md')).rejects.toBeInstanceOf(BadNameError)
      await expect(store.create('New', '# New', 'alias')).rejects.toBeInstanceOf(BadNameError)
      await expect(store.createFolder('alias/child')).rejects.toBeInstanceOf(BadNameError)
    } finally {
      if (location === 'outside') await fs.rm(target, { recursive: true, force: true })
    }
  })

  it('create never overwrites an existing note', async () => {
    const a = await store.create('Idea')
    await fs.writeFile(path.join(dir, a), 'mine', 'utf8')
    const b = await store.create('Idea')
    expect(b).not.toBe(a)
    expect(await fs.readFile(path.join(dir, a), 'utf8')).toBe('mine')
  })

  it('keeps exact article coordinates through title/body/mtime changes, insertion and restart', async () => {
    await store.createFolder('Work')
    await store.create('Zeta', '# Zeta\n\nOriginal body.')
    await store.create('Alpha', '# Alpha\n\nNested body.', 'Work')
    const positions = {
      'Welcome.md': { x: -731, y: 409 },
      'Zeta.md': { x: 118, y: -563 },
      'Work/Alpha.md': { x: 937, y: -211 },
    }
    await store.list()
    await store.savePositions(positions)
    const assertPositions = async (current: NoteStore) => {
      const notes = await current.list()
      for (const [name, position] of Object.entries(positions)) expect(notes.find(note => note.name === name)?.position, name).toEqual(position)
      return notes
    }
    await fs.writeFile(path.join(dir, 'Zeta.md'), '# A renamed title\n\nReplacement body with several\n\nnew paragraphs.')
    await fs.writeFile(path.join(dir, 'Work', 'Alpha.md'), '# Z changed title\n\nExternally replaced nested body.')
    await fs.utimes(path.join(dir, 'Zeta.md'), 1234567890, 1234567890)
    const edited = await assertPositions(store)
    expect(edited.find(note => note.name === 'Zeta.md')).toMatchObject({ title: 'A renamed title', excerpt: expect.stringContaining('Replacement body'), mtime: 1234567890000 })
    await fs.writeFile(path.join(dir, '000 inserted.md'), '# New root article')
    await fs.writeFile(path.join(dir, 'Work', '000 inserted.md'), '# New nested article')
    expect(await assertPositions(store)).toHaveLength(5)
    const restarted = new NoteStore(dir)
    await restarted.init()
    expect(await assertPositions(restarted)).toHaveLength(5)
    expect((await restarted.search('externally replaced'))[0]).toMatchObject({ name: 'Work/Alpha.md', position: positions['Work/Alpha.md'] })
  })

  it('does not write Markdown on reads, visits or article moves', async () => {
    const src = '# T\r\n\r\npara\r\n'
    const file = path.join(dir, 'c.md')
    await fs.writeFile(file, src, 'utf8')
    await fs.utimes(file, 1234567890, 1234567890)
    const mtime = (await fs.stat(file)).mtimeMs
    expect((await store.load('c.md')).content).toBe(src)
    await store.list()
    await store.search('para')
    await store.recordOpen('c.md')
    await store.savePositions({ 'c.md': { x: -431, y: 89 } })
    await new NoteStore(dir).list()
    expect(await fs.readFile(file, 'utf8')).toBe(src)
    expect((await fs.stat(file)).mtimeMs).toBe(mtime)
  })

  it.each([
    '{not json',
    JSON.stringify({ version: 1, notes: [] }),
    JSON.stringify({ version: 1, notes: { 'Welcome.md': { position: { x: 'bad', y: 7 }, lastOpenedAt: 0 } } }),
  ])('preserves malformed library data and keeps Markdown readable (%s)', async (corrupt) => {
    const original = await store.load('Welcome.md')
    const file = path.join(dir, '.canvasnote', 'library.json')
    await fs.writeFile(file, corrupt)
    const restarted = new NoteStore(dir)
    await restarted.init()
    expect(await restarted.load(original.name)).toEqual(original)
    await expect(restarted.list()).rejects.toBeInstanceOf(ConflictError)
    await expect(restarted.savePositions({ [original.name]: { x: 619, y: -47 } })).rejects.toBeInstanceOf(ConflictError)
    await expect(restarted.recordOpen(original.name)).rejects.toBeInstanceOf(ConflictError)
    expect(await fs.readFile(file, 'utf8')).toBe(corrupt)
    expect(await fs.readFile(path.join(dir, original.name), 'utf8')).toBe(original.content)
  })

  it('saves and undoes content without accepting stale writes', async () => {
    const first = await store.load('Welcome.md')
    await store.saveContent(first.name, 'New\r\n\r\nText\r\n', first.content)
    await expect(store.saveContent(first.name, 'Stale', first.content)).rejects.toBeInstanceOf(ConflictError)
    const next = await store.load(first.name)
    await store.saveContent(first.name, first.content, next.content)
    expect((await store.load(first.name)).content).toBe(first.content)
  })

  it('uses real nested folders for create/load/save/search and isolates same-named articles', async () => {
    await store.createFolder('Work')
    await store.createFolder('Work/Research')
    expect(await store.folders()).toEqual(['', 'Work', 'Work/Research'])
    const root = await store.create('Travel', '# Root\n\nRoot body.')
    const nested = await store.create('Travel', '# Travel\n\nA quiet botanical garden.', 'Work/Research')
    expect(nested).toBe('Work/Research/Travel.md')
    const original = await store.load(nested)
    expect(original.space).toBe('Work/Research')
    await store.savePositions({ [root]: { x: -619, y: 257 }, [nested]: { x: 83, y: -941 } })
    await store.saveContent(nested, '# Garden\n\nA new botanical observation.', original.content)
    await store.savePositions({ [nested]: { x: 367, y: -149 } })
    const restarted = new NoteStore(dir)
    expect(await restarted.load(nested)).toEqual({ name: nested, space: 'Work/Research', content: '# Garden\n\nA new botanical observation.' })
    expect(await fs.readFile(path.join(dir, nested), 'utf8')).toBe((await restarted.load(nested)).content)
    expect((await restarted.list()).find(note => note.name === root)).toMatchObject({ space: '', position: { x: -619, y: 257 }, title: 'Root' })
    expect(await restarted.search('BOTANICAL')).toEqual([expect.objectContaining({ name: nested, space: 'Work/Research', position: { x: 367, y: -149 }, snippet: expect.stringContaining('botanical observation') })])
    expect(await restarted.search('absent text')).toEqual([])
  })

  it('rejects invalid positions without changing saved coordinates', async () => {
    const position = { x: -53, y: 827 }
    await store.savePositions({ 'Welcome.md': position })
    for (const invalid of [{ x: NaN, y: 7 }, { x: 5, y: Infinity }, { x: 10000001, y: 3 }]) {
      await expect(store.savePositions({ 'Welcome.md': invalid })).rejects.toBeInstanceOf(BadNameError)
    }
    expect((await store.list())[0]!.position).toEqual(position)
  })
})
