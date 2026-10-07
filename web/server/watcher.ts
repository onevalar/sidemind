import path from 'node:path'
import chokidar from 'chokidar'
import type { EventBus } from './events'

/**
 * Watches the notes folder (not individual files), so editors that save by
 * "write temp file, rename over original" keep being noticed.
 */
export function watchNotes(root: string, bus: EventBus) {
  const watcher = chokidar.watch(root, {
    depth: 0,
    ignoreInitial: true,
    // Skip dotfiles (temp files, the .canvasnote folder) but never the root itself.
    ignored: (p) => p !== root && path.basename(p).startsWith('.'),
    awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 20 },
  })

  const isNote = (p: string) => p.endsWith('.md') && path.dirname(p) === root

  watcher.on('change', (p) => isNote(p) && bus.emit({ type: 'note-changed', name: path.basename(p) }))
  watcher.on('add', (p) => {
    if (!isNote(p)) return
    bus.emit({ type: 'notes-changed' })
    bus.emit({ type: 'note-changed', name: path.basename(p) })
  })
  watcher.on('unlink', (p) => isNote(p) && bus.emit({ type: 'notes-changed' }))

  return watcher
}
