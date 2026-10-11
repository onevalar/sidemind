import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AgentScope, PlanStep } from '../shared/types'
import type { AIMessage } from './ai'
import { BadNameError, NotFoundError } from './store'

export type Conversation = {
  version: 1
  id: string
  scope: AgentScope
  createdAt: number
  updatedAt: number
  /** Model-facing history, possibly compacted. */
  messages: AIMessage[]
  /** What the user saw, never compacted, for restoring the panel. */
  transcript: { role: 'user' | 'assistant'; text: string; at: number }[]
  changesets: string[]
  plan?: PlanStep[]
  /** Transcript length already distilled into memory by a push. */
  distilled: number
}

export const scopeKey = (scope: AgentScope) => scope.kind === 'note' ? 'note:' + scope.name : scope.kind + ':' + scope.folder

/**
 * Raw conversations stay in the local cache (never committed); pushes distill their durable
 * conclusions into memory. Survives page reloads and server restarts.
 */
export class ConversationStore {
  private loaded = new Map<string, Conversation>()
  constructor(private directory: string) {}

  create(scope: AgentScope): Conversation {
    const now = Date.now()
    const conversation: Conversation = { version: 1, id: randomUUID(), scope, createdAt: now, updatedAt: now, messages: [], transcript: [], changesets: [], distilled: 0 }
    this.loaded.set(conversation.id, conversation)
    return conversation
  }

  async get(id: string): Promise<Conversation> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new BadNameError('对话编号无效。')
    const cached = this.loaded.get(id)
    if (cached) return cached
    try {
      const conversation = JSON.parse(await fs.readFile(path.join(this.directory, id + '.json'), 'utf8')) as Conversation
      this.loaded.set(id, conversation)
      return conversation
    } catch { throw new NotFoundError('找不到这段对话，请开始新对话。') }
  }

  async save(conversation: Conversation): Promise<void> {
    conversation.updatedAt = Date.now()
    await fs.mkdir(this.directory, { recursive: true })
    const file = path.join(this.directory, conversation.id + '.json'), tmp = file + '.' + randomUUID() + '.tmp'
    try { await fs.writeFile(tmp, JSON.stringify(conversation), 'utf8'); await fs.rename(tmp, file) }
    finally { await fs.rm(tmp, { force: true }) }
  }

  async all(): Promise<Conversation[]> {
    let files: string[]
    try { files = (await fs.readdir(this.directory)).filter(file => /^[a-f0-9-]{36}\.json$/.test(file)) } catch { return [] }
    const result: Conversation[] = []
    for (const file of files) { try { result.push(await this.get(file.slice(0, -5))) } catch { /* unreadable record */ } }
    return result.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** The most recent conversation for a scope, to restore the panel after a reload. */
  async latest(scope: AgentScope): Promise<Conversation | null> {
    const key = scopeKey(scope)
    return (await this.all()).find(conversation => scopeKey(conversation.scope) === key && conversation.transcript.length) ?? null
  }
}
