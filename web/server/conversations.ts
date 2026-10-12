import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AgentScope, PlanStep } from '../shared/types'
import type { AIMessage } from './ai'
import { BadNameError, ConflictError, NotFoundError } from './store'
import { readRecord, StorageError, WorkspaceWriter, writeRecord } from './persistence'

export type Conversation = {
  version: 1
  id: string
  scope: AgentScope
  createdAt: number
  updatedAt: number
  revision?: number
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
 * Raw conversations are durable local data, excluded from Git but included in full backups.
 */
export class ConversationStore {
  constructor(private directory: string, private writer = new WorkspaceWriter()) {}

  create(scope: AgentScope): Conversation {
    const now = Date.now()
    const conversation: Conversation = { version: 1, id: randomUUID(), scope, createdAt: now, updatedAt: now, messages: [], transcript: [], changesets: [], distilled: 0 }
    return conversation
  }

  async get(id: string): Promise<Conversation> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new BadNameError('对话编号无效。')
    const conversation = await readRecord<Conversation>(path.join(this.directory, id + '.json'))
    if (!conversation) throw new NotFoundError('找不到这段对话，请开始新对话。')
    if (conversation.version !== 1 || conversation.id !== id || !Array.isArray(conversation.messages) || !Array.isArray(conversation.transcript)) throw new StorageError('对话记录格式无效，请保留文件并检查备份。')
    return conversation
  }

  async save(conversation: Conversation): Promise<void> {
    await this.writer.run(async () => {
      const file = path.join(this.directory, conversation.id + '.json')
      const current = await readRecord<Conversation>(file)
      if ((current?.revision ?? 0) !== (conversation.revision ?? 0)) throw new ConflictError('对话已在另一请求中更新，未覆盖新消息。')
      const next = { ...conversation, updatedAt: Date.now(), revision: (conversation.revision ?? 0) + 1 }
      await writeRecord(file, next)
      Object.assign(conversation, next)
    })
  }

  async all(): Promise<Conversation[]> {
    let files: string[]
    try { files = (await fs.readdir(this.directory)).filter(file => /^[a-f0-9-]{36}\.json$/.test(file)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    const result: Conversation[] = []
    for (const file of files) result.push(await this.get(file.slice(0, -5)))
    return result.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** The most recent conversation for a scope, to restore the panel after a reload. */
  async latest(scope: AgentScope): Promise<Conversation | null> {
    const key = scopeKey(scope)
    return (await this.all()).find(conversation => scopeKey(conversation.scope) === key && conversation.transcript.length) ?? null
  }
}
