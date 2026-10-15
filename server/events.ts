import { EventEmitter } from 'node:events'

export type ServerEvent = { type: 'note-changed'; name: string } | { type: 'notes-changed' } | { type: 'canvas-changed'; folder: string } | { type: 'memory-changed' } | { type: 'repo-changed' } | { type: 'focus'; folder: string; names: string[] }

/** In-process pub/sub between the file watcher and open browser tabs (via SSE). */
export class EventBus {
  private emitter = new EventEmitter()

  constructor() {
    this.emitter.setMaxListeners(0)
  }

  emit(event: ServerEvent) {
    this.emitter.emit('event', event)
  }

  subscribe(listener: (e: ServerEvent) => void): () => void {
    this.emitter.on('event', listener)
    return () => this.emitter.off('event', listener)
  }
}
