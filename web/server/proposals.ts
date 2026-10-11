import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ProposalDetail, ProposalSummary } from '../shared/types'
import type { ChangeEngine, ChangeSet, FileOp } from './changes'
import { BadNameError, ConflictError, NotFoundError, type LayoutPatch } from './store'

export type Proposal = {
  version: 1
  id: string
  createdAt: number
  reason: string
  conversation?: string
  files: FileOp[]
  layouts: { folder: string; patch: LayoutPatch }[]
  status: ProposalSummary['status']
  changeset?: string
}

/**
 * Changes the model decides to make on its own (not explicitly requested) wait here until the user
 * confirms. Applying re-checks every file against the content the proposal was computed from.
 */
export class ProposalStore {
  private directory: string
  constructor(cache: string, private changes: ChangeEngine) { this.directory = path.join(cache, 'proposals') }

  async create(input: { reason: string; conversation?: string; files: FileOp[]; layouts: { folder: string; patch: LayoutPatch }[] }): Promise<Proposal> {
    if (!input.files.length && !input.layouts.length) throw new BadNameError('提案没有任何修改。')
    const proposal: Proposal = { version: 1, id: randomUUID(), createdAt: Date.now(), reason: input.reason.slice(0, 1000), files: input.files, layouts: input.layouts, status: 'pending', ...(input.conversation ? { conversation: input.conversation } : {}) }
    await this.save(proposal)
    return proposal
  }

  private async save(proposal: Proposal): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true })
    const file = path.join(this.directory, proposal.id + '.json'), tmp = file + '.' + randomUUID() + '.tmp'
    try { await fs.writeFile(tmp, JSON.stringify(proposal), 'utf8'); await fs.rename(tmp, file) }
    finally { await fs.rm(tmp, { force: true }) }
  }

  async get(id: string): Promise<Proposal> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new BadNameError('提案编号无效。')
    try { return JSON.parse(await fs.readFile(path.join(this.directory, id + '.json'), 'utf8')) as Proposal }
    catch { throw new NotFoundError('找不到这个提案。') }
  }

  async list(status?: ProposalSummary['status']): Promise<ProposalSummary[]> {
    let files: string[]
    try { files = (await fs.readdir(this.directory)).filter(file => file.endsWith('.json')) } catch { return [] }
    const result: ProposalSummary[] = []
    for (const file of files) {
      try { const proposal = await this.get(file.slice(0, -5)); if (!status || proposal.status === status) result.push(summary(proposal)) } catch { /* unreadable */ }
    }
    return result.sort((a, b) => b.createdAt - a.createdAt)
  }

  async accept(id: string): Promise<{ proposal: ProposalSummary; changeset: ChangeSet }> {
    const proposal = await this.get(id)
    if (proposal.status !== 'pending') throw new ConflictError('这个提案已经处理过。')
    const set = this.changes.begin('确认提案：' + proposal.reason, { origin: 'proposal', ...(proposal.conversation ? { conversation: proposal.conversation } : {}) })
    try { await this.changes.apply(set, proposal.files, proposal.layouts) }
    catch (error) {
      if (error instanceof ConflictError) { proposal.status = 'stale'; await this.save(proposal); throw new ConflictError('提案依据的内容已经变化，未执行。请让助手重新检查。') }
      throw error
    }
    proposal.status = 'applied'; proposal.changeset = set.id
    await this.save(proposal)
    return { proposal: summary(proposal), changeset: set }
  }

  async reject(id: string): Promise<ProposalSummary> {
    const proposal = await this.get(id)
    if (proposal.status !== 'pending') throw new ConflictError('这个提案已经处理过。')
    proposal.status = 'rejected'
    await this.save(proposal)
    return summary(proposal)
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
