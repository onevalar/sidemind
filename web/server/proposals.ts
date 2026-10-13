import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ProposalDetail, ProposalSummary } from '../shared/types'
import type { ChangeEngine, ChangeSet, FileOp } from './changes'
import { BadNameError, ConflictError, NotFoundError, type LayoutPatch } from './store'
import { readRecord, StorageError, writeRecord } from './persistence'

export type Proposal = {
  version: 1
  id: string
  createdAt: number
  reason: string
  conversation?: string
  files: FileOp[]
  layouts: { folder: string; patch: LayoutPatch; expected?: LayoutPatch }[]
  status: ProposalSummary['status']
  changeset?: string
}

/**
 * Changes the model decides to make on its own (not explicitly requested) wait here until the user
 * confirms. Applying re-checks every file against the content the proposal was computed from.
 */
export class ProposalStore {
  private directory: string
  constructor(local: string, private changes: ChangeEngine) { this.directory = path.join(local, 'proposals') }

  async create(input: { reason: string; conversation?: string; files: FileOp[]; layouts: { folder: string; patch: LayoutPatch }[] }): Promise<Proposal> {
    if (!input.files.length && !input.layouts.length) throw new BadNameError('提案没有任何修改。')
    return this.changes.exclusive(async () => {
      const proposal: Proposal = { version: 1, id: randomUUID(), createdAt: Date.now(), reason: input.reason.slice(0, 1000), files: input.files, layouts: await this.changes.captureLayouts(input.layouts), status: 'pending', ...(input.conversation ? { conversation: input.conversation } : {}) }
      await this.save(proposal)
      return proposal
    })
  }

  private async save(proposal: Proposal): Promise<void> {
    await writeRecord(path.join(this.directory, proposal.id + '.json'), proposal)
  }

  async get(id: string): Promise<Proposal> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new BadNameError('提案编号无效。')
    const proposal = await readRecord<Proposal>(path.join(this.directory, id + '.json'))
    if (!proposal) throw new NotFoundError('找不到这个提案。')
    if (proposal.version !== 1 || proposal.id !== id || !Array.isArray(proposal.files) || !Array.isArray(proposal.layouts)) throw new StorageError('提案记录格式无效：' + id)
    return proposal
  }

  async list(status?: ProposalSummary['status']): Promise<ProposalSummary[]> {
    let files: string[]
    try { files = (await fs.readdir(this.directory)).filter(file => file.endsWith('.json')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    const result: ProposalSummary[] = []
    for (const file of files) {
      const proposal = await this.get(file.slice(0, -5)); if (!status || proposal.status === status) result.push(summary(proposal))
    }
    return result.sort((a, b) => b.createdAt - a.createdAt)
  }

  async accept(id: string): Promise<{ proposal: ProposalSummary; changeset: ChangeSet }> {
    return this.changes.exclusive(async () => {
      const proposal = await this.get(id)
      if (proposal.status === 'applied' && proposal.changeset) return { proposal: summary(proposal), changeset: await this.changes.get(proposal.changeset) }
      if (proposal.status !== 'pending') throw new ConflictError('这个提案已经处理过。')
      if (proposal.layouts.some(layout => !layout.expected)) throw new ConflictError('旧提案没有记录当时的画布状态，请让助手重新检查后提出修改。')
      const set = this.changes.begin('确认提案：' + proposal.reason, { origin: 'proposal', ...(proposal.conversation ? { conversation: proposal.conversation } : {}) })
      // Deterministic change identity also covers a crash after apply but before saving proposal status.
      set.id = proposal.id
      try { await this.changes.apply(set, proposal.files, proposal.layouts, 'accept') }
      catch (error) {
        if (error instanceof ConflictError) { proposal.status = 'stale'; await this.save(proposal); throw new ConflictError('提案依据的内容已经变化，未执行。请让助手重新检查。') }
        throw error
      }
      proposal.status = 'applied'; proposal.changeset = set.id
      await this.save(proposal)
      return { proposal: summary(proposal), changeset: set }
    })
  }

  async reject(id: string): Promise<ProposalSummary> {
    return this.changes.exclusive(async () => {
      const proposal = await this.get(id)
      if (proposal.status !== 'pending') throw new ConflictError('这个提案已经处理过。')
      // A crash may have committed the change but not its proposal status. Do not call it rejected.
      try {
        await this.changes.get(proposal.id)
        throw new ConflictError('提案修改已经保存，请再次确认以恢复状态，或在修改记录中撤销。')
      } catch (error) { if (!(error instanceof NotFoundError)) throw error }
      proposal.status = 'rejected'
      await this.save(proposal)
      return summary(proposal)
    })
  }
}

export function summary(proposal: Proposal): ProposalSummary {
  return {
    id: proposal.id, createdAt: proposal.createdAt, reason: proposal.reason, status: proposal.status, ...(proposal.conversation ? { conversation: proposal.conversation } : {}),
    files: proposal.files.filter(op => op.area === 'notes').map(op => ({ name: op.name, kind: op.before === null ? 'create' : op.after === null ? 'delete' : 'edit' })),
    layouts: proposal.layouts.map(layout => layout.folder),
  }
}

export function detail(proposal: Proposal): ProposalDetail {
  return { ...summary(proposal), diffs: proposal.files.filter(op => op.area === 'notes').map(op => ({ name: op.name, before: op.before, after: op.after })) }
}
