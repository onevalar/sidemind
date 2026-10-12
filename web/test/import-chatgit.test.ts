import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AISettings } from '../server/ai-settings'
import { createApp } from '../server/app'
import { ResearchStore } from '../server/discussions'
import { EventBus } from '../server/events'
import { contextFor } from '../server/explore'
import { importChatGit, preflight, readBatch, rollbackImport, verifyImport } from '../server/import-chatgit'
import { repoPaths } from '../server/repo'
import { NoteStore } from '../server/store'
import type { DiscussionDTO, RunDTO } from '../shared/types'
import { CANVAS, canvases, nodes, writeExport } from './fixtures/chatgit-export'

const run = promisify(execFile)
let dir: string, exportDir: string, store: NoteStore, research: ResearchStore
const J = { host: 'localhost:3001', 'content-type': 'application/json' }
const open = async (root: string) => { const s = new NoteStore(repoPaths(root)); await s.init(); return { store: s, research: new ResearchStore(s) } }
const text = async (root: string) => { const out: string[] = []; const walk = async (d: string) => { for (const e of await fs.readdir(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) await walk(p); else out.push(await fs.readFile(p, 'utf8')) } }; await walk(root); return out.join('\n') }

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cn-import-'))
  exportDir = path.join(dir, 'export')
  await writeExport(exportDir)
  ;({ store, research } = await open(path.join(dir, 'data')))
})
afterEach(() => fs.rm(dir, { recursive: true, force: true }))

const imported = async () => { const all = await research.listDiscussions(); return Promise.all(all.map(item => research.getDiscussion(item.id))) }
const byTitle = async (title: string) => (await imported()).find(item => item.title === title)!
const turnOf = (discussion: DiscussionDTO, requestKey: string) => discussion.turns.find(turn => turn.requestKey === 'chatgit:' + requestKey)!

describe('preflight', () => {
  it('reads without writing and reports what is there, what will be skipped and what cannot be migrated', async () => {
    const before = await text(path.join(dir, 'data'))
    const report = await preflight(exportDir)
    expect(report.counts).toMatchObject({ canvases: 3, nodes: 16, drafts: 1, draftItems: 3, withSummary: 1, withFiles: 1, withSuggestions: 1 })
    expect(report.counts.byStatus).toEqual({ done: 12, streaming: 1, error: 2, stopped: 1 })
    expect(report.canvases.map(canvas => [canvas.name, canvas.status])).toEqual([['材料研究', 'importable'], ['成环', 'skipped'], ['', 'importable']])
    expect(report.canvases[1]!.reason).toContain('成环')
    const codes = new Set(report.issues.map(issue => issue.code))
    for (const code of ['dangling-parent', 'orphan-node', 'node-streaming', 'node-unfinished', 'done-without-answer', 'attachments-not-migrated', 'suggestions-dropped', 'model-settings-not-migrated', 'draft-source-missing', 'empty-canvas']) expect(codes.has(code), code).toBe(true)
    expect(report.issues.some(issue => issue.severity === 'error')).toBe(false)
    expect(report.issues.find(issue => issue.code === 'attachments-not-migrated')!.message).toContain('资料.pdf')
    expect(await text(path.join(dir, 'data'))).toBe(before)                       // wrote nothing
  })

  it('accepts one document per line as well as a JSON array, and refuses an export it cannot read', async () => {
    await writeExport(path.join(dir, 'lines'), {}, 'lines')
    expect((await preflight(path.join(dir, 'lines'))).counts.nodes).toBe(16)
    await fs.writeFile(path.join(dir, 'bad', 'chatgit_canvases.json').replace('bad', 'broken'), '{', { flag: 'w' }).catch(async () => { await fs.mkdir(path.join(dir, 'broken')); await fs.writeFile(path.join(dir, 'broken', 'chatgit_canvases.json'), '{') })
    await fs.writeFile(path.join(dir, 'broken', 'chatgit_nodes.json'), '[]')
    await expect(preflight(path.join(dir, 'broken'))).rejects.toThrow('不是有效的 JSON')
    await expect(preflight(path.join(dir, 'nothing-here'))).rejects.toThrow('找不到')
  })

  it('reports a duplicate node id as an error and the import refuses to start', async () => {
    await writeExport(path.join(dir, 'dup'), { nodes: [...nodes, nodes[0]] })
    expect((await preflight(path.join(dir, 'dup'))).issues.some(issue => issue.code === 'duplicate-node-id' && issue.severity === 'error')).toBe(true)
    await expect(importChatGit(store, research, path.join(dir, 'dup'))).rejects.toThrow('已拒绝导入')
    expect(await research.listDiscussions()).toEqual([])
  })
})

describe('import', () => {
  it('turns a canvas into one discussion with its graph, answers, summaries, drafts and unfinished runs intact', async () => {
    const result = await importChatGit(store, research, exportDir)
    expect(result.totals).toEqual({ created: 2, identical: 0, conflict: 0, skipped: 1 })
    const d = await byTitle('材料研究')
    expect(d).toMatchObject({ origin: { kind: 'chat' }, archived: false, imported: { source: 'chatgit', canvasId: CANVAS.research } })
    expect(d.createdAt).toBe(Date.parse('2026-09-01T10:00:00.000Z'))
    expect(d.turns).toHaveLength(13)
    // Graph: edges kept, the merge has both parents, the dangling edge is dropped (node kept as a start).
    const id = (key: string) => turnOf(d, key).id
    expect(turnOf(d, 'm').parents.sort()).toEqual([id('a'), id('c')].sort())
    expect(turnOf(d, 'c').parents).toEqual([id('b')])
    expect(turnOf(d, 'd').parents).toEqual([])
    // Answers copied as they were, one version each, pinned for descendants.
    expect(turnOf(d, 'a').answers.map(answer => answer.text)).toEqual(['铝很轻。'])
    expect(turnOf(d, 'm').frozen).toMatchObject({ [id('a')]: turnOf(d, 'a').answers[0]!.id, [id('c')]: turnOf(d, 'c').answers[0]!.id, [id('root')]: turnOf(d, 'root').answers[0]!.id })
    // Quote questions keep the quote and the default "explain this"; the empty question gets an honest placeholder.
    expect(turnOf(d, 'q').question).toBe('「很轻」请解释这段内容。\n「铝」纯度？')
    expect(turnOf(d, 'n').answers).toEqual([])
    // Summaries land in the summary store; the answer text itself is untouched.
    expect(await research.getSummary(turnOf(d, 'root').answers[0]!.id)).toBe('短摘要')
    // Drafts: parents mapped, quotes kept, the lost source reported but the question kept.
    const drafts = await research.listDrafts(d.id)
    expect(drafts).toHaveLength(1)
    expect(drafts[0]).toMatchObject({ title: '草稿 A', discussionId: d.id, parentIds: [id('a'), id('b')] })
    expect(drafts[0]!.items.map(item => item.question)).toEqual(['「铝很轻」为什么轻？', '「木可燃」请解释这段内容。', '「来源已丢失」为什么？'])
    // The skipped canvas and orphan node are not imported; the empty canvas is (named honestly).
    expect((await imported()).map(item => item.title).sort()).toEqual(['导入的画布', '材料研究'].sort())
    expect(result.items.find(item => item.canvasId === CANVAS.cycle)).toMatchObject({ result: 'skipped' })
  })

  it('imports unfinished nodes as interrupted/failed/cancelled runs with their partial text, and never as answers', async () => {
    await importChatGit(store, research, exportDir)
    const d = await byTitle('材料研究')
    const sets = new Set(d.turns.map(turn => turn.id))
    const app = createApp(store, new EventBus(), { aiSettings: new AISettings(dir, path.join(dir, 'private'), {}) })
    const view = await (await app.request(`/api/discussions/${d.id}/view`, { headers: J })).json() as { runs: RunDTO[] }
    const status = (key: string) => view.runs.find(item => item.turnId === turnOf(d, key).id)
    expect(status('s')).toMatchObject({ status: 'interrupted', text: '写到一半的文字' })
    expect(status('e')).toMatchObject({ status: 'failed', text: '' })
    expect(status('e')!.error).toContain('导入自 ChatGit：')
    expect(status('e')!.error).toContain('The model service returned an error.')   // an unknown code is shown, not hidden
    expect(status('x')).toMatchObject({ status: 'cancelled', text: '停在这里' })
    expect(status('rl')!.error).toContain('模型服务限流或额度不足。')           // ChatGit's error code, in words
    for (const key of ['s', 'e', 'x', 'rl']) expect(turnOf(d, key).answers).toEqual([])
    expect(view.runs.every(item => sets.has(item.turnId))).toBe(true)
  })

  it('works in the app afterwards: listed, viewable, and a question can continue from an imported answer, with no model call at import', async () => {
    let calls = 0
    const ai = new AISettings(dir, path.join(dir, 'private'), {}); await ai.save({ model: 'm', baseUrl: 'https://models.example/v1', key: 'k' })
    const app = createApp(store, new EventBus(), { aiSettings: ai, aiTransport: async () => { calls++; return new Response(JSON.stringify({ choices: [{ message: { content: '续答' }, finish_reason: 'stop' }] })) } })
    await importChatGit(store, research, exportDir)
    expect(calls).toBe(0)
    const list = await (await app.request('/api/discussions', { headers: J })).json() as { title: string; turnCount: number }[]
    expect(list.find(item => item.title === '材料研究')!.turnCount).toBe(13)
    const d = await byTitle('材料研究')
    const merged = turnOf(d, 'm')
    // A new question on the imported comparison sees its ancestry parents-first, each answer pinned.
    const probe = await research.addTurn(d.id, { question: '探针', parents: [merged.id], requestKey: 'probe' })
    const context = await contextFor(research, await research.getDiscussion(d.id), (await research.getDiscussion(d.id)).turns.find(turn => turn.id === probe.id)!)
    expect(context.turns.map(turn => turn.question)).toEqual(['材料有哪些类别？', '铝怎么样？', '木怎么样？', '木的优点？', '比较铝和木', '探针'])
    expect(context.exceeded).toBe(false)
    expect(probe.frozen![merged.id]).toBe(merged.answers[0]!.id)
  })

  it('copies no credentials, tokens or the source user id into the data directory', async () => {
    await importChatGit(store, research, exportDir)
    const everything = await text(path.join(dir, 'data'))
    expect(everything).not.toContain('SECRET-USER-ID')
    expect(everything).not.toMatch(/apiKey|api_key|password|Bearer |eyJhbGci/i)
    expect(everything).not.toContain('chatgit-fixture')          // endpoint/model choice is not carried over
  })
})

describe('repeating, resuming and conflicts', () => {
  it('importing the same export again creates nothing new and changes no bytes', async () => {
    await importChatGit(store, research, exportDir)
    const before = await text(path.join(dir, 'data', 'local', 'discussions')) + await text(path.join(dir, 'data', 'local', 'drafts')) + await text(path.join(dir, 'data', 'local', 'runs'))
    const again = await importChatGit(store, research, exportDir)
    expect(again.resumed).toBe(true)
    expect(again.totals).toEqual({ created: 0, identical: 2, conflict: 0, skipped: 1 })
    expect(await text(path.join(dir, 'data', 'local', 'discussions')) + await text(path.join(dir, 'data', 'local', 'drafts')) + await text(path.join(dir, 'data', 'local', 'runs'))).toBe(before)
    expect(await research.listDiscussions()).toHaveLength(2)
    expect(await research.listDrafts()).toHaveLength(1)
  })

  it('resumes an interrupted import: only what is missing is written', async () => {
    await importChatGit(store, research, exportDir)
    const batch = (await readBatch(store, (await fs.readdir(path.join(dir, 'data', 'local', 'imports')))[0]!.replace('.json', '')))!
    await fs.rm(path.join(dir, 'data', 'local', 'discussions', batch.discussions[0] + '.json'))
    await fs.writeFile(path.join(dir, 'data', 'local', 'imports', batch.id + '.json'), JSON.stringify({ ...batch, state: 'importing' }))
    const again = await importChatGit(store, research, exportDir)
    expect(again.totals.created).toBe(1); expect(again.totals.identical).toBe(1)
    expect(await research.listDiscussions()).toHaveLength(2)
    expect((await readBatch(store, batch.id))!.state).toBe('completed')
  })

  it('reports a discussion changed since the import as a conflict and leaves it alone', async () => {
    await importChatGit(store, research, exportDir)
    const d = await byTitle('材料研究')
    await research.addTurn(d.id, { question: '导入之后我自己加的', parents: [turnOf(d, 'a').id], requestKey: 'mine' })
    const again = await importChatGit(store, research, exportDir)
    expect(again.totals).toMatchObject({ created: 0, conflict: 1 })
    expect(again.items.find(item => item.result === 'conflict')!.reason).toContain('未覆盖')
    expect((await research.getDiscussion(d.id)).turns.some(turn => turn.requestKey === 'mine')).toBe(true)
  })

  it('a changed export of the same canvas is a different batch and conflicts rather than overwriting', async () => {
    await importChatGit(store, research, exportDir)
    const edited = nodes.map(item => item.nodeId === 'a' ? { ...item, answer: '被改过的回答' } : item)
    await writeExport(path.join(dir, 'export2'), { nodes: edited })
    const second = await importChatGit(store, research, path.join(dir, 'export2'))
    const first = await importChatGit(store, research, exportDir)         // the original export again
    expect(second.batch).not.toBe(first.batch)
    expect(second.totals).toMatchObject({ conflict: 1, identical: 1, created: 0 })
    // The identical canvas stays the first batch's, so rolling the second back removes nothing of it.
    expect((await readBatch(store, second.batch))!.discussions).toEqual([])
    expect(turnOf(await byTitle('材料研究'), 'a').answers[0]!.text).toBe('铝很轻。')
  })
})

describe('verification', () => {
  it('confirms counts, edges and text checksums, and names the node that differs', async () => {
    await importChatGit(store, research, exportDir)
    const ok = await verifyImport(store, research, exportDir)
    expect(ok).toMatchObject({ ok: true, mismatches: [], checked: { discussions: 2, turns: 13, answers: 8, drafts: 1, unfinished: 4, summaries: 1 } })
    expect(ok.checked.edges).toBeGreaterThan(8)
    const d = await byTitle('材料研究')
    const file = path.join(dir, 'data', 'local', 'discussions', d.id + '.json')
    const record = JSON.parse(await fs.readFile(file, 'utf8'))
    record.turns.find((turn: { requestKey: string }) => turn.requestKey === 'chatgit:b').answers[0].text = '悄悄被改'
    await fs.writeFile(file, JSON.stringify(record))
    const bad = await verifyImport(store, research, exportDir)
    expect(bad.ok).toBe(false)
    expect(bad.mismatches).toEqual([{ where: 'chatgit:b', message: '回答的数量或校验值不一致。' }])
  })

  it('fails when nothing was imported', async () => {
    const result = await verifyImport(store, research, exportDir)
    expect(result.ok).toBe(false)
    expect(result.mismatches[0]!.message).toContain('没有找到')
  })
})

describe('rollback', () => {
  it('moves everything the batch created into a full archive, leaves unrelated data, and cannot be imported over', async () => {
    const mine = await research.createDiscussion({ title: '我自己的对话' })
    const result = await importChatGit(store, research, exportDir)
    const done = await rollbackImport(store, research, result.batch)
    expect(done).toMatchObject({ discussions: 2, drafts: 1, runs: 4 })
    expect((await research.listDiscussions()).map(item => item.id)).toEqual([mine.id])
    expect(await research.listDrafts()).toEqual([])
    expect((await fs.readdir(path.join(done.archived, 'discussions'))).length).toBe(2)
    expect((await fs.readdir(path.join(done.archived, 'runs'))).length).toBe(4)
    expect((await readBatch(store, result.batch))!.state).toBe('rolled-back')
    await expect(importChatGit(store, research, exportDir)).rejects.toThrow('已经回退过')
    await expect(rollbackImport(store, research, result.batch)).rejects.toThrow('已经回退过')
  })

  it('archives questions added after the import with the rest, and says so', async () => {
    const result = await importChatGit(store, research, exportDir)
    const d = await byTitle('材料研究')
    await research.addTurn(d.id, { question: '导入后新增', parents: [turnOf(d, 'a').id], requestKey: 'new-1' })
    const done = await rollbackImport(store, research, result.batch)
    expect(done.additions).toEqual([{ discussion: d.id, turns: 1 }])
    expect(await fs.readFile(path.join(done.archived, 'discussions', d.id + '.json'), 'utf8')).toContain('导入后新增')
  })

  it('is refused while a saved note cites an imported answer, and removes nothing', async () => {
    const result = await importChatGit(store, research, exportDir)
    const d = await byTitle('材料研究')
    const note = await store.create('笔记', '# 笔记\n')
    const identity = await store.identity(note)
    const answer = turnOf(d, 'a').answers[0]!
    await research.recordCapture({ requestKey: 'cap', mode: 'verbatim', target: { kind: 'append', noteId: identity.id, notePath: note, beforeVersion: identity.version, afterVersion: 'a'.repeat(64) }, answers: [{ discussionId: d.id, turnId: turnOf(d, 'a').id, answerId: answer.id }] })
    await expect(rollbackImport(store, research, result.batch)).rejects.toThrow('保存记录引用了这批导入的回答')
    expect(await research.listDiscussions()).toHaveLength(2)
    expect((await readBatch(store, result.batch))!.state).toBe('completed')
  })
})

describe('command line', () => {
  const cli = (...args: string[]) => run('node', ['--import', 'tsx', 'server/import-cli.ts', ...args], { cwd: path.resolve(__dirname, '..'), timeout: 60000 }).then(out => ({ code: 0, out: out.stdout + out.stderr }), (error: { code: number; stdout: string; stderr: string }) => ({ code: error.code, out: error.stdout + error.stderr }))

  it('preflight reports and writes nothing; a fresh target imports and verifies; an existing target is refused without a backup and then imported with one; verify; rollback', async () => {
    const pre = await cli('preflight', exportDir)
    expect(pre.code).toBe(0); expect(pre.out).toContain('3 个画布'); expect(pre.out).toContain('attachments-not-migrated')

    const target = path.join(dir, 'target')
    const fresh = await cli('import', exportDir, target)
    expect(fresh.code, fresh.out).toBe(0)
    expect(fresh.out).toContain('新建 2'); expect(fresh.out).toContain('核对：全部一致')
    const batch = /导入批次 (chatgit-[a-f0-9]{16})/.exec(fresh.out)![1]!

    // The target now has data: importing again needs a backup first, and refuses without one.
    const refused = await cli('import', exportDir, target)
    expect(refused.code).toBe(1); expect(refused.out).toContain('--backup')
    const backup = path.join(dir, 'backup')
    const again = await cli('import', exportDir, target, '--backup', backup)
    expect(again.code, again.out).toBe(0)
    expect(again.out).toContain('备份已完成并校验'); expect(again.out).toContain('接着上次继续'); expect(again.out).toContain('已存在且相同 2')
    expect((await fs.readdir(backup)).length).toBeGreaterThan(0)

    expect((await cli('verify', exportDir, target)).code).toBe(0)
    const back = await cli('rollback', batch, target, '--backup', path.join(dir, 'backup2'))
    expect(back.code, back.out).toBe(0); expect(back.out).toContain('已回退批次')
    expect((await cli('verify', exportDir, target)).code).toBe(1)
  }, 120000)

  it('refuses an export with errors before writing anything', async () => {
    await writeExport(path.join(dir, 'dup'), { nodes: [...nodes, nodes[0]] })
    const target = path.join(dir, 'untouched')
    const result = await cli('import', path.join(dir, 'dup'), target)
    expect(result.code).toBe(1); expect(result.out).toContain('duplicate-node-id'); expect(result.out).toContain('未写入任何内容')
    expect(await fs.readdir(path.join(target, 'local')).catch(() => [])).not.toContain('discussions')
  }, 60000)
})
