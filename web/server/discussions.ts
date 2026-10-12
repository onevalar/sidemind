import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { AnswerVersionDTO, CaptureDTO, DiscussionDTO, DiscussionSummaryDTO, DraftDTO, DraftItemDTO, ResolvedSourceDTO, SourceRefDTO, TurnDTO } from '../shared/types'
import { project } from '../shared/projection'
import { BadNameError, ConflictError, NotFoundError, contentVersion, type NoteStore } from './store'
import { readRecord, StorageError, writeRecord } from './persistence'

/** A discussion, draft, source or capture that does not exist (reported by name, unlike a missing note). */
export class MissingRecordError extends NotFoundError {}

const ID = /^[a-f0-9-]{32,36}$/
const MAX_TEXT = 100000, MAX_QUESTION = 20000, MAX_ITEMS = 50, CONTEXT = 120
const derive = (...parts: (string | number)[]) => contentVersion(parts.join('\0')).slice(0, 32)

type Origin = DiscussionDTO['origin']
const validOrigin = (origin: unknown): origin is Origin => {
  const value = origin as Origin | null
  return !!value && typeof value === 'object' && (value.kind === 'chat' || (value.kind === 'note' && typeof value.noteId === 'string' && ID.test(value.noteId) && (value.sourceId === undefined || (typeof value.sourceId === 'string' && ID.test(value.sourceId)))))
}

/** Rejects missing parents, duplicate ids and cycles regardless of the order turns are stored in. */
export function validateTurns(turns: TurnDTO[]): void {
  const byId = new Map<string, TurnDTO>(), keys = new Set<string>()
  for (const turn of turns) {
    if (byId.has(turn.id)) throw new StorageError('讨论中存在重复的节点编号。')
    if (keys.has(turn.requestKey)) throw new StorageError('讨论中存在重复的请求键。')
    byId.set(turn.id, turn)
    keys.add(turn.requestKey)
  }
  const state = new Map<string, 1 | 2>()
  const visit = (turn: TurnDTO) => {
    if (state.get(turn.id) === 2) return
    if (state.get(turn.id) === 1) throw new StorageError('讨论图中存在环，已拒绝使用。')
    state.set(turn.id, 1)
    for (const parent of turn.parents) {
      const found = byId.get(parent)
      if (!found) throw new StorageError('讨论节点引用了不存在的父节点。')
      visit(found)
    }
    state.set(turn.id, 2)
  }
  for (const turn of turns) visit(turn)
}

/** Every ancestor of the given parents, parents before children, each exactly once however many paths reach it. */
export function ancestry(turns: TurnDTO[], parents: string[]): TurnDTO[] {
  const byId = new Map(turns.map(item => [item.id, item]))
  const seen = new Set<string>(), order: TurnDTO[] = []
  const visit = (item: TurnDTO) => {
    if (seen.has(item.id)) return
    seen.add(item.id)
    for (const parent of item.parents) visit(byId.get(parent)!)
    order.push(item)
  }
  for (const parent of parents) visit(byId.get(parent)!)
  return order
}

const text = (value: unknown, label: string, max: number, empty = false): string => {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max) throw new BadNameError(label + '无效或过长。')
  return value
}
const ids = (value: unknown, label: string): string[] => {
  if (!Array.isArray(value) || value.length > MAX_ITEMS || value.some(item => typeof item !== 'string' || !ID.test(item)) || new Set(value).size !== value.length) throw new BadNameError(label + '无效。')
  return value as string[]
}

/**
 * Unified discussion model. Everything here is single-writer through the workspace queue.
 * - `local/discussions`, `local/drafts`: raw history and unsent input; included in full backups, not Git.
 * - `research/sources`, `research/captures`: user-selected evidence; committed with the notes.
 */
export class ResearchStore {
  private readonly discussions: string
  private readonly drafts: string
  private readonly sources: string
  private readonly captures: string
  private readonly summaryDir: string

  constructor(private store: NoteStore) {
    this.discussions = path.join(store.paths.local, 'discussions')
    this.drafts = path.join(store.paths.local, 'drafts')
    this.sources = path.join(store.paths.research, 'sources')
    this.captures = path.join(store.paths.research, 'captures')
    this.summaryDir = path.join(store.paths.local, 'summaries')
  }

  private exclusive<T>(action: () => Promise<T>) { return this.store.writer.run(action) }

  private async read<T extends { version: number; id: string }>(directory: string, id: string, label: string): Promise<T> {
    if (typeof id !== 'string' || !ID.test(id)) throw new BadNameError(label + '编号无效。')
    const record = await readRecord<T>(path.join(directory, id + '.json'))
    if (!record) throw new MissingRecordError('找不到' + label + '。')
    if (record.version !== 1 || record.id !== id) throw new StorageError(label + '记录格式无效，请保留文件并检查备份。')
    return record
  }

  private async list<T>(directory: string, label: string): Promise<T[]> {
    let files: string[]
    try { files = (await fs.readdir(directory)).filter(file => /^[a-f0-9-]{32,36}\.json$/.test(file)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    const result: T[] = []
    for (const file of files) result.push(await this.read<any>(directory, file.slice(0, -5), label))
    return result
  }

  // ---- Sources ----

  /**
   * Freezes a selection as evidence. The same selection of the same note version always yields the same
   * source; an ambiguous quote is refused rather than attached to a guessed position.
   */
  async createSource(input: { note: string; quote: string; start?: number }): Promise<SourceRefDTO> {
    const quote = text(input?.quote, '引用文字', MAX_TEXT)
    return this.exclusive(async () => {
      const note = await this.store.load(input.note), identity = await this.store.identity(input.note)
      const found = locate(note.content, quote)
      let range: { start: number; end: number }
      if (input.start !== undefined) {
        const at = found.find(item => item.start === input.start) ?? (note.content.startsWith(quote, input.start) ? { start: input.start, end: input.start + quote.length } : undefined)
        if (!at) throw new ConflictError('所选文字与笔记当前内容不一致，请重新选择。')
        range = at
      } else if (found.length === 1) range = found[0]!
      else throw new ConflictError(found.length ? '这段文字在笔记中出现多次，请选择更长的文字。' : '笔记中找不到所选文字，请重新选择。')
      const { start, end } = range
      const exact = note.content.slice(start, end)
      const source: SourceRefDTO = {
        id: derive(identity.id, identity.version, start, exact), noteId: identity.id, notePath: identity.name, noteVersion: identity.version, quote: exact,
        before: note.content.slice(Math.max(0, start - CONTEXT), start), after: note.content.slice(end, end + CONTEXT),
        section: sectionBefore(note.content, start), start, end, createdAt: Date.now(),
      }
      const existing = await readRecord<SourceRefDTO & { version: 1 }>(path.join(this.sources, source.id + '.json'))
      if (existing) return stripVersion(existing)
      await writeRecord(path.join(this.sources, source.id + '.json'), { version: 1, ...source })
      return source
    })
  }

  async getSource(id: string): Promise<SourceRefDTO> {
    return stripVersion(await this.read<SourceRefDTO & { version: 1 }>(this.sources, id, '来源'))
  }

  /** Re-locates a frozen source in today's note. Never guesses between duplicate matches. */
  async resolveSource(id: string): Promise<ResolvedSourceDTO> {
    const source = await this.getSource(id)
    return this.exclusive(async () => {
      const current = (await this.store.identities()).paths[source.noteId]
      if (!current) return { source, status: 'note-deleted', notePath: null, start: null, end: null }
      const note = await this.store.load(current)
      if (contentVersion(note.content) === source.noteVersion) return { source, status: 'current', notePath: current, start: source.start, end: source.end }
      let found = occurrences(note.content, source.quote)
      if (found.length > 1) found = found.filter(at => note.content.slice(Math.max(0, at - source.before.length), at) === source.before && note.content.slice(at + source.quote.length, at + source.quote.length + source.after.length) === source.after)
      if (found.length === 1) return { source, status: 'moved', notePath: current, start: found[0]!, end: found[0]! + source.quote.length }
      const status = found.length ? 'ambiguous' : 'missing'
      return { source, status, notePath: current, start: null, end: null }
    })
  }

  // ---- Discussions ----

  private discussionFile = (id: string) => path.join(this.discussions, id + '.json')

  async getDiscussion(id: string): Promise<DiscussionDTO> {
    const discussion = await this.read<DiscussionDTO & { version: 1 }>(this.discussions, id, '讨论')
    validateTurns(discussion.turns)
    return stripVersion(discussion)
  }

  async listDiscussions(options: { archived?: boolean } = {}): Promise<Omit<DiscussionDTO, 'turns'>[]> {
    const all = await this.list<DiscussionDTO & { version: 1 }>(this.discussions, '讨论')
    return all.filter(item => options.archived === undefined || item.archived === options.archived).sort((a, b) => b.updatedAt - a.updatedAt)
      .map(({ turns, version, ...rest }) => rest as Omit<DiscussionDTO, 'turns'>)
  }

  /** With an explicit id the call is idempotent: an existing discussion is returned unchanged. */
  async createDiscussion(input: { id?: string; title: string; origin?: Origin }): Promise<DiscussionDTO> {
    const title = text(input?.title, '标题', 200)
    const origin = input.origin ?? { kind: 'chat' as const }
    if (!validOrigin(origin)) throw new BadNameError('讨论入口无效。')
    if (input.id !== undefined && !ID.test(input.id)) throw new BadNameError('讨论编号无效。')
    return this.exclusive(async () => {
      const id = input.id ?? randomUUID()
      const existing = await readRecord<DiscussionDTO & { version: 1 }>(this.discussionFile(id))
      if (existing) return this.getDiscussion(id)
      const now = Date.now()
      const discussion: DiscussionDTO = { id, title, origin, revision: 1, archived: false, turns: [], createdAt: now, updatedAt: now }
      await writeRecord(this.discussionFile(id), { version: 1, ...discussion })
      return discussion
    })
  }

  private async saveDiscussion(discussion: DiscussionDTO, expected: number): Promise<void> {
    const current = await readRecord<DiscussionDTO>(this.discussionFile(discussion.id))
    if (!current || current.revision !== expected) throw new ConflictError('讨论已在另一请求中更新，未覆盖新内容。')
    validateTurns(discussion.turns)
    discussion.revision = expected + 1
    discussion.updatedAt = Date.now()
    await writeRecord(this.discussionFile(discussion.id), { version: 1, ...discussion })
  }

  async setArchived(id: string, archived: boolean): Promise<DiscussionDTO> {
    return this.exclusive(async () => {
      const discussion = await this.getDiscussion(id)
      if (discussion.archived !== archived) { const revision = discussion.revision; discussion.archived = archived; await this.saveDiscussion(discussion, revision) }
      return discussion
    })
  }

  /** Adds one question node. Repeating a `requestKey` returns the node created the first time. */
  async addTurn(discussionId: string, input: { parents?: string[]; question: string; sourceIds?: string[]; requestKey: string }): Promise<TurnDTO> {
    const question = text(input?.question, '问题', MAX_QUESTION)
    const requestKey = text(input.requestKey, '请求键', 200)
    return this.exclusive(async () => {
      const discussion = await this.getDiscussion(discussionId)
      const existing = discussion.turns.find(turn => turn.requestKey === requestKey)
      if (existing) {
        if (existing.question !== question) throw new ConflictError('同一请求键不能用于不同问题。')
        return existing
      }
      const parents = ids(input.parents ?? [], '父节点'), sourceIds = ids(input.sourceIds ?? [], '来源')
      for (const parent of parents) {
        const found = discussion.turns.find(turn => turn.id === parent)
        if (!found) throw new BadNameError('父节点不在这段讨论中。')
        // As in ChatGit: a question continues, or is compared with, an answer that exists.
        if (!found.answers.length) throw new BadNameError('「' + found.question.slice(0, 30) + '」还没有回答，不能从它继续或把它拿来比较。')
      }
      for (const source of sourceIds) await this.getSource(source)
      const frozen: Record<string, string> = {}
      for (const ancestor of ancestry(discussion.turns, parents)) { const answer = ancestor.answers.at(-1); if (answer) frozen[ancestor.id] = answer.id }
      const turn: TurnDTO = { id: derive(discussionId, requestKey), parents, question, sourceIds, requestKey, ...(parents.length ? { frozen } : {}), answers: [], createdAt: Date.now() }
      const revision = discussion.revision
      discussion.turns.push(turn)
      await this.saveDiscussion(discussion, revision)
      return turn
    })
  }

  /** Answers are append-only versions: retrying never rewrites what a note or capture already cites. */
  async addAnswer(discussionId: string, turnId: string, input: { text: string; runId?: string; summarizedTurns?: string[] }): Promise<AnswerVersionDTO> {
    const body = text(input?.text, '回答', MAX_TEXT, true)
    if (input.runId !== undefined) text(input.runId, '运行编号', 200)
    const summarizedTurns = input.summarizedTurns?.length ? ids(input.summarizedTurns, '摘要节点') : undefined
    return this.exclusive(async () => {
      const discussion = await this.getDiscussion(discussionId)
      const turn = discussion.turns.find(item => item.id === turnId)
      if (!turn) throw new MissingRecordError('找不到这个问题节点。')
      const existing = input.runId === undefined ? undefined : turn.answers.find(answer => answer.runId === input.runId)
      if (existing) return existing
      const answer: AnswerVersionDTO = { id: randomUUID(), text: body, createdAt: Date.now(), ...(input.runId === undefined ? {} : { runId: input.runId }), ...(summarizedTurns ? { summarizedTurns } : {}) }
      const revision = discussion.revision
      turn.answers.push(answer)
      await this.saveDiscussion(discussion, revision)
      return answer
    })
  }

  // ---- Summaries (derived, local, rebuildable: they only ever shorten an older answer inside a request) ----

  async getSummary(answerId: string): Promise<string | null> {
    if (!ID.test(answerId)) return null
    const record = await readRecord<{ version: 1; answerId: string; text: string }>(path.join(this.summaryDir, answerId + '.json'))
    return record && record.version === 1 && record.answerId === answerId && typeof record.text === 'string' ? record.text : null
  }

  /** Keeps the first summary of an answer version, so a later request never silently sees different wording. */
  async setSummary(answerId: string, input: { text: string; model: string }): Promise<string> {
    if (!ID.test(answerId)) throw new BadNameError('回答编号无效。')
    const body = text(input?.text, '摘要', MAX_TEXT)
    return this.exclusive(async () => {
      const file = path.join(this.summaryDir, answerId + '.json')
      const existing = await readRecord<{ text: string }>(file)
      if (existing) return existing.text
      await writeRecord(file, { version: 1, answerId, text: body, model: input.model, createdAt: Date.now() })
      return body
    })
  }

  // ---- Drafts ----

  private draftFile = (id: string) => path.join(this.drafts, id + '.json')

  async getDraft(id: string): Promise<DraftDTO> { return stripVersion(await this.read<DraftDTO & { version: 1 }>(this.drafts, id, '草稿')) }

  async listDrafts(discussionId?: string | null): Promise<DraftDTO[]> {
    const all = (await this.list<DraftDTO & { version: 1 }>(this.drafts, '草稿')).map(stripVersion)
    return all.filter(draft => discussionId === undefined || draft.discussionId === discussionId).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  private async items(value: unknown): Promise<DraftItemDTO[]> {
    if (!Array.isArray(value) || value.length > MAX_ITEMS) throw new BadNameError('问题列表无效。')
    const seen = new Set<string>()
    const result: DraftItemDTO[] = []
    for (const item of value as Partial<DraftItemDTO>[]) {
      const id = item?.id ?? randomUUID()
      if (typeof id !== 'string' || !/^[\w-]{1,64}$/.test(id) || seen.has(id)) throw new BadNameError('问题编号无效。')
      seen.add(id)
      const sourceIds = ids(item.sourceIds ?? [], '来源')
      for (const source of sourceIds) await this.getSource(source)
      result.push({ id, question: text(item.question ?? '', '问题', MAX_QUESTION, true), sourceIds })
    }
    return result
  }

  async createDraft(input: { id?: string; title?: string; discussionId?: string | null; parentIds?: string[]; origin?: Origin; items?: Partial<DraftItemDTO>[] } = {}): Promise<DraftDTO> {
    return this.exclusive(async () => {
      const id = input.id ?? randomUUID()
      if (!ID.test(id)) throw new BadNameError('草稿编号无效。')
      const existing = await readRecord<DraftDTO>(this.draftFile(id))
      if (existing) return this.getDraft(id)
      const discussion = input.discussionId ? await this.getDiscussion(input.discussionId) : null
      const parentIds = ids(input.parentIds ?? [], '父节点')
      if (!discussion && parentIds.length) throw new BadNameError('新讨论的草稿不能指定父节点。')
      for (const parent of parentIds) if (!discussion!.turns.some(turn => turn.id === parent)) throw new BadNameError('父节点不在这段讨论中。')
      const origin = input.origin ?? discussion?.origin ?? { kind: 'chat' as const }
      if (!validOrigin(origin)) throw new BadNameError('讨论入口无效。')
      const now = Date.now()
      const draft: DraftDTO = { id, title: text(input.title ?? '', '标题', 200, true), discussionId: discussion?.id ?? null, parentIds, origin, items: await this.items(input.items ?? []), revision: 1, createdAt: now, updatedAt: now }
      await writeRecord(this.draftFile(id), { version: 1, ...draft })
      return draft
    })
  }

  private async saveDraft(draft: DraftDTO, expected: number): Promise<DraftDTO> {
    const current = await readRecord<DraftDTO>(this.draftFile(draft.id))
    if (!current || current.revision !== expected) throw new ConflictError('草稿已在另一处更新，未覆盖较新的内容。请重新载入后再编辑。')
    const next = { ...draft, revision: expected + 1, updatedAt: Date.now() }
    await writeRecord(this.draftFile(draft.id), { version: 1, ...next })
    return next
  }

  /** Compare-and-swap on the revision the editor last saw; a stale tab cannot overwrite newer text. */
  async updateDraft(id: string, revision: number, patch: { title?: string; parentIds?: string[]; items?: Partial<DraftItemDTO>[] }): Promise<DraftDTO> {
    return this.exclusive(async () => {
      const draft = await this.getDraft(id)
      if (draft.revision !== revision) throw new ConflictError('草稿已在另一处更新，未覆盖较新的内容。请重新载入后再编辑。')
      if (patch.title !== undefined) draft.title = text(patch.title, '标题', 200, true)
      if (patch.items !== undefined) draft.items = await this.items(patch.items)
      if (patch.parentIds !== undefined) {
        const parentIds = ids(patch.parentIds, '父节点')
        if (!draft.discussionId && parentIds.length) throw new BadNameError('新讨论的草稿不能指定父节点。')
        if (draft.discussionId) {
          const discussion = await this.getDiscussion(draft.discussionId)
          for (const parent of parentIds) if (!discussion.turns.some(turn => turn.id === parent)) throw new BadNameError('父节点不在这段讨论中。')
        }
        draft.parentIds = parentIds
      }
      return this.saveDraft(draft, revision)
    })
  }

  async deleteDraft(id: string, revision: number): Promise<void> {
    await this.exclusive(async () => {
      const draft = await this.getDraft(id)
      if (draft.revision !== revision) throw new ConflictError('草稿已在另一处更新，未删除较新的内容。')
      await fs.rm(this.draftFile(id))
    })
  }

  /**
   * Sends questions exactly as the client displayed them. Each (draft, item, text) maps to one turn forever,
   * so a lost response is retried safely. An item leaves the draft only if its text is still the text
   * that was sent; anything typed meanwhile stays.
   */
  async sendDraft(id: string, sent: { id: string; question: string }[]): Promise<{ discussion: DiscussionDTO; turns: TurnDTO[]; draft: DraftDTO }> {
    if (!Array.isArray(sent) || !sent.length || sent.length > MAX_ITEMS) throw new BadNameError('请选择要发送的问题。')
    const questions = sent.map(item => ({ id: item?.id, question: text(item?.question, '问题', MAX_QUESTION) }))
    if (new Set(questions.map(item => item.id)).size !== questions.length) throw new BadNameError('问题重复。')
    return this.exclusive(async () => {
      let draft = await this.getDraft(id)
      const discussionId = draft.discussionId ?? derive('draft-discussion', draft.id)
      // A previous attempt may have created the discussion before stopping; look before validating, write only after.
      let discussion = await this.getDiscussion(discussionId).catch(error => { if (error instanceof MissingRecordError && draft.discussionId === null) return null; throw error })
      for (const { id: itemId, question } of questions) {
        if (!draft.items.some(candidate => candidate.id === itemId) && !discussion?.turns.some(turn => turn.requestKey === requestKeyOf(draft.id, itemId, question))) throw new BadNameError('草稿中没有这个问题。')
      }
      const title = draft.title.trim() || questions[0]!.question.trim().slice(0, 60)
      if (!discussion) discussion = await this.createDiscussion({ id: discussionId, title, origin: draft.origin })
      if (draft.discussionId === null) draft = await this.saveDraft({ ...draft, discussionId }, draft.revision)
      const turns: TurnDTO[] = []
      for (const { id: itemId, question } of questions) {
        const requestKey = requestKeyOf(draft.id, itemId, question)
        const item = draft.items.find(candidate => candidate.id === itemId)
        const prior = discussion.turns.find(turn => turn.requestKey === requestKey)
        turns.push(await this.addTurn(discussionId, { parents: prior?.parents ?? draft.parentIds, question, sourceIds: prior?.sourceIds ?? item!.sourceIds, requestKey }))
        discussion = await this.getDiscussion(discussionId)
      }
      const sentText = new Map(questions.map(item => [item.id, item.question]))
      const remaining = draft.items.filter(item => sentText.get(item.id) !== item.question)
      if (remaining.length !== draft.items.length) draft = await this.saveDraft({ ...draft, items: remaining }, draft.revision)
      return { discussion, turns, draft }
    })
  }

  /** One discussion with the captures that cite it and the sources its questions rest on. */
  async viewDiscussion(id: string): Promise<{ discussion: DiscussionDTO; captures: CaptureDTO[]; sources: Record<string, SourceRefDTO> }> {
    return this.exclusive(async () => {
      const discussion = await this.getDiscussion(id)
      const captures = (await this.listCaptures()).filter(capture => capture.answers.some(answer => answer.discussionId === id))
      const sources: Record<string, SourceRefDTO> = {}
      for (const sourceId of new Set(discussion.turns.flatMap(turn => turn.sourceIds))) sources[sourceId] = await this.getSource(sourceId)
      return { discussion, captures, sources }
    })
  }

  /** The conversation list: one row per discussion, with where it started and what was last asked. */
  async summaries(options: { archived?: boolean } = {}): Promise<DiscussionSummaryDTO[]> {
    return this.exclusive(async () => {
      const paths = (await this.store.identities()).paths
      const all = await this.list<DiscussionDTO & { version: 1 }>(this.discussions, '讨论')
      return all.filter(item => options.archived === undefined || item.archived === options.archived).sort((a, b) => b.updatedAt - a.updatedAt).map(({ turns, version, ...rest }) => ({
        ...rest, turnCount: turns.length, lastQuestion: turns.reduce((latest, turn) => !latest || turn.createdAt >= latest.createdAt ? turn : latest, undefined as TurnDTO | undefined)?.question ?? '',
        notePath: rest.origin.kind === 'note' ? paths[rest.origin.noteId] ?? null : null,
      }))
    })
  }

  /** Everything started from one note: its discussions, unsent drafts, saved captures and the sources they cite. */
  async forNote(name: string): Promise<{ noteId: string; discussions: DiscussionDTO[]; drafts: DraftDTO[]; captures: CaptureDTO[]; sources: Record<string, SourceRefDTO> }> {
    return this.exclusive(async () => {
      const { id: noteId } = await this.store.identity(name)
      const fromNote = (origin: Origin) => origin.kind === 'note' && origin.noteId === noteId
      const discussions: DiscussionDTO[] = []
      for (const item of await this.list<DiscussionDTO & { version: 1 }>(this.discussions, '讨论')) {
        if (!item.archived && fromNote(item.origin)) discussions.push(await this.getDiscussion(item.id))
      }
      discussions.sort((a, b) => b.updatedAt - a.updatedAt)
      const drafts = (await this.listDrafts()).filter(draft => fromNote(draft.origin) && draft.items.length)
      const captures = await this.listCaptures(noteId)
      const sources: Record<string, SourceRefDTO> = {}
      const ids = new Set([...discussions.flatMap(d => d.turns.flatMap(t => t.sourceIds)), ...drafts.flatMap(d => d.items.flatMap(i => i.sourceIds))])
      for (const id of ids) sources[id] = await this.getSource(id)
      return { noteId, discussions, drafts, captures, sources }
    })
  }

  // ---- Captures ----

  async getCapture(id: string): Promise<CaptureDTO> { return stripVersion(await this.read<CaptureDTO & { version: 1 }>(this.captures, id, '保存记录')) }

  async listCaptures(noteId?: string): Promise<CaptureDTO[]> {
    return (await this.list<CaptureDTO & { version: 1 }>(this.captures, '保存记录')).map(stripVersion)
      .filter(capture => !noteId || capture.target.noteId === noteId).sort((a, b) => b.createdAt - a.createdAt)
  }

  /**
   * Records that specific answer versions were written into a note. Answer text is copied into the record,
   * so the evidence survives a retry, a deleted discussion or a Git-only clone. Repeating a `requestKey`
   * returns the first record.
   */
  async recordCapture(input: { requestKey: string; mode: CaptureDTO['mode']; target: CaptureDTO['target']; answers: { discussionId: string; turnId: string; answerId: string }[]; sourceIds?: string[]; changeSetId?: string; writtenText?: string }): Promise<CaptureDTO> {
    const requestKey = text(input?.requestKey, '请求键', 200)
    if (input.mode !== 'verbatim' && input.mode !== 'organized') throw new BadNameError('保存方式无效。')
    if ((input.mode === 'organized') !== (input.writtenText !== undefined) || (input.writtenText !== undefined && (typeof input.writtenText !== 'string' || !input.writtenText.trim() || input.writtenText.length > MAX_TEXT))) throw new BadNameError('整理后保存必须记录写入的文字。')
    const target = input.target
    if (!target || !['new', 'append', 'replace'].includes(target.kind) || !ID.test(target.noteId ?? '') || typeof target.notePath !== 'string' || !/^[a-f0-9]{64}$/.test(target.afterVersion ?? '') ||
      (target.beforeVersion !== null && !/^[a-f0-9]{64}$/.test(target.beforeVersion ?? '')) || (target.kind === 'new') !== (target.beforeVersion === null)) throw new BadNameError('保存目标无效。')
    if (!Array.isArray(input.answers) || !input.answers.length || input.answers.length > MAX_ITEMS) throw new BadNameError('请选择要保存的回答。')
    const id = derive('capture', requestKey)
    return this.exclusive(async () => {
      if ((await this.store.identities()).paths[target.noteId] === undefined) throw new MissingRecordError('找不到目标笔记。')
      const answers: CaptureDTO['answers'] = [], sourceIds = new Set(ids(input.sourceIds ?? [], '来源'))
      for (const ref of input.answers) {
        const discussion = await this.getDiscussion(ref?.discussionId)
        const turn = discussion.turns.find(item => item.id === ref.turnId), answer = turn?.answers.find(item => item.id === ref.answerId)
        if (!turn || !answer) throw new MissingRecordError('找不到要保存的回答版本。')
        answers.push({ discussionId: discussion.id, turnId: turn.id, answerId: answer.id, text: answer.text })
        for (const source of turn.sourceIds) sourceIds.add(source)
      }
      for (const source of sourceIds) await this.getSource(source)
      const capture: CaptureDTO = { id, requestKey, mode: input.mode, target: { ...target }, answers, sourceIds: [...sourceIds].sort(), ...(input.writtenText !== undefined ? { writtenText: input.writtenText } : {}), ...(input.changeSetId ? { changeSetId: input.changeSetId } : {}), createdAt: Date.now() }
      const existing = await readRecord<CaptureDTO & { version: 1 }>(path.join(this.captures, id + '.json'))
      if (existing) {
        const { createdAt, version, ...old } = existing, { createdAt: _, ...fresh } = capture
        if (!isDeepStrictEqual(old, fresh)) throw new ConflictError('同一请求键不能用于不同的保存内容。')
        return stripVersion(existing)
      }
      await writeRecord(path.join(this.captures, id + '.json'), { version: 1, ...capture })
      return capture
    })
  }
}

const requestKeyOf = (draftId: string, itemId: string, question: string) => 'draft:' + draftId + ':' + itemId + ':' + derive(question)

function stripVersion<T extends { version?: number }>(record: T): Omit<T, 'version'> {
  const { version, ...rest } = record
  return rest
}

/**
 * Finds `quote` in the raw Markdown. Exact matches win; otherwise both sides are compared in their projected form
 * (see shared/projection) and each match is mapped back to the raw range it covers.
 */
export function locate(content: string, quote: string): { start: number; end: number }[] {
  const exact = occurrences(content, quote)
  if (exact.length) return exact.map(start => ({ start, end: start + quote.length }))
  const trimmed = quote.trim()
  if (trimmed && trimmed !== quote) { const found = occurrences(content, trimmed); if (found.length) return found.map(start => ({ start, end: start + trimmed.length })) }
  const wanted = project(quote).text
  if (wanted.length < 2) return []
  const note = project(content)
  return occurrences(note.text, wanted).map(at => {
    const last = note.origin[at + wanted.length - 1]!
    let start = note.origin[at]!, end = last + String.fromCodePoint(content.codePointAt(last)!).length
    // Keep the emphasis markers hugging the match so the saved quote does not start or end with half a pair.
    while (start > 0 && /[*_`]/.test(content[start - 1]!)) start--
    while (end < content.length && /[*_`]/.test(content[end]!)) end++
    return { start, end }
  })
}

function occurrences(content: string, quote: string): number[] {
  const found: number[] = []
  for (let at = content.indexOf(quote); at !== -1; at = content.indexOf(quote, at + 1)) found.push(at)
  return found
}

/** Nearest ATX heading above the offset, to help a reader find the passage again. */
function sectionBefore(content: string, offset: number): string {
  let heading = ''
  for (const match of content.slice(0, offset).matchAll(/^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm)) heading = match[1]!.trim()
  return heading.slice(0, 200)
}
