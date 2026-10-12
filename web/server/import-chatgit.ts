import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AnswerVersionDTO, DiscussionDTO, DraftDTO, RunDTO, TurnDTO } from '../shared/types'
import { ancestry, ResearchStore, validateTurns } from './discussions'
import { readRecord, StorageError, writeRecord } from './persistence'
import { BadNameError, contentVersion, type NoteStore } from './store'

/**
 * Import of ChatGit's own canvas data (`chatgit_canvases` / `chatgit_nodes`), read from a `mongoexport` copy.
 * Nothing here talks to ChatGit, a database or a model; it never reads credentials, tokens or the `user` field.
 *
 * - A canvas becomes one discussion; a node becomes one question (and, when finished, one answer version).
 * - Ids are derived from the source ids, so importing the same export twice cannot create a second copy.
 * - A node that was still generating, failed or was stopped is imported as an unfinished run (partial text kept),
 *   never as an answer, and nothing is regenerated.
 * - What has no home in Canvas Note (attachment files, suggested follow-ups, model/endpoint choice, UI state) is
 *   counted and reported, not silently dropped and not pretended to be migrated.
 */

export type Severity = 'error' | 'warning' | 'info'
export interface Issue { severity: Severity; code: string; where: string; message: string }
export interface CanvasPlan { canvasId: string; name: string; discussionId: string; status: 'importable' | 'skipped'; nodes: number; drafts: number; reason?: string }
export interface Preflight {
  format: 'chatgit-export'
  files: { name: string; bytes: number; sha256: string }[]
  /** Identifies this exact export; the import batch is derived from it. */
  digest: string
  counts: { canvases: number; nodes: number; drafts: number; draftItems: number; byStatus: Record<string, number>; withSummary: number; withFiles: number; withSuggestions: number }
  canvases: CanvasPlan[]
  issues: Issue[]
  /** False only when the export itself cannot be read; individual canvases may still be skipped (see `canvases`). */
  readable: boolean
}

type Raw = Record<string, unknown>
interface Node { id: string; canvas: string; parentIds: string[]; items: { quote: string; q: string; source: string }[]; question: string; files: { file_id?: string; filename?: string; text?: string }[]; status: string; answer: string; error: string; endpoint?: string; model?: string; summary: string; suggestions: string[]; createdAt: number | null; updatedAt: number | null }
interface DraftItem { quote: string; q: string; source: string }
interface Canvas { id: string; name: string; endpoint: string; model: string; drafts: { id: string; letter: string; name: string; items: DraftItem[] }[]; createdAt: number | null; updatedAt: number | null }

const EXPLAIN = '请解释这段内容。'
const LIMITS = { question: 20000, answer: 100000, title: 200 }
const derive = (...parts: (string | number)[]) => contentVersion(parts.join('\0')).slice(0, 32)
const str = (value: unknown): string => typeof value === 'string' ? value : ''
const oid = (value: unknown): string | null => typeof value === 'string' && value ? value : value && typeof value === 'object' && typeof (value as Raw).$oid === 'string' ? (value as Raw).$oid as string : null
const when = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') { const t = Date.parse(value); return Number.isNaN(t) ? null : t }
  if (value && typeof value === 'object' && '$date' in (value as Raw)) {
    const inner = (value as Raw).$date
    if (inner && typeof inner === 'object' && typeof (inner as Raw).$numberLong === 'string') return Number((inner as Raw).$numberLong)
    return when(inner)
  }
  return null
}

async function readCollection(dir: string, base: string): Promise<{ name: string; bytes: number; sha256: string; docs: Raw[] } | null> {
  for (const name of [base + '.json', base + '.jsonl']) {
    let text: string
    try { text = await fs.readFile(path.join(dir, name), 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
    const trimmed = text.trim()
    let docs: unknown[]
    try { docs = trimmed.startsWith('[') ? JSON.parse(trimmed) : trimmed.split('\n').filter(line => line.trim()).map(line => JSON.parse(line)) }
    catch { throw new BadNameError(`「${name}」不是有效的 JSON（需要 mongoexport 的 --jsonArray 或每行一个文档的格式）。`) }
    if (!Array.isArray(docs) || docs.some(doc => !doc || typeof doc !== 'object' || Array.isArray(doc))) throw new BadNameError(`「${name}」里应当是文档对象的列表。`)
    return { name, bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex'), docs: docs as Raw[] }
  }
  return null
}

export interface ReadExport { canvases: Canvas[]; nodes: Node[]; files: Preflight['files']; issues: Issue[] }

/** Reads and normalizes an export directory. Format problems per document become issues; an unreadable file throws. */
export async function readExport(dir: string): Promise<ReadExport> {
  const [canvasFile, nodeFile] = [await readCollection(dir, 'chatgit_canvases'), await readCollection(dir, 'chatgit_nodes')]
  if (!canvasFile || !nodeFile) throw new BadNameError(`在「${dir}」里找不到 chatgit_canvases.json 和 chatgit_nodes.json。请用 mongoexport 从 ChatGit 的 MongoDB 导出这两个集合。`)
  const issues: Issue[] = []
  const canvases: Canvas[] = []
  for (const [index, doc] of canvasFile.docs.entries()) {
    const id = oid(doc._id)
    if (!id) { issues.push({ severity: 'error', code: 'canvas-no-id', where: `${canvasFile.name}[${index}]`, message: '画布缺少 _id，无法建立来源映射，已跳过。' }); continue }
    const drafts = Array.isArray(doc.drafts) ? (doc.drafts as Raw[]).map(draft => ({
      id: str(draft.id) || 'draft', letter: str(draft.letter), name: str(draft.name),
      items: Array.isArray(draft.items) ? (draft.items as Raw[]).map(item => ({ quote: str(item.quote), q: str(item.q), source: str(item.source) })) : [],
    })) : []
    canvases.push({ id, name: str(doc.name), endpoint: str(doc.endpoint), model: str(doc.model), drafts, createdAt: when(doc.createdAt), updatedAt: when(doc.updatedAt) })
  }
  const nodes: Node[] = []
  for (const [index, doc] of nodeFile.docs.entries()) {
    const id = str(doc.nodeId)
    if (!id) { issues.push({ severity: 'error', code: 'node-no-id', where: `${nodeFile.name}[${index}]`, message: '节点缺少 nodeId，已跳过。' }); continue }
    nodes.push({
      id, canvas: oid(doc.canvas) ?? str(doc.canvas), parentIds: Array.isArray(doc.parentIds) ? (doc.parentIds as unknown[]).filter((p): p is string => typeof p === 'string') : [],
      items: Array.isArray(doc.items) ? (doc.items as Raw[]).map(item => ({ quote: str(item.quote), q: str(item.q), source: str(item.source) })) : [],
      question: str(doc.question), files: Array.isArray(doc.files) ? (doc.files as Raw[]).map(file => ({ file_id: str(file.file_id) || undefined, filename: str(file.filename) || undefined, text: str(file.text) || undefined })) : [],
      status: str(doc.status) || 'done', answer: str(doc.answer), error: str(doc.error), endpoint: str(doc.endpoint) || undefined, model: str(doc.model) || undefined,
      summary: str(doc.summary), suggestions: Array.isArray(doc.suggestions) ? (doc.suggestions as unknown[]).filter((s): s is string => typeof s === 'string') : [],
      createdAt: when(doc.createdAt), updatedAt: when(doc.updatedAt),
    })
  }
  const files = [canvasFile, nodeFile].map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 }))
  return { canvases, nodes, files, issues }
}

/** ChatGit stores a short error code on a failed node; say what it means, as ChatGit's own interface does. */
const errorText = (code: string): string => ({
  no_user_key: '还没有填写这个模型连接的 API Key。', NO_USER_KEY: '还没有填写这个模型连接的 API Key。', no_base_url: '还没有填写这个模型连接的服务地址。', NO_BASE_URL: '还没有填写这个模型连接的服务地址。',
  auth: '模型服务拒绝了凭据。', rate_limit: '模型服务限流或额度不足。', network: '连不上模型服务。', interrupted: '源系统重启，生成被中断。', provider: '模型服务返回错误。',
} as Record<string, string>)[code] ?? '模型服务返回错误（' + code + '）。'

const questionOf = (node: Node) => {
  const lines = node.items.map(item => `「${item.quote}」${item.q.trim() || EXPLAIN}`)
  if (node.question.trim()) lines.push(node.question.trim())
  return lines.join('\n') || '（导入的空问题）'
}
const draftQuestion = (item: DraftItem) => `「${item.quote}」${item.q.trim() || EXPLAIN}`

interface Planned { canvas: Canvas; discussionId: string; nodes: Node[]; skip?: string; issues: Issue[] }

/** Splits an export into per-canvas plans and records everything that will be lost, changed or skipped. */
function plan(read: ReadExport): { planned: Planned[]; issues: Issue[]; counts: Preflight['counts'] } {
  const issues = [...read.issues]
  const byCanvas = new Map<string, Node[]>()
  const canvasIds = new Set(read.canvases.map(canvas => canvas.id))
  const seen = new Map<string, string>()
  const counts: Preflight['counts'] = { canvases: read.canvases.length, nodes: read.nodes.length, drafts: 0, draftItems: 0, byStatus: {}, withSummary: 0, withFiles: 0, withSuggestions: 0 }
  for (const node of read.nodes) {
    counts.byStatus[node.status] = (counts.byStatus[node.status] ?? 0) + 1
    if (node.summary) counts.withSummary++
    if (node.files.length) counts.withFiles++
    if (node.suggestions.length) counts.withSuggestions++
    if (seen.has(node.id)) { issues.push({ severity: 'error', code: 'duplicate-node-id', where: node.id, message: `节点编号重复（画布 ${seen.get(node.id)} 与 ${node.canvas}）。` }); continue }
    seen.set(node.id, node.canvas)
    if (!canvasIds.has(node.canvas)) { issues.push({ severity: 'warning', code: 'orphan-node', where: node.id, message: `节点所属的画布 ${node.canvas || '（空）'} 不在导出里，已跳过。` }); continue }
    ;(byCanvas.get(node.canvas) ?? byCanvas.set(node.canvas, []).get(node.canvas)!).push(node)
  }
  const planned: Planned[] = []
  for (const canvas of read.canvases) {
    const nodes = byCanvas.get(canvas.id) ?? []
    const local: Issue[] = []
    const ids = new Set(nodes.map(node => node.id))
    const add = (severity: Severity, code: string, where: string, message: string) => { const issue = { severity, code, where, message }; local.push(issue); issues.push(issue) }
    let skip: string | undefined
    for (const draft of canvas.drafts) { counts.drafts += draft.items.length ? 1 : 0; counts.draftItems += draft.items.length }
    // Illegal edges: an edge to a node that does not exist is dropped (reported); a cycle makes the canvas unimportable.
    for (const node of nodes) for (const parent of node.parentIds) if (!ids.has(parent)) add('warning', 'dangling-parent', node.id, `指向不存在的父节点 ${parent}，这条边被丢弃，节点作为起点导入。`)
    const cyclic = (() => {
      const state = new Map<string, 1 | 2>(), byId = new Map(nodes.map(node => [node.id, node]))
      const visit = (id: string): boolean => {
        if (state.get(id) === 2) return false
        if (state.get(id) === 1) return true
        state.set(id, 1)
        for (const parent of byId.get(id)!.parentIds) if (byId.has(parent) && visit(parent)) return true
        state.set(id, 2); return false
      }
      return nodes.some(node => visit(node.id))
    })()
    if (cyclic) skip = '节点的父子关系成环，无法作为讨论导入。'
    for (const node of nodes) {
      if (questionOf(node).length > LIMITS.question) skip ??= `节点 ${node.id} 的问题超过 ${LIMITS.question} 字。`
      if (node.answer.length > LIMITS.answer) skip ??= `节点 ${node.id} 的回答超过 ${LIMITS.answer} 字。`
      if (node.status === 'done' && !node.answer.trim()) add('warning', 'done-without-answer', node.id, '状态为已完成但没有回答文本；导入为没有回答的问题。')
      if (!['done', 'error', 'stopped', 'streaming'].includes(node.status)) add('warning', 'unknown-status', node.id, `未知状态“${node.status}”，按未完成处理。`)
      if (node.status === 'streaming') add('warning', 'node-streaming', node.id, '源系统里这条回答仍在生成；导入为已中断，已有的部分文字保留，不会调用模型。')
      else if (node.status === 'error' || node.status === 'stopped') add('info', 'node-unfinished', node.id, `状态“${node.status}”：导入为未完成的回答（保留已有文字），可以重新回答。`)
      if (!node.question.trim() && !node.items.length) add('warning', 'empty-question', node.id, '节点没有问题文字；以“（导入的空问题）”导入。')
      if (node.files.length) add('warning', 'attachments-not-migrated', node.id, `有 ${node.files.length} 个附件（${node.files.map(file => file.filename ?? file.file_id ?? '未命名').join('、')}）。Canvas Note 没有附件库：只在导入记录里保留名称，文件和文本未迁入。`)
    }
    if (nodes.some(node => node.suggestions.length)) add('info', 'suggestions-dropped', canvas.id, '“可能的下一个问题”建议不迁入。')
    if (canvas.endpoint || canvas.model || nodes.some(node => node.endpoint || node.model)) add('info', 'model-settings-not-migrated', canvas.id, `源画布使用的端点/模型（${canvas.endpoint || '—'} / ${canvas.model || '—'}）不迁入；不迁移任何密钥，请在 Canvas Note 中重新配置连接。`)
    for (const draft of canvas.drafts) for (const item of draft.items) if (item.source && !ids.has(item.source)) add('warning', 'draft-source-missing', `${canvas.id}/${draft.id}`, `草稿里的引用来源节点 ${item.source} 不存在；问题保留，但不关联到父节点。`)
    if (!nodes.length && !canvas.drafts.some(draft => draft.items.length)) add('info', 'empty-canvas', canvas.id, '画布里没有问题也没有草稿；仍会创建一个空讨论。')
    planned.push({ canvas, discussionId: derive('chatgit-discussion', canvas.id), nodes, skip, issues: local })
  }
  return { planned, issues, counts }
}

export async function preflight(dir: string): Promise<Preflight> {
  const read = await readExport(dir)
  const { planned, issues, counts } = plan(read)
  const digest = contentVersion(read.files.map(file => file.sha256).join('\0'))
  return {
    format: 'chatgit-export', files: read.files, digest, counts, issues, readable: true,
    canvases: planned.map(item => ({ canvasId: item.canvas.id, name: item.canvas.name, discussionId: item.discussionId, status: item.skip ? 'skipped' as const : 'importable' as const, nodes: item.nodes.length, drafts: item.canvas.drafts.filter(draft => draft.items.length).length, ...(item.skip ? { reason: item.skip } : {}) })),
  }
}

// ---- building the Canvas Note records ----

interface Built { discussion: DiscussionDTO; drafts: DraftDTO[]; runs: RunDTO[]; summaries: { answerId: string; text: string }[]; answers: number }

function build(item: Planned, batch: string): Built {
  const { canvas, discussionId } = item
  const ids = new Set(item.nodes.map(node => node.id))
  const turnId = (id: string) => derive('chatgit-turn', discussionId, id)
  const first = (fallback: number) => item.nodes.reduce<number | null>((min, node) => node.createdAt !== null && (min === null || node.createdAt < min) ? node.createdAt : min, null) ?? fallback
  const createdAt = canvas.createdAt ?? first(0)
  const turns: TurnDTO[] = []
  const runs: RunDTO[] = []
  const summaries: Built['summaries'] = []
  let answers = 0
  const sorted = [...item.nodes].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id))
  for (const node of sorted) {
    const parents = [...new Set(node.parentIds.filter(parent => ids.has(parent)))].map(turnId)
    const finished = node.status === 'done' && node.answer.trim()
    const answerList: AnswerVersionDTO[] = finished ? [{ id: derive('chatgit-answer', discussionId, node.id), text: node.answer, createdAt: node.updatedAt ?? node.createdAt ?? createdAt, runId: 'chatgit:' + node.id }] : []
    answers += answerList.length
    turns.push({ id: turnId(node.id), parents, question: questionOf(node), sourceIds: [], requestKey: 'chatgit:' + node.id, answers: answerList, createdAt: node.createdAt ?? createdAt })
    if (finished && node.summary.trim() && node.summary.length < node.answer.length) summaries.push({ answerId: answerList[0]!.id, text: node.summary })
    if (!finished && node.status !== 'done') {
      const status: RunDTO['status'] = node.status === 'error' ? 'failed' : node.status === 'stopped' ? 'cancelled' : 'interrupted'
      const at = node.updatedAt ?? node.createdAt ?? createdAt
      runs.push({ id: derive('chatgit-run', discussionId, node.id), discussionId, turnId: turnId(node.id), requestKey: 'chatgit-import:' + node.id, status, text: node.answer, seq: 1, error: node.error ? `导入自 ChatGit：${errorText(node.error)}已有的文字保留，可以重新回答。` : `导入自 ChatGit：这条回答在源系统里${node.status === 'streaming' ? '尚未完成' : node.status === 'error' ? '没有成功' : '被停止'}，已有的文字保留，可以重新回答。`, createdAt: node.createdAt ?? createdAt, updatedAt: at })
    }
  }
  // Each question pins the answer version its ancestors had (every imported node has at most one).
  for (const turn of turns) if (turn.parents.length) {
    const frozen: Record<string, string> = {}
    for (const ancestor of ancestry(turns, turn.parents)) { const answer = ancestor.answers.at(-1); if (answer) frozen[ancestor.id] = answer.id }
    turn.frozen = frozen
  }
  validateTurns(turns)
  const stamps = [canvas.updatedAt, ...item.nodes.map(node => node.updatedAt ?? node.createdAt)].filter((value): value is number => value !== null)
  const title = (canvas.name.trim() || turns.find(turn => !turn.parents.length)?.question.split('\n')[0]!.slice(0, 60) || '导入的画布').slice(0, LIMITS.title)
  const discussion: DiscussionDTO = { id: discussionId, title, origin: { kind: 'chat' }, revision: 1, archived: false, turns, imported: { source: 'chatgit', canvasId: canvas.id, batch }, createdAt, updatedAt: Math.max(createdAt, canvas.updatedAt ?? 0, ...stamps) }
  const drafts: DraftDTO[] = canvas.drafts.filter(draft => draft.items.length).map(draft => {
    const parentIds = [...new Set(draft.items.map(entry => entry.source).filter(source => ids.has(source)))].map(turnId)
    return {
      id: derive('chatgit-draft', discussionId, draft.id), title: (draft.name.trim() || `草稿 ${draft.letter}`).slice(0, LIMITS.title), discussionId, parentIds, origin: { kind: 'chat' },
      items: draft.items.map((entry, index) => ({ id: `chatgit-${draft.id}-${index}`.replace(/[^\w-]/g, '_').slice(0, 64), question: draftQuestion(entry).slice(0, LIMITS.question), sourceIds: [] })),
      revision: 1, createdAt: canvas.updatedAt ?? createdAt, updatedAt: canvas.updatedAt ?? createdAt,
    }
  })
  return { discussion, drafts, runs, summaries, answers }
}

// ---- the import itself ----

export interface Batch { version: 1; id: string; source: 'chatgit' | 'canvas-conversation'; digest: string; state: 'importing' | 'completed' | 'rolled-back'; startedAt: number; completedAt?: number; files: Preflight['files']; discussions: string[]; drafts: string[]; runs: string[]; answers: string[]; skipped: { canvasId: string; reason: string }[]; attachments: { node: string; names: string[] }[] }
export interface ImportItem { canvasId: string; discussionId: string; name: string; result: 'created' | 'identical' | 'conflict' | 'skipped'; turns: number; answers: number; unfinished: number; drafts: number; summaries: number; reason?: string }
export interface ImportResult { batch: string; resumed: boolean; items: ImportItem[]; issues: Issue[]; totals: { created: number; identical: number; conflict: number; skipped: number } }

const batchId = (digest: string) => 'chatgit-' + digest.slice(0, 16)
export const batchFile = (store: NoteStore, id: string) => path.join(store.paths.local, 'imports', id + '.json')
export async function readBatch(store: NoteStore, id: string): Promise<Batch | null> {
  if (!/^(chatgit|legacy)-[a-f0-9]{16}$/.test(id)) throw new BadNameError('导入批次编号无效。')
  return readRecord<Batch>(batchFile(store, id))
}

/**
 * Writes an export into the discussion store. Safe to repeat or resume: ids come from the source, a canvas that is
 * already there identically is left alone, and one that differs is reported as a conflict and never overwritten.
 */
export async function importChatGit(store: NoteStore, research: ResearchStore, dir: string): Promise<ImportResult> {
  const read = await readExport(dir)
  const digest = contentVersion(read.files.map(file => file.sha256).join('\0'))
  const id = batchId(digest)
  const { planned, issues } = plan(read)
  if (issues.some(issue => issue.severity === 'error')) throw new BadNameError('导出里有无法处理的错误，已拒绝导入：' + issues.filter(issue => issue.severity === 'error').map(issue => issue.message).join('；'))
  const previous = await readBatch(store, id)
  if (previous?.state === 'rolled-back') throw new BadNameError('这个导出对应的批次已经回退过。如需再次导入，请先确认回退归档里的内容，并使用新的导出。')
  const batch: Batch = previous ?? { version: 1, id, source: 'chatgit', digest, state: 'importing', startedAt: Date.now(), files: read.files, discussions: [], drafts: [], runs: [], answers: [], skipped: [], attachments: [] }
  batch.state = 'importing'
  await writeRecord(batchFile(store, id), batch)
  const items: ImportItem[] = []
  const totals = { created: 0, identical: 0, conflict: 0, skipped: 0 }
  const runsDir = path.join(store.paths.local, 'runs')
  for (const item of planned) {
    const base = { canvasId: item.canvas.id, discussionId: item.discussionId, name: item.canvas.name }
    if (item.skip) {
      items.push({ ...base, result: 'skipped', turns: 0, answers: 0, unfinished: 0, drafts: 0, summaries: 0, reason: item.skip }); totals.skipped++
      if (!batch.skipped.some(entry => entry.canvasId === item.canvas.id)) batch.skipped.push({ canvasId: item.canvas.id, reason: item.skip })
      continue
    }
    const built = build(item, id)
    const result = await research.importDiscussion(built.discussion)
    // Identical content that an earlier batch wrote stays that batch's: rolling this one back must not take it.
    const mine = result === 'created' || (result === 'identical' && (await research.getDiscussion(item.discussionId)).imported?.batch === id)
    let drafts = 0
    if (result !== 'conflict') {
      for (const draft of built.drafts) if (await research.importDraft(draft) !== 'conflict') drafts++
      for (const run of built.runs) { if (!(await readRecord(path.join(runsDir, run.id + '.json')))) await writeRecord(path.join(runsDir, run.id + '.json'), { version: 1, ...run }) }
      for (const summary of built.summaries) await research.setSummary(summary.answerId, { text: summary.text, model: 'chatgit-import' })
      const add = (list: string[], value: string) => { if (!list.includes(value)) list.push(value) }
      if (mine) {
        add(batch.discussions, built.discussion.id)
        for (const draft of built.drafts) add(batch.drafts, draft.id)
        for (const run of built.runs) add(batch.runs, run.id)
        for (const turn of built.discussion.turns) for (const answer of turn.answers) add(batch.answers, answer.id)
      }
      for (const node of item.nodes) if (node.files.length && !batch.attachments.some(entry => entry.node === node.id)) batch.attachments.push({ node: node.id, names: node.files.map(file => file.filename ?? file.file_id ?? '未命名') })
    }
    totals[result]++
    items.push({ ...base, result, turns: built.discussion.turns.length, answers: built.answers, unfinished: built.runs.length, drafts, summaries: built.summaries.length, ...(result === 'conflict' ? { reason: '这个编号下已经有内容不同的讨论（可能在导入后被修改过），未覆盖。' } : {}) })
    await writeRecord(batchFile(store, id), batch)
  }
  batch.state = 'completed'; batch.completedAt = Date.now()
  await writeRecord(batchFile(store, id), batch)
  return { batch: id, resumed: !!previous, items, issues, totals }
}

// ---- verification ----

export interface Mismatch { where: string; message: string }
export interface Verification { batch: string; ok: boolean; checked: { discussions: number; turns: number; edges: number; answers: number; drafts: number; unfinished: number; summaries: number }; mismatches: Mismatch[] }

/** Compares the export, node by node, with what the store holds: counts, edges, text checksums, drafts, unfinished runs. */
export async function verifyImport(store: NoteStore, research: ResearchStore, dir: string): Promise<Verification> {
  const read = await readExport(dir)
  const id = batchId(contentVersion(read.files.map(file => file.sha256).join('\0')))
  const { planned } = plan(read)
  const mismatches: Mismatch[] = []
  const checked = { discussions: 0, turns: 0, edges: 0, answers: 0, drafts: 0, unfinished: 0, summaries: 0 }
  const sum = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16)
  const batch = await readBatch(store, id)
  if (!batch || batch.state !== 'completed') mismatches.push({ where: id, message: batch ? '导入批次没有完成。' : '没有找到这个导出的导入批次。' })
  for (const item of planned) {
    if (item.skip) continue
    const expected = build(item, id)
    let stored: DiscussionDTO
    try { stored = await research.getDiscussion(item.discussionId) } catch { mismatches.push({ where: item.canvas.id, message: '讨论不存在。' }); continue }
    checked.discussions++
    if (stored.imported?.canvasId !== item.canvas.id) mismatches.push({ where: item.canvas.id, message: '讨论不是由这个画布导入的。' })
    if (stored.turns.length !== expected.discussion.turns.length) mismatches.push({ where: item.canvas.id, message: `问题数不一致：导出 ${expected.discussion.turns.length}，现有 ${stored.turns.length}。` })
    const byId = new Map(stored.turns.map(turn => [turn.id, turn]))
    for (const want of expected.discussion.turns) {
      const got = byId.get(want.id)
      if (!got) { mismatches.push({ where: want.requestKey, message: '节点缺失。' }); continue }
      checked.turns++
      if (sum(got.question) !== sum(want.question)) mismatches.push({ where: want.requestKey, message: '问题文字的校验值不一致。' })
      if (JSON.stringify([...got.parents].sort()) !== JSON.stringify([...want.parents].sort())) mismatches.push({ where: want.requestKey, message: '父节点（边）不一致。' })
      checked.edges += want.parents.length
      if (got.answers.length !== want.answers.length || got.answers.some((answer, index) => sum(answer.text) !== sum(want.answers[index]!.text))) mismatches.push({ where: want.requestKey, message: '回答的数量或校验值不一致。' })
      checked.answers += want.answers.length
    }
    for (const run of expected.runs) {
      const record = await readRecord<RunDTO & { version: 1 }>(path.join(store.paths.local, 'runs', run.id + '.json'))
      if (!record || record.status !== run.status || sum(record.text) !== sum(run.text)) mismatches.push({ where: run.requestKey, message: '未完成回答的运行记录缺失或不一致。' })
      checked.unfinished++
    }
    for (const summary of expected.summaries) { if (await research.getSummary(summary.answerId) !== summary.text) mismatches.push({ where: summary.answerId, message: '摘要缺失或不一致。' }); checked.summaries++ }
    for (const draft of expected.drafts) {
      let got: DraftDTO | null = null
      try { got = await research.getDraft(draft.id) } catch { /* reported below */ }
      if (!got || got.items.length !== draft.items.length || got.items.some((entry, index) => entry.question !== draft.items[index]!.question)) mismatches.push({ where: draft.id, message: '草稿缺失或内容不一致。' })
      checked.drafts++
    }
  }
  return { batch: id, ok: mismatches.length === 0, checked, mismatches }
}

// ---- rollback ----

export interface Rollback { batch: string; archived: string; discussions: number; drafts: number; runs: number; additions: { discussion: string; turns: number }[] }

/**
 * Removes what a batch created, keeping a full copy first. Refused while a saved note still cites an imported answer
 * (the note's evidence would point at nothing). Questions added after the import are archived with the rest, not lost.
 */
export async function rollbackImport(store: NoteStore, research: ResearchStore, id: string): Promise<Rollback> {
  const batch = await readBatch(store, id)
  if (!batch) throw new BadNameError('没有找到这个导入批次。')
  if (batch.state === 'rolled-back') throw new BadNameError('这个批次已经回退过。')
  const imported = new Set(batch.discussions)
  const citing = (await research.listCaptures()).filter(capture => capture.answers.some(entry => imported.has(entry.discussionId)))
  if (citing.length) throw new BadNameError(`有 ${citing.length} 条保存记录引用了这批导入的回答（写入过笔记：${[...new Set(citing.map(capture => capture.target.notePath))].join('、')}）。回退会让这些依据失效，已拒绝；请先处理这些笔记。`)
  const archive = path.join(store.paths.local, 'imports', id + '-archive')
  const additions: Rollback['additions'] = []
  for (const discussionId of batch.discussions) {
    const discussion = await research.getDiscussion(discussionId).catch(() => null)
    if (!discussion) continue
    const added = discussion.turns.filter(turn => !/^(chatgit|legacy):/.test(turn.requestKey)).length
    if (added) additions.push({ discussion: discussionId, turns: added })
  }
  await research.archiveRecords(archive, { discussions: batch.discussions, drafts: batch.drafts, answers: batch.answers })
  await fs.mkdir(path.join(archive, 'runs'), { recursive: true })
  for (const runId of batch.runs) { try { await fs.rename(path.join(store.paths.local, 'runs', runId + '.json'), path.join(archive, 'runs', runId + '.json')) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error } }
  batch.state = 'rolled-back'
  await writeRecord(batchFile(store, id), batch)
  await writeRecord(path.join(archive, 'batch.json'), batch)
  return { batch: id, archived: archive, discussions: batch.discussions.length, drafts: batch.drafts.length, runs: batch.runs.length, additions }
}

export { StorageError }
