import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventBus, type ServerEvent } from '../server/events'
import { watchNotes } from '../server/watcher'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cn-w-')).then((d) => fs.realpath(d))
})
afterEach(() => fs.rm(dir, { recursive: true, force: true }))

const until = async (cond: () => boolean, ms = 4000) => {
  const end = Date.now() + ms
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 25))
}

describe('watchNotes', () => {
  it('keeps notifying across repeated atomic saves (temp file + rename)', async () => {
    const file = path.join(dir, 'n.md')
    await fs.writeFile(file, 'v0')
    const bus = new EventBus()
    const events: ServerEvent[] = []
    bus.subscribe((e) => events.push(e))
    const watcher = watchNotes(dir, bus)
    await new Promise<void>((r) => watcher.on('ready', () => r()))

    for (let i = 1; i <= 3; i++) {
      const before = events.filter((e) => e.type === 'note-changed').length
      const tmp = path.join(dir, `.n.md.${i}.tmp`)
      await fs.writeFile(tmp, `v${i}`)
      await fs.rename(tmp, file)
      await until(() => events.filter((e) => e.type === 'note-changed').length > before)
      expect(events.filter((e) => e.type === 'note-changed').length, `save #${i}`).toBeGreaterThan(before)
    }
    await watcher.close()
  })

  it('ignores sidecar and temp files', async () => {
    const bus = new EventBus()
    const events: ServerEvent[] = []
    bus.subscribe((e) => events.push(e))
    const watcher = watchNotes(dir, bus)
    await new Promise<void>((r) => watcher.on('ready', () => r()))
    await fs.mkdir(path.join(dir, '.canvasnote'))
    await fs.writeFile(path.join(dir, '.canvasnote', 'x.board.json'), '{}')
    await fs.writeFile(path.join(dir, '.tmp'), 'x')
    await new Promise((r) => setTimeout(r, 500))
    expect(events).toEqual([])
    await watcher.close()
  })
})
