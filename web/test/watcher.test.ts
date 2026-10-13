import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventBus, type ServerEvent } from '../server/events'
import { watchNotes } from '../server/watcher'

let dir: string
let watcher: ReturnType<typeof watchNotes> | undefined
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cn-w-')).then((d) => fs.realpath(d))
  watcher = undefined
})
afterEach(async () => {
  await watcher?.close()
  await fs.rm(dir, { recursive: true, force: true })
})

const until = async (cond: () => boolean, ms = 4000) => {
  const end = Date.now() + ms
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 25))
}

describe('watchNotes', () => {
  it('keeps notifying with relative filenames across repeated nested atomic saves', async () => {
    await fs.mkdir(path.join(dir, 'Work', 'deep'), { recursive: true })
    const file = path.join(dir, 'Work', 'deep', 'n.md')
    await fs.writeFile(file, 'v0')
    const bus = new EventBus()
    const events: ServerEvent[] = []
    bus.subscribe((e) => events.push(e))
    watcher = watchNotes(dir, bus)
    await new Promise<void>((r) => watcher!.once('ready', r))
    expect(events).toEqual([])

    for (let i = 1; i <= 3; i++) {
      events.length = 0
      const tmp = path.join(dir, 'Work', 'deep', `.n.md.${i}.tmp`)
      await fs.writeFile(tmp, `v${i}`)
      await fs.rename(tmp, file)
      await until(() => events.some(e => e.type === 'note-changed') && events.some(e => e.type === 'notes-changed'))
      expect(events, `save #${i}`).toContainEqual({ type: 'note-changed', name: 'Work/deep/n.md' })
      expect(events, `list refresh #${i}`).toContainEqual({ type: 'notes-changed' })
      expect(events.filter(e => e.type === 'note-changed').every(e => e.name === 'Work/deep/n.md')).toBe(true)
    }
  })

  it('refreshes for nested file and real folder additions and removals', async () => {
    await fs.mkdir(path.join(dir, 'Work'))
    const bus = new EventBus()
    const events: ServerEvent[] = []
    bus.subscribe(e => events.push(e))
    watcher = watchNotes(dir, bus)
    await new Promise<void>(r => watcher!.once('ready', r))
    const folder = path.join(dir, 'Work', 'new')
    const file = path.join(folder, 'article.md')
    for (const action of [() => fs.mkdir(folder), () => fs.writeFile(file, '# New'), () => fs.unlink(file), () => fs.rmdir(folder)]) {
      events.length = 0
      await action()
      await until(() => events.some(e => e.type === 'notes-changed'))
      expect(events).toContainEqual({ type: 'notes-changed' })
      if (await fs.access(file).then(() => true, () => false)) {
        await until(() => events.some(e => e.type === 'note-changed'))
        expect(events).toContainEqual({ type: 'note-changed', name: 'Work/new/article.md' })
      }
    }
  })

  it('ignores private directories, hidden Markdown and editor temp files at every depth', async () => {
    await fs.mkdir(path.join(dir, 'Work', 'deep'), { recursive: true })
    const bus = new EventBus()
    const events: ServerEvent[] = []
    bus.subscribe((e) => events.push(e))
    watcher = watchNotes(dir, bus)
    await new Promise<void>((r) => watcher!.once('ready', r))
    for (const folder of ['.canvasnote', 'Work/.private/deep']) await fs.mkdir(path.join(dir, folder), { recursive: true })
    for (const name of ['.canvasnote/library.json', '.canvasnote/private.md', '.hidden.md', 'Work/.private/deep/secret.md', 'Work/deep/.hidden.md', 'Work/deep/.n.md.uuid.tmp', 'Work/deep/n.md.tmp', 'Work/deep/readme.txt']) {
      await fs.writeFile(path.join(dir, name), 'private or temporary')
    }
    await new Promise((r) => setTimeout(r, 500))
    expect(events).toEqual([])
  })
})
