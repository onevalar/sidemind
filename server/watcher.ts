import path from 'node:path'
import chokidar from 'chokidar'
import type { EventBus } from './events'

/**
 * Watches the notes folder (not individual files), so editors that save by
 * "write temp file, rename over original" keep being noticed.
 */
export function watchNotes(root: string, bus: EventBus) {
  const watcher = chokidar.watch(root, {
    followSymlinks: false,
    ignoreInitial: true,
    // Skip dotfiles (temp files, the .canvasnote folder) but never the root itself.
    ignored: (p) => p !== root && path.basename(p).startsWith('.'),
    awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 20 },
  })

  const isNote = (p: string) => p.endsWith('.md')
  const name = (p: string) => path.relative(root, p).split(path.sep).join('/')

  watcher.on('change', (p) => {
    if (!isNote(p)) return
    bus.emit({ type: 'note-changed', name: name(p) })
    bus.emit({ type: 'notes-changed' })
  })
  watcher.on('add', (p) => {
    if (!isNote(p)) return
    bus.emit({ type: 'notes-changed' })
    bus.emit({ type: 'note-changed', name: name(p) })
  })
  watcher.on('unlink', (p) => isNote(p) && bus.emit({ type: 'notes-changed' }))
  watcher.on('addDir', () => bus.emit({ type: 'notes-changed' }))
  watcher.on('unlinkDir', () => bus.emit({ type: 'notes-changed' }))

  return watcher
}
