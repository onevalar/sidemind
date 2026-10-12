import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AISettings } from '../server/ai-settings'
import { createApp } from '../server/app'
import { EventBus } from '../server/events'
import { NoteStore } from '../server/store'
import type { AgentEvent, AgentScope, CanvasLayout } from '../shared/types'

let dir: string
let ai: AISettings
const H = { host: 'localhost:3001' }
const J = { ...H, 'content-type': 'application/json' }
const input = { model: 'test-model', baseUrl: 'https://models.example/v1', key: 'test-only-key' }
const reply = (content: string | null, tool_calls?: unknown[]) => new Response(JSON.stringify({ choices: [{ message: { content, ...(tool_calls ? { tool_calls } : {}) }, finish_reason: tool_calls ? 'tool_calls' : 'stop' }] }))
const call = (name: string, args: object, id = name + Math.random()) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
type Step = (result: any, body: any) => Response | Promise<Response>

/** A scripted model: each step receives the last tool result and returns the next reply. */
function scripted(steps: Step[]): typeof fetch {
  let index = 0
  return async (_, init) => {
    const body = JSON.parse(String(init!.body)), last = body.messages.at(-1)
    const step = steps[index++]
    if (!step) throw new Error('unexpected model call')
    return step(last.role === 'tool' ? JSON.parse(last.content) : null, body)
  }
}
async function send(app: ReturnType<typeof createApp>, scope: AgentScope, message: string, session?: string): Promise<AgentEvent[]> {
  const response = await app.request('/api/ai/agent', { method: 'POST', headers: J, body: JSON.stringify({ scope, message, session }) })
  expect(response.status).toBe(200)
  return (await response.text()).trim().split('\n').map(line => JSON.parse(line) as AgentEvent)
}
const lastSet = (events: AgentEvent[]) => events.flatMap(event => event.type === 'changeset' ? [event.change] : []).at(-1)!
const errors = (events: AgentEvent[]) => events.filter(event => event.type === 'error')

let store: NoteStore
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cn-tools-'))
  ai = new AISettings(path.join(dir, 'notes'), path.join(dir, 'private'), {})
  await ai.save(input)
  store = new NoteStore(path.join(dir, 'notes'))
  await store.init()
  await store.createFolder('Work'); await store.createFolder('Archive')
  await store.create('Topic', '# Topic\n\nSee [Other](../Archive/Other.md#part) and [self](./Topic.md).\n', 'Work')
  await store.create('Index', '# Index\n\n- [Topic](Work/Topic.md)\n- <Work/Topic.md>\n- [ref][t]\n\n[t]: ./Work/Topic.md "title"\n', '')
  await store.create('Other', '# Other\n\nBack to [topic](../Work/Topic.md).\n', 'Archive')
  await store.list()
})
afterEach(() => fs.rm(dir, { recursive: true, force: true }))

const app = (steps: Step[]) => createApp(store, new EventBus(), { aiSettings: ai, aiTransport: scripted(steps) })
const read = (name: string) => fs.readFile(path.join(store.root, name), 'utf8')
const layout = async (folder: string) => (await store.canvas(folder)) as CanvasLayout

describe('Agent file tools', () => {
  it('renames a note: rewrites every link to it, moves its memory and keeps its card and frame', async () => {
    const position = (await layout('Work')).positions['Work/Topic.md']!
    await store.saveCanvas('Work', [{ id: 'f1', space: 'Work', title: 'Group', position: { x: position.x - 24, y: position.y - 64 }, width: 400, height: 300, members: ['Work/Topic.md'] }], {}, [])
    await fs.mkdir(path.join(store.paths.memory, 'Work'), { recursive: true })
    await fs.writeFile(path.join(store.paths.memory, 'Work/Topic.md'), '---\nnote: Work/Topic.md\n---\n## 用途\n- 测试\n')
    const events = await send(app([
      () => reply(null, [call('rename_note', { name: 'Work/Topic.md', title: '新主题' })]),
      result => { expect(result).toMatchObject({ renamed: 'Work/Topic.md', to: 'Work/新主题.md', linksUpdated: 2 }); return reply('已重命名。') },
    ]), { kind: 'folder', folder: 'Work' }, '把 Topic 改名为 新主题')
    expect(errors(events)).toEqual([])
    await expect(read('Work/Topic.md')).rejects.toThrow()
    expect(await read('Work/新主题.md')).toBe('# 新主题\n\nSee [Other](../Archive/Other.md#part) and [self](./%E6%96%B0%E4%B8%BB%E9%A2%98.md).\n')
    expect(await read('Index.md')).toBe('# Index\n\n- [Topic](./Work/%E6%96%B0%E4%B8%BB%E9%A2%98.md)\n- <Work/Topic.md>\n- [ref][t]\n\n[t]: ./Work/%E6%96%B0%E4%B8%BB%E9%A2%98.md "title"\n')
    expect(await read('Archive/Other.md')).toBe('# Other\n\nBack to [topic](../Work/%E6%96%B0%E4%B8%BB%E9%A2%98.md).\n')
    expect(await fs.readFile(path.join(store.paths.memory, 'Work/新主题.md'), 'utf8')).toContain('note: Work/新主题.md')
    await expect(fs.access(path.join(store.paths.memory, 'Work/Topic.md'))).rejects.toThrow()
    const after = await layout('Work')
    expect(after.positions['Work/新主题.md']).toEqual(position)
    expect(after.frames[0]!.members).toEqual(['Work/新主题.md'])
    // One undo restores names, links, memory and canvas.
    const set = lastSet(events)
    const undone = await createApp(store, new EventBus(), { aiSettings: ai }).request(`/api/ai/changes/${set.id}/undo`, { method: 'POST', headers: J, body: '{}' })
    expect(undone.status).toBe(200)
    expect(await read('Work/Topic.md')).toBe('# Topic\n\nSee [Other](../Archive/Other.md#part) and [self](./Topic.md).\n')
    expect(await read('Index.md')).toContain('- [Topic](Work/Topic.md)')
    expect(await fs.readFile(path.join(store.paths.memory, 'Work/Topic.md'), 'utf8')).toContain('note: Work/Topic.md')
    const restored = await layout('Work')
    expect(restored.positions['Work/Topic.md']).toEqual(position)
    expect(restored.frames[0]!.members).toEqual(['Work/Topic.md'])
  })

  it('moves notes across folders with links rewritten in both directions and cards placed on the new canvas', async () => {
    const events = await send(app([
      () => reply(null, [call('move_notes', { names: ['Work/Topic.md'], folder: 'Archive/Deep' })]),
      () => reply('已移动。'),
    ]), { kind: 'folder', folder: '' }, '把 Topic 移到 Archive/Deep')
    expect(errors(events)).toEqual([])
    expect(await read('Archive/Deep/Topic.md')).toBe('# Topic\n\nSee [Other](../Other.md#part) and [self](./Topic.md).\n')
    expect(await read('Archive/Other.md')).toBe('# Other\n\nBack to [topic](./Deep/Topic.md).\n')
    expect((await layout('Archive/Deep')).positions).toHaveProperty(['Archive/Deep/Topic.md'])
    expect((await layout('Work')).positions).not.toHaveProperty(['Work/Topic.md'])
  })

  it('batch renames atomically and refuses the whole batch on a collision', async () => {
    const before = await read('Index.md')
    const events = await send(app([
      () => reply(null, [call('batch_rename', { renames: [{ name: 'Work/Topic.md', title: 'Index' }, { name: 'Archive/Other.md', newName: 'Index.md' }] })]),
      result => { expect(result.error).toContain('已存在'); return reply(null, [call('batch_rename', { renames: [{ name: 'Work/Topic.md', title: 'A' }, { name: 'Archive/Other.md', title: 'B' }], updateHeadings: false })]) },
      result => { expect(result.renamed).toEqual({ 'Work/Topic.md': 'Work/A.md', 'Archive/Other.md': 'Archive/B.md' }); return reply('完成。') },
    ]), { kind: 'folder', folder: '' }, '批量改名')
    expect(errors(events)).toEqual([])
    expect(await read('Work/A.md')).toBe('# Topic\n\nSee [Other](../Archive/B.md#part) and [self](./A.md).\n')
    expect(await read('Archive/B.md')).toBe('# Other\n\nBack to [topic](../Work/A.md).\n')
    expect(await read('Index.md')).not.toBe(before)
  })

  it('previews and applies batch replacements, and deletes with an exact undo', async () => {
    const events = await send(app([
      () => reply(null, [call('batch_replace', { find: '(\\[[^\\]]+\\])\\(', replace: '$1 (', regex: true, preview: true })]),
      result => { expect(result).toMatchObject({ preview: true, files: 3 }); return reply(null, [call('batch_replace', { find: 'Topic', replace: '主题', folder: 'Work' })]) },
      result => { expect(result).toMatchObject({ files: 1, replacements: 2 }); return reply(null, [call('delete_notes', { names: ['Archive/Other.md'] })]) },
      result => { expect(result.brokenLinks).toEqual([{ from: 'Work/Topic.md', to: 'Archive/Other.md' }]); return reply('完成。') },
    ]), { kind: 'folder', folder: '' }, '替换并删除')
    expect(errors(events)).toEqual([])
    expect(await read('Work/Topic.md')).toBe('# 主题\n\nSee [Other](../Archive/Other.md#part) and [self](./主题.md).\n')
    await expect(read('Archive/Other.md')).rejects.toThrow()
    const set = lastSet(events)
    expect(set.files).toEqual([{ name: 'Work/Topic.md', kind: 'edit' }, { name: 'Archive/Other.md', kind: 'delete' }])
    const client = createApp(store, new EventBus(), { aiSettings: ai })
    expect((await client.request(`/api/ai/changes/${set.id}/undo`, { method: 'POST', headers: J, body: '{}' })).status).toBe(200)
    expect(await read('Archive/Other.md')).toBe('# Other\n\nBack to [topic](../Work/Topic.md).\n')
    expect(await read('Work/Topic.md')).toBe('# Topic\n\nSee [Other](../Archive/Other.md#part) and [self](./Topic.md).\n')
  })

  it('refuses to undo when a touched file changed afterwards', async () => {
    const events = await send(app([
      () => reply(null, [call('batch_replace', { find: 'Other', replace: 'Else', names: ['Archive/Other.md'] })]),
      () => reply('完成。'),
    ]), { kind: 'folder', folder: '' }, '替换')
    const set = lastSet(events)
    await fs.writeFile(path.join(store.root, 'Archive/Other.md'), '# 手动修改\n')
    const client = createApp(store, new EventBus(), { aiSettings: ai })
    const response = await client.request(`/api/ai/changes/${set.id}/undo`, { method: 'POST', headers: J, body: '{}' })
    expect(response.status).toBe(409)
    expect(await read('Archive/Other.md')).toBe('# 手动修改\n')
  })

  it('splits a fully read note at headings into linked parts and records the origin in their memory', async () => {
    await store.saveContent('Work/Topic.md', '# Topic\n\nIntro.\n\n## Alpha\n\nA text.\n\n### Deep\n\nD.\n\n## Beta\n\nB text.\n', await read('Work/Topic.md'))
    let version = ''
    const events = await send(app([
      () => reply(null, [call('read_note', { name: 'Work/Topic.md' })]),
      result => { version = result.version; return reply(null, [call('split_note', { name: 'Work/Topic.md', version })]) },
      result => { expect(result.parts).toEqual(['Work/Alpha.md', 'Work/Beta.md']); return reply('已拆分。') },
    ]), { kind: 'note', folder: 'Work', name: 'Work/Topic.md' }, '按二级标题拆分')
    expect(errors(events)).toEqual([])
    expect(await read('Work/Alpha.md')).toBe('# Alpha\n\nA text.\n\n## Deep\n\nD.\n')
    expect(await read('Work/Beta.md')).toBe('# Beta\n\nB text.\n')
    expect(await read('Work/Topic.md')).toBe('# Topic\n\nIntro.\n\n## 拆分出的文章\n\n- [Alpha](./Alpha.md)\n- [Beta](./Beta.md)\n')
    expect(await fs.readFile(path.join(store.paths.memory, 'Work/Alpha.md'), 'utf8')).toContain('拆分自：Work/Topic.md')
    expect(Object.keys((await layout('Work')).positions).sort()).toEqual(['Work/Alpha.md', 'Work/Beta.md', 'Work/Topic.md'])
  })

  it('edits one section by key without touching the rest', async () => {
    await store.saveContent('Work/Topic.md', '# Topic\n\n## A\n\nold a\n\n## B\n\nkeep b\n', await read('Work/Topic.md'))
    await send(app([
      () => reply(null, [call('read_section', { name: 'Work/Topic.md', section: 'Topic / A' })]),
      result => reply(null, [call('edit_section', { name: 'Work/Topic.md', version: result.version, section: 'Topic / A', content: 'new a', heading: 'A2' })]),
      () => reply('改好了。'),
    ]), { kind: 'note', folder: 'Work', name: 'Work/Topic.md' }, '改 A 节')
    expect(await read('Work/Topic.md')).toBe('# Topic\n\n## A2\n\nnew a\n\n## B\n\nkeep b\n')
  })
})

describe('Agent canvas tools', () => {
  it('lays out groups as frames with computed coordinates, and creates/dissolves frames', async () => {
    for (const title of ['A', 'B', 'C']) await store.create(title, `# ${title}\n`, 'Work')
    const events = await send(app([
      () => reply(null, [call('layout_groups', { folder: 'Work', groups: [{ title: '一组', members: ['Work/A.md', 'Work/B.md'] }, { title: '二组', members: ['Work/C.md'] }] })]),
      result => { expect(result.ungrouped).toBe(1); return reply(null, [call('read_canvas', { folder: 'Work' })]) },
      result => { expect(result.frames.map((frame: { title: string }) => frame.title)).toEqual(['一组', '二组']); return reply(null, [call('dissolve_frame', { folder: 'Work', id: result.frames[1].id })]) },
      () => reply(null, [call('create_frame', { folder: 'Work', title: '主题', members: ['Work/Topic.md', 'Work/C.md'] })]),
      () => reply(null, [call('focus_notes', { names: ['Work/Topic.md'] })]),
      () => reply('整理好了。'),
    ]), { kind: 'folder', folder: 'Work' }, '整理画布')
    expect(errors(events)).toEqual([])
    expect(events).toContainEqual({ type: 'focus', folder: 'Work', names: ['Work/Topic.md'] })
    const result = await layout('Work')
    expect(result.frames.map(frame => [frame.title, frame.members])).toEqual([['一组', ['Work/A.md', 'Work/B.md']], ['主题', ['Work/Topic.md', 'Work/C.md']]])
    // Frames contain their members' card centers (the UI's membership rule).
    for (const frame of result.frames) for (const name of frame.members) {
      const p = result.positions[name]!
      expect(p.x + 140).toBeGreaterThanOrEqual(frame.position.x + 16); expect(p.y + 96).toBeGreaterThanOrEqual(frame.position.y + 48)
      expect(p.x + 140).toBeLessThanOrEqual(frame.position.x + frame.width - 16); expect(p.y + 96).toBeLessThanOrEqual(frame.position.y + frame.height - 16)
    }
    // Markdown untouched by layout work.
    expect(await read('Work/A.md')).toBe('# A\n')
  })
})

describe('proposals, conversations and streaming', () => {
  it('refuses synchronization during a live Agent turn and still saves the completed answer', async () => {
    let started!: () => void, resume!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    const waiting = new Promise<void>(resolve => { resume = resolve })
    const client = app([async () => { started(); await waiting; return reply('完整回答') }])
    const scope: AgentScope = { kind: 'folder', folder: 'Work' }
    const pending = send(client, scope, '开始')
    await entered
    try {
      const response = await client.request('/api/repo/push', { method: 'POST', headers: J, body: '{}' })
      expect(await response.text()).toContain('助手任务或同步仍在进行')
    } finally { resume() }
    expect(errors(await pending)).toEqual([])
    const state = await (await client.request('/api/ai/conversation?scope=' + encodeURIComponent(JSON.stringify(scope)), { headers: H })).json()
    expect(state.messages).toEqual([{ role: 'user', text: '开始' }, { role: 'assistant', text: '完整回答' }])
  })

  it('queues model-initiated changes until accepted, and marks stale proposals', async () => {
    let version = ''
    const events = await send(app([
      () => reply(null, [call('read_note', { name: 'Index.md' })]),
      result => { version = result.version; return reply(null, [call('propose_changes', { reason: '顺手修正标题', operations: [{ tool: 'edit_note', arguments: { name: 'Index.md', version, edits: [{ oldText: '# Index', newText: '# Index notes' }] } }, { tool: 'rename_note', arguments: { name: 'Archive/Other.md', title: 'Other 2', updateHeading: false } }] })]) },
      result => { expect(result.status).toBe('pending'); return reply('我提了一个建议，等你确认。') },
    ]), { kind: 'folder', folder: '' }, '看看 Other')
    const proposal = events.find(event => event.type === 'proposal')
    if (proposal?.type !== 'proposal') throw new Error('no proposal')
    expect(proposal.proposal.files.map(file => file.kind)).toEqual(['edit', 'delete', 'create', 'edit'])
    expect(await read('Archive/Other.md')).toBe('# Other\n\nBack to [topic](../Work/Topic.md).\n')
    expect(await read('Index.md')).toContain('# Index\n')
    const client = createApp(store, new EventBus(), { aiSettings: ai })
    const accepted = await client.request(`/api/ai/proposals/${proposal.proposal.id}/accept`, { method: 'POST', headers: J, body: '{}' })
    expect(accepted.status).toBe(200)
    expect(await read('Index.md')).toContain('# Index notes\n')
    expect(await read('Archive/Other 2.md')).toBe('# Other\n\nBack to [topic](../Work/Topic.md).\n')
    expect(await read('Work/Topic.md')).toContain('[Other](../Archive/Other%202.md#part)')
    const repeated = await client.request(`/api/ai/proposals/${proposal.proposal.id}/accept`, { method: 'POST', headers: J, body: '{}' })
    expect(repeated.status).toBe(200)
    expect((await repeated.json()).changeset.id).toBe((await accepted.json()).changeset.id)
    expect(await read('Index.md')).not.toContain('# Index notes notes')
    // A second proposal goes stale when the file changes before acceptance.
    const second = await send(app([
      () => reply(null, [call('read_note', { name: 'Index.md' })]),
      result => reply(null, [call('propose_changes', { reason: 'x', operations: [{ tool: 'edit_note', arguments: { name: 'Index.md', version: result.version, edits: [{ oldText: '# Index', newText: '# 索引' }] } }] })]),
      () => reply('建议已提交。'),
    ]), { kind: 'folder', folder: '' }, '看看 Index')
    const stale = second.find(event => event.type === 'proposal')
    if (stale?.type !== 'proposal') throw new Error('no proposal')
    await fs.writeFile(path.join(store.root, 'Index.md'), '# 用户改了\n')
    expect((await client.request(`/api/ai/proposals/${stale.proposal.id}/accept`, { method: 'POST', headers: J, body: '{}' })).status).toBe(409)
    expect(await read('Index.md')).toBe('# 用户改了\n')
    expect(await (await client.request('/api/ai/proposals', { headers: H })).json()).toContainEqual(expect.objectContaining({ id: stale.proposal.id, status: 'stale' }))
  })

  it('persists conversations across restarts and restores the panel state per scope', async () => {
    const scope: AgentScope = { kind: 'note', folder: 'Work', name: 'Work/Topic.md' }
    const first = await send(app([() => reply('第一轮回复。')]), scope, '你好')
    const session = first.find(event => event.type === 'session')
    if (session?.type !== 'session') throw new Error()
    let seen: { role: string; content: string }[] = []
    const restarted = app([(_, body) => { seen = body.messages; return reply('第二轮回复。') }])
    await send(restarted, scope, '继续', session.id)
    expect(seen.map(message => message.content)).toEqual([expect.any(String), '你好', '第一轮回复。', '继续'])
    const state = await (await restarted.request('/api/ai/conversation?scope=' + encodeURIComponent(JSON.stringify(scope)), { headers: H })).json()
    expect(state).toMatchObject({ id: session.id, messages: [{ role: 'user', text: '你好' }, { role: 'assistant', text: '第一轮回复。' }, { role: 'user', text: '继续' }, { role: 'assistant', text: '第二轮回复。' }] })
    const other = await (await restarted.request('/api/ai/conversation?scope=' + encodeURIComponent(JSON.stringify({ kind: 'folder', folder: 'Work' })), { headers: H })).json()
    expect(other).toBeNull()
  })

  it('streams text deltas from an event-stream model with streamed tool calls', async () => {
    const sse = (chunks: object[]) => new Response(chunks.map(chunk => 'data: ' + JSON.stringify(chunk) + '\n\n').join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    const events = await send(app([
      () => sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'list_', arguments: '{"fol' } }] } }] }, { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'notes', arguments: 'der":"Work"}' } }] }, finish_reason: 'tool_calls' }] }]),
      result => { expect(result.total).toBe(1); return sse([{ choices: [{ delta: { content: '有 ' } }] }, { choices: [{ delta: { content: '1 篇。' }, finish_reason: 'stop' }] }]) },
    ]), { kind: 'folder', folder: 'Work' }, '有几篇？')
    expect(events.filter(event => event.type === 'delta')).toEqual([{ type: 'delta', text: '有 ' }, { type: 'delta', text: '1 篇。' }])
    expect(events).toContainEqual({ type: 'message', text: '有 1 篇。' })
  })
})
