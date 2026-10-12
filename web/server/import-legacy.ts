import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AnswerVersionDTO, DiscussionDTO, TurnDTO } from '../shared/types'
import type { Conversation } from './conversations'
import { ancestry, ResearchStore, validateTurns } from './discussions'
import { batchFile, readBatch, type Batch, type Issue, type Severity } from './import-chatgit'
import { writeRecord } from './persistence'
import type { DataPaths } from './repo'
import { BadNameError, contentVersion, type NoteStore } from './store'

/**
 * Old Canvas Note history → Chat. The old Note Agent kept each conversation as a linear record under `local/conversations`
 * (copied from `cache/` on upgrade); this maps every readable one onto a linear discussion so it can be found, read and
 * written into notes from Chat. The original records are never touched: changes, proposals and the Agent panel keep
 * using them. The result is read-only history: a question-and-answer discussion cannot continue an Agent conversation
 * (it would lose the tools and the changes the Agent made), and nothing here claims an undo that the records do not support.
 */

const LIMITS = { question: 20000, answer: 100000, title: 200 }
const derive = (...parts: (string | number)[]) => contentVersion(parts.join('\0')).slice(0, 32)
const json = (file: string) => fs.readFile(file, 'utf8')

export interface LegacyConversation { id: string; scope: Conversation['scope']; turns: number; status: 'importable' | 'skipped'; reason?: string }
export interface LegacyReport {
  digest: string
  counts: { conversations: number; readable: number; changesets: number; proposals: number; legacyAgentChanges: number; transcriptTurns: number }
  conversations: LegacyConversation[]
  issues: Issue[]
}

interface Readable { conversation: Conversation; text: string }

async function listJson(directory: string): Promise<string[]> {
  try { return (await fs.readdir(directory)).filter(name => /\.json$/.test(name)).sort() }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
}

/** Reads every old record one by one: an unreadable file is reported by name and skipped, never fatal for the rest. */
async function scan(paths: DataPaths) {
  const issues: Issue[] = []
  const add = (severity: Severity, code: string, where: string, message: string) => issues.push({ severity, code, where, message })
  const readable: Readable[] = []
  const conversationFiles = await listJson(path.join(paths.local, 'conversations'))
  for (const name of conversationFiles) {
    const where = 'conversations/' + name
    let text: string, parsed: unknown
    try { text = await json(path.join(paths.local, 'conversations', name)); parsed = JSON.parse(text) }
    catch { add('error', 'conversation-corrupt', where, '文件无法解析为 JSON，已跳过；原文件保持不动，请从备份检查。'); continue }
    const c = parsed as Partial<Conversation>
    if (!c || c.version !== 1 || typeof c.id !== 'string' || c.id !== name.slice(0, -5) || !Array.isArray(c.transcript) || !c.scope || typeof c.scope !== 'object') { add('error', 'conversation-format', where, '记录格式不是已知的旧对话（版本、编号或 transcript 不符），已跳过；原文件保持不动。'); continue }
    readable.push({ conversation: c as Conversation, text })
  }
  if (!conversationFiles.length) add('info', 'no-conversations', 'local/conversations', '没有找到旧对话记录（目录不存在或为空）。')
  const ids = new Set(readable.map(item => item.conversation.id))
  const changesets = new Map<string, { conversation?: string } | null>()
  for (const name of await listJson(path.join(paths.local, 'changesets'))) {
    try { changesets.set(name.slice(0, -5), JSON.parse(await json(path.join(paths.local, 'changesets', name)))) }
    catch { changesets.set(name.slice(0, -5), null); add('warning', 'changeset-corrupt', 'changesets/' + name, '修改记录无法解析：对应的撤销能力不可用；原文件保持不动。') }
  }
  for (const [id, set] of changesets) if (set && !(set.conversation && ids.has(set.conversation))) add('info', 'change-unlinked', 'changesets/' + id + '.json', '这条修改记录没有关联到任何可读的旧对话：保留原始记录，作为历史只读，不编造来源，也不声称可以撤销。')
  for (const { conversation } of readable) for (const id of conversation.changesets ?? []) if (!changesets.has(id)) add('warning', 'change-missing', 'conversations/' + conversation.id + '.json', `对话引用的修改记录 ${id} 不存在（可能已被清理）；对应的撤销能力不可用。`)
  let proposals = 0
  for (const name of await listJson(path.join(paths.local, 'proposals'))) {
    proposals++
    try { const proposal = JSON.parse(await json(path.join(paths.local, 'proposals', name))) as { conversation?: string }; if (proposal.conversation && !ids.has(proposal.conversation)) add('info', 'proposal-unlinked', 'proposals/' + name, '这条提案所属的对话不在可读记录里：保留原始记录。') }
    catch { add('warning', 'proposal-corrupt', 'proposals/' + name, '提案记录无法解析；原文件保持不动。') }
  }
  let legacyAgentChanges = 0
  try { legacyAgentChanges = (await fs.readdir(path.join(paths.cache, 'legacy-agent-changes'))).length } catch { /* none */ }
  if (legacyAgentChanges) add('info', 'legacy-agent-changes-kept', 'cache/legacy-agent-changes', `v0.2 时代的 ${legacyAgentChanges} 条改动记录原样保留，不被解释，也不提供撤销。`)
  return { issues, readable, counts: { changesets: changesets.size, proposals, legacyAgentChanges } }
}

/** Groups a transcript into question/answer pairs: a user line starts a turn, following assistant lines are its answer. */
function pairs(conversation: Conversation, add: (severity: Severity, code: string, where: string, message: string) => void) {
  const turns: { question: string; answer: string[]; at: number; answeredAt: number }[] = []
  for (const entry of conversation.transcript) {
    const text = typeof entry.text === 'string' ? entry.text : ''
    if (entry.role === 'user') turns.push({ question: text.trim() || '（空消息）', answer: [], at: Number(entry.at) || conversation.createdAt, answeredAt: Number(entry.at) || conversation.createdAt })
    else if (entry.role === 'assistant') {
      const current = turns.at(-1)
      if (!current) { add('warning', 'leading-assistant', 'conversations/' + conversation.id + '.json', '对话开头有助手消息、前面没有提问：不导入这几行（原记录保留）。'); continue }
      if (text.trim()) { current.answer.push(text.trim()); current.answeredAt = Number(entry.at) || current.answeredAt }
    }
  }
  return turns
}

export async function legacyPreflight(paths: DataPaths): Promise<LegacyReport> {
  const { issues, readable, counts } = await scan(paths)
  const conversations: LegacyConversation[] = []
  let transcriptTurns = 0
  for (const { conversation } of readable) {
    const turns = pairs(conversation, (severity, code, where, message) => issues.push({ severity, code, where, message }))
    transcriptTurns += turns.length
    const tooLong = turns.find(turn => turn.question.length > LIMITS.question || turn.answer.join('\n\n').length > LIMITS.answer)
    const skip = tooLong ? '有一条消息超过可导入的长度上限。' : !turns.length ? '没有可导入的问答。' : undefined
    conversations.push({ id: conversation.id, scope: conversation.scope, turns: turns.length, status: skip ? 'skipped' : 'importable', ...(skip ? { reason: skip } : {}) })
    if (conversation.scope.kind === 'note') {
      try { await fs.access(path.join(paths.notes, conversation.scope.name)) }
      catch { issues.push({ severity: 'info', code: 'note-gone', where: 'conversations/' + conversation.id + '.json', message: `对话所属的笔记「${conversation.scope.name}」已不存在或改名；导入后不再挂在那篇笔记名下，作为普通对话列出。` }) }
    }
  }
  const digest = contentVersion(readable.map(item => item.conversation.id + ':' + createHash('sha256').update(item.text).digest('hex')).join('\0'))
  return { digest, counts: { conversations: (await listJson(path.join(paths.local, 'conversations'))).length, readable: readable.length, ...counts, transcriptTurns }, conversations, issues }
}

async function build(store: NoteStore, conversation: Conversation, batch: string): Promise<{ discussion: DiscussionDTO; answers: number } | { skip: string }> {
  const discussionId = derive('legacy-discussion', conversation.id)
  const sink = () => {}
  const grouped = pairs(conversation, sink)
  if (!grouped.length) return { skip: '没有可导入的问答。' }
  if (grouped.some(turn => turn.question.length > LIMITS.question || turn.answer.join('\n\n').length > LIMITS.answer)) return { skip: '有一条消息超过可导入的长度上限。' }
  const turns: TurnDTO[] = []
  let answers = 0
  grouped.forEach((entry, index) => {
    const answerText = entry.answer.join('\n\n')
    const list: AnswerVersionDTO[] = answerText ? [{ id: derive('legacy-answer', discussionId, index), text: answerText, createdAt: entry.answeredAt, runId: 'legacy:' + index }] : []
    answers += list.length
    turns.push({ id: derive('legacy-turn', discussionId, index), parents: index ? [turns[index - 1]!.id] : [], question: entry.question, sourceIds: [], requestKey: 'legacy:' + index, answers: list, createdAt: entry.at })
  })
  for (const turn of turns) if (turn.parents.length) {
    const frozen: Record<string, string> = {}
    for (const ancestor of ancestry(turns, turn.parents)) { const answer = ancestor.answers.at(-1); if (answer) frozen[ancestor.id] = answer.id }
    turn.frozen = frozen
  }
  validateTurns(turns)
  let origin: DiscussionDTO['origin'] = { kind: 'chat' }
  if (conversation.scope.kind === 'note') { try { origin = { kind: 'note', noteId: (await store.identity(conversation.scope.name)).id } } catch { /* the note is gone: a plain chat */ } }
  const title = (turns[0]?.question.split('\n')[0]!.slice(0, 60) || '旧助手对话').slice(0, LIMITS.title)
  const times = [conversation.updatedAt, ...turns.flatMap(turn => [turn.createdAt, ...turn.answers.map(answer => answer.createdAt)])].filter(Number.isFinite)
  return { answers, discussion: { id: discussionId, title, origin, revision: 1, archived: false, turns, imported: { source: 'canvas-conversation', canvasId: conversation.id, batch, readOnly: true }, createdAt: conversation.createdAt, updatedAt: Math.max(conversation.createdAt, ...times) } }
}

export interface LegacyItem { id: string; discussionId: string; result: 'created' | 'identical' | 'conflict' | 'skipped'; turns: number; answers: number; reason?: string }
export interface LegacyResult { batch: string; resumed: boolean; items: LegacyItem[]; issues: Issue[]; totals: { created: number; identical: number; conflict: number; skipped: number } }

/** Maps every readable old conversation to a read-only linear discussion. Idempotent and resumable like the ChatGit import. */
export async function importLegacyConversations(store: NoteStore, research: ResearchStore): Promise<LegacyResult> {
  const report = await legacyPreflight(store.paths)
  const { readable } = await scan(store.paths)
  const id = 'legacy-' + report.digest.slice(0, 16)
  const previous = await readBatch(store, id)
  if (previous?.state === 'rolled-back') throw new BadNameError('这批旧对话已经回退过。如需再次导入，请先确认回退归档里的内容。')
  const batch: Batch = previous ?? { version: 1, id, source: 'canvas-conversation', digest: report.digest, state: 'importing', startedAt: Date.now(), files: [], discussions: [], drafts: [], runs: [], answers: [], skipped: [], attachments: [] }
  batch.state = 'importing'
  await writeRecord(batchFile(store, id), batch)
  const items: LegacyItem[] = []
  const totals = { created: 0, identical: 0, conflict: 0, skipped: 0 }
  for (const { conversation } of readable) {
    const discussionId = derive('legacy-discussion', conversation.id)
    const built = await build(store, conversation, id)
    if ('skip' in built) {
      totals.skipped++; items.push({ id: conversation.id, discussionId, result: 'skipped', turns: 0, answers: 0, reason: built.skip })
      if (!batch.skipped.some(entry => entry.canvasId === conversation.id)) batch.skipped.push({ canvasId: conversation.id, reason: built.skip })
      continue
    }
    const result = await research.importDiscussion(built.discussion)
    const mine = result === 'created' || (result === 'identical' && (await research.getDiscussion(discussionId)).imported?.batch === id)
    if (mine) {
      if (!batch.discussions.includes(discussionId)) batch.discussions.push(discussionId)
      for (const turn of built.discussion.turns) for (const answer of turn.answers) if (!batch.answers.includes(answer.id)) batch.answers.push(answer.id)
    }
    totals[result]++
    items.push({ id: conversation.id, discussionId, result, turns: built.discussion.turns.length, answers: built.answers, ...(result === 'conflict' ? { reason: '这个编号下已经有内容不同的讨论，未覆盖。' } : {}) })
    await writeRecord(batchFile(store, id), batch)
  }
  batch.state = 'completed'; batch.completedAt = Date.now()
  await writeRecord(batchFile(store, id), batch)
  return { batch: id, resumed: !!previous, items, issues: report.issues, totals }
}

export interface LegacyVerification { batch: string; ok: boolean; checked: { conversations: number; turns: number; answers: number }; mismatches: { where: string; message: string }[] }

/** Compares every readable old conversation with its discussion: turn count, order, and question/answer text checksums. */
export async function verifyLegacyImport(store: NoteStore, research: ResearchStore): Promise<LegacyVerification> {
  const report = await legacyPreflight(store.paths)
  const { readable } = await scan(store.paths)
  const id = 'legacy-' + report.digest.slice(0, 16)
  const mismatches: LegacyVerification['mismatches'] = []
  const checked = { conversations: 0, turns: 0, answers: 0 }
  const sum = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16)
  const batch = await readBatch(store, id)
  if (!batch || batch.state !== 'completed') mismatches.push({ where: id, message: batch ? '导入批次没有完成。' : '没有找到这批旧对话的导入批次。' })
  for (const { conversation } of readable) {
    const built = await build(store, conversation, id)
    if ('skip' in built) continue
    let stored: DiscussionDTO
    try { stored = await research.getDiscussion(built.discussion.id) } catch { mismatches.push({ where: conversation.id, message: '讨论不存在。' }); continue }
    checked.conversations++
    if (!stored.imported?.readOnly || stored.imported.canvasId !== conversation.id) mismatches.push({ where: conversation.id, message: '讨论不是由这段旧对话导入的只读历史。' })
    if (stored.turns.length !== built.discussion.turns.length) mismatches.push({ where: conversation.id, message: `问题数不一致：旧对话 ${built.discussion.turns.length}，现有 ${stored.turns.length}。` })
    built.discussion.turns.forEach((want, index) => {
      const got = stored.turns[index]
      if (!got) return
      checked.turns++; checked.answers += want.answers.length
      if (sum(got.question) !== sum(want.question)) mismatches.push({ where: `${conversation.id}#${index}`, message: '问题文字的校验值不一致。' })
      if (got.answers.length !== want.answers.length || got.answers.some((answer, n) => sum(answer.text) !== sum(want.answers[n]!.text))) mismatches.push({ where: `${conversation.id}#${index}`, message: '回答的数量或校验值不一致。' })
      if (index && got.parents[0] !== stored.turns[index - 1]!.id) mismatches.push({ where: `${conversation.id}#${index}`, message: '不是线性顺序。' })
    })
  }
  return { batch: id, ok: mismatches.length === 0, checked, mismatches }
}
