import fs from 'node:fs'
import path from 'node:path'
import { Hono } from 'hono'
import { stream, streamSSE } from 'hono/streaming'
import { compress } from 'hono/compress'
import { serveStatic } from '@hono/node-server/serve-static'
import type { EventBus } from './events'
import { BadNameError, ConflictError, NotFoundError, type NoteStore } from './store'
import { AIRequestError, embed, proposeEdit } from './ai'
import { AISettings, AISettingsError, MODEL_SLOTS, type AIConnectionInput, type ModelSlot } from './ai-settings'
import { FolderOpenError, openWorkspaceFolder } from './workspace-folder'
import { ChatGPTConnection, ChatGPTError } from './chatgpt'
import { NoteAgent } from './agent'
import type { AgentEvent, AgentScope, ChangeSetDetail, PushEvent, RunEvent } from '../shared/types'
import { NoteIndex } from './note-index'
import { MemoryFiles } from './memory-files'
import { ChangeEngine, summarize } from './changes'
import { ProposalStore, detail as proposalDetail } from './proposals'
import { ConversationStore } from './conversations'
import { Models } from './models'
import { SemanticIndex } from './semantic'
import { GitError, type Git } from './git'
import { PushService } from './push'
import { memoryFile, type MemoryTarget } from './memory'
import { StorageError } from './persistence'
import { MissingRecordError, ResearchStore } from './discussions'
import { captureAnswer, contextFor } from './explore'
import { RunService } from './runs'
import { AgentRunService } from './agent-runs'

const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/

export type AppOptions = { staticDir?: string; aiSettings?: AISettings; chatgpt?: ChatGPTConnection; aiTransport?: typeof fetch; openDirectory?: (root: string) => Promise<void>; git?: Git | null; shutdown?: AbortSignal; tasks?: Set<Promise<unknown>> }

export function createApp(store: NoteStore, bus: EventBus, opts: AppOptions = {}) {
  const app = new Hono()
  // Connections are keyed by the data directory (the old notes directory before migration), outside the repo.
  const ai = opts.aiSettings ?? new AISettings(store.paths.root)
  const chatgpt = opts.chatgpt ?? new ChatGPTConnection(ai.file + '.chatgpt.json', { transport: opts.aiTransport })
  const git = opts.git ?? null
  const index = new NoteIndex(store)
  const files = new MemoryFiles(store.paths.memory, store.writer)
  const changes = new ChangeEngine(store, files, bus)
  const proposals = new ProposalStore(store.paths.local, changes)
  const conversations = new ConversationStore(path.join(store.paths.local, 'conversations'), store.writer)
  const research = new ResearchStore(store)
  const runs = new RunService(store, research, { track: task => track(task), shutdown: opts.shutdown })
  const track = async <T>(task: Promise<T>): Promise<T> => {
    opts.tasks?.add(task)
    try { return await task } finally { opts.tasks?.delete(task) }
  }
  const models = new Models(ai, chatgpt, opts.aiTransport)
  let semantic: SemanticIndex | null = null
  const semanticIndex = async () => {
    const embedder = await models.embedder()
    if (!embedder) return null
    if (semantic?.model !== embedder.model) semantic = new SemanticIndex(index, embedder, path.join(store.paths.cache, 'embeddings.json'))
    return semantic
  }
  const agent = new NoteAgent({ store, index, files, changes, proposals, git, models, conversations, bus, semantic: semanticIndex })
  const agentRuns = new AgentRunService(store, agent, { track: task => track(task), shutdown: opts.shutdown, guard: () => { if (syncing) throw new ConflictError('正在同步笔记和对话记忆，请完成后再发送。') } })
  const pusher = new PushService({ store, files, git, models, conversations, index, bus })
  let syncing = false
  const slotOf = (value: string | undefined): ModelSlot => { if (value === undefined) return 'main'; if (!MODEL_SLOTS.includes(value as ModelSlot)) throw new BadNameError('模型槽位无效。'); return value as ModelSlot }
  const settingsFor = (slot: ModelSlot) => slot === 'main' ? ai : ai.forSlot(slot)

  // This server can read and write files on the user's machine and has no login, so:
  //  - only answer requests addressed to localhost (blocks DNS-rebinding from other sites)
  //  - only accept JSON bodies (a cross-site form/fetch can't send that without a CORS preflight)
  app.use('*', async (c, next) => {
    if (!LOCAL_HOSTS.test(c.req.header('host') ?? '')) return c.text('Forbidden', 403)
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      if (!(c.req.header('content-type') ?? '').startsWith('application/json')) {
        return c.text('Expected application/json', 415)
      }
    }
    if (opts.shutdown?.aborted) return c.json({ error: '服务正在停止，请稍后重试。' }, 503)
    await track((async () => { await changes.recover(); await runs.recover(); await agentRuns.recover(); await next() })())
  })

  app.onError((err, c) => {
    if (err instanceof BadNameError) return c.json({ error: err.message }, 400)
    if (err instanceof MissingRecordError) return c.json({ error: err.message }, 404)
    if (err instanceof NotFoundError) return c.json({ error: 'Note not found' }, 404)
    if (err instanceof ConflictError) return c.json({ error: err.message }, 409)
    if (err instanceof StorageError) return c.json({ error: err.message }, 503)
    if (err instanceof AISettingsError) return c.json({ error: err.message }, 400)
    if (err instanceof ChatGPTError) return c.json({ error: err.message }, 502)
    if (err instanceof FolderOpenError) return c.json({ error: err.message }, 503)
    if (err instanceof GitError) return c.json({ error: err.message }, 502)
    console.error(err)
    return c.json({ error: 'Internal error' }, 500)
  })

  app.get('/api/notes', async (c) => c.json(await store.list()))
  app.get('/api/folders', async (c) => c.json(await store.folders()))
  app.post('/api/folders', async (c) => {
    const body = await c.req.json().catch(() => null)
    if (typeof body?.folder !== 'string') return c.json({ error: '请输入文件夹名称。' }, 400)
    await store.createFolder(body.folder)
    bus.emit({ type: 'notes-changed' })
    return c.json({ ok: true }, 201)
  })
  app.put('/api/canvas/positions', async (c) => {
    const body = await c.req.json().catch(() => null)
    if (!body?.positions) return c.json({ error: '请提供文章位置。' }, 400)
    await store.savePositions(body.positions)
    bus.emit({ type: 'notes-changed' })
    return c.json({ ok: true })
  })
  app.get('/api/canvas', async (c) => c.json(await store.canvas(c.req.query('folder') ?? '')))
  app.put('/api/canvas', async (c) => {
    const body = await c.req.json().catch(() => null)
    if (typeof body?.folder !== 'string') return c.json({ error: '请选择画布文件夹。' }, 400)
    const layout = await store.saveCanvas(body.folder, body.frames, body.positions, body.expectedFrames)
    bus.emit({ type: 'canvas-changed', folder: body.folder })
    return c.json(layout)
  })
  // Unified discussions: frozen sources, discussion graphs, multi-question drafts and capture records.
  const object = async (c: { req: { json: () => Promise<unknown> } }) => {
    const body = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadNameError('请求内容无效。')
    return body as Record<string, any>
  }
  app.post('/api/sources', async (c) => { const body = await object(c); return c.json(await research.createSource({ note: body.note, quote: body.quote, start: body.start }), 201) })
  app.get('/api/sources/:id', async (c) => c.json(await research.resolveSource(c.req.param('id'))))
  app.get('/api/research/note', async (c) => {
    const view = await research.forNote(c.req.query('name') ?? '')
    const turns = new Set(view.discussions.flatMap(discussion => discussion.turns.map(turn => turn.id)))
    return c.json({ ...view, runs: await runs.unfinished(turns) })
  })
  app.get('/api/discussions', async (c) => c.json(await research.listDiscussions(c.req.query('archived') === undefined ? {} : { archived: c.req.query('archived') === 'true' })))
  app.post('/api/discussions', async (c) => { const body = await object(c); return c.json(await research.createDiscussion({ title: body.title, origin: body.origin }), 201) })
  app.get('/api/discussions/:id', async (c) => c.json(await research.getDiscussion(c.req.param('id'))))
  app.put('/api/discussions/:id/archived', async (c) => { const body = await object(c); if (typeof body.archived !== 'boolean') throw new BadNameError('请指定是否归档。'); return c.json(await research.setArchived(c.req.param('id'), body.archived)) })
  app.get('/api/drafts', async (c) => { const discussion = c.req.query('discussion'); return c.json(await research.listDrafts(discussion === undefined ? undefined : discussion === '' ? null : discussion)) })
  app.post('/api/drafts', async (c) => { const body = await object(c); return c.json(await research.createDraft(body), 201) })
  app.get('/api/drafts/:id', async (c) => c.json(await research.getDraft(c.req.param('id'))))
  app.patch('/api/drafts/:id', async (c) => {
    const { revision, ...patch } = await object(c)
    if (!Number.isInteger(revision)) throw new BadNameError('请提供草稿修订号。')
    return c.json(await research.updateDraft(c.req.param('id'), revision, patch))
  })
  app.delete('/api/drafts/:id', async (c) => {
    const revision = Number(c.req.query('revision'))
    if (!Number.isInteger(revision)) throw new BadNameError('请提供草稿修订号。')
    await research.deleteDraft(c.req.param('id'), revision)
    return c.json({ ok: true })
  })
  app.post('/api/drafts/:id/send', async (c) => c.json(await research.sendDraft(c.req.param('id'), (await object(c)).items), 201))
  app.post('/api/discussions/:id/turns/:turn/runs', async (c) => {
    const body = await object(c)
    let model: Awaited<ReturnType<Models['mainModel']>>['call']
    try { model = (await models.mainModel()).call }
    catch (error) { return c.json({ error: error instanceof ChatGPTError || error instanceof AISettingsError || error instanceof AIRequestError ? error.message : '无法读取模型连接。' }, 502) }
    return c.json(await runs.start({ discussionId: c.req.param('id'), turnId: c.req.param('turn'), requestKey: body.requestKey }, model), 202)
  })
  app.get('/api/discussions/:id/turns/:turn/context', async (c) => {
    const discussion = await research.getDiscussion(c.req.param('id'))
    const turn = discussion.turns.find(item => item.id === c.req.param('turn'))
    if (!turn) throw new MissingRecordError('找不到这个问题节点。')
    return c.json(await contextFor(research, discussion, turn))
  })
  app.get('/api/runs/:id', async (c) => c.json(await runs.get(c.req.param('id'))))
  app.post('/api/runs/:id/stop', async (c) => c.json(await runs.stop(c.req.param('id'))))
  app.get('/api/runs/:id/events', async (c) => {
    // Validate and read before opening the stream so a bad id is a normal 4xx response.
    await runs.get(c.req.param('id'))
    return streamSSE(c, async (stream) => {
      let closed = false
      const queue: RunEvent[] = []
      let wake: (() => void) | null = null
      const { run, unsubscribe } = await runs.subscribe(c.req.param('id'), event => { queue.push(event); wake?.() })
      stream.onAbort(() => { closed = true; unsubscribe(); wake?.() })
      await stream.writeSSE({ event: 'snapshot', id: String(run.seq), data: JSON.stringify(run) })
      let ended = ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)
      while (!closed && !ended) {
        if (!queue.length) await Promise.race([new Promise<void>(resolve => { wake = resolve }), stream.sleep(15000)])
        wake = null
        for (const event of queue.splice(0)) {
          await stream.writeSSE({ event: event.type, id: String(event.seq), data: JSON.stringify(event) })
          if (event.type === 'status' && event.run.status !== 'running' && event.run.status !== 'queued') ended = true
        }
        if (!closed && !ended && !queue.length) await stream.writeSSE({ event: 'ping', data: '' })
      }
      unsubscribe()
    })
  })
  app.post('/api/captures', async (c) => {
    const body = await object(c)
    const result = await track(captureAnswer(store, research, changes, body as Parameters<typeof captureAnswer>[3]))
    return c.json(result, 201)
  })
  app.get('/api/captures', async (c) => c.json(await research.listCaptures(c.req.query('note'))))
  app.get('/api/captures/:id', async (c) => c.json(await research.getCapture(c.req.param('id'))))
  app.get('/api/search', async (c) => c.json(await store.search((c.req.query('q') ?? '').slice(0, 300))))
  app.get('/api/settings', async (c) => c.json({ notesDirectory: store.root, dataDirectory: store.paths.root, ai: await ai.publicConfig(), summary: await ai.forSlot('summary').publicConfig(), embedding: await ai.forSlot('embedding').publicConfig(), chatgpt: await chatgpt.publicConfig() }))
  app.post('/api/workspace/open', async (c) => {
    const body = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'folder') || body.folder !== undefined && typeof body.folder !== 'string') return c.json({ error: '请选择笔记工作区内的文件夹。' }, 400)
    const directory = await store.folderPath(body.folder ?? '')
    await (opts.openDirectory ?? openWorkspaceFolder)(directory)
    return c.json({ ok: true })
  })
  app.put('/api/ai/connection', async (c) => c.json(await settingsFor(slotOf(c.req.query('slot'))).save(await c.req.json().catch(() => null))))
  app.delete('/api/ai/connection', async (c) => c.json(await settingsFor(slotOf(c.req.query('slot'))).clear()))
  app.get('/api/ai/chatgpt', async (c) => c.json(await chatgpt.publicConfig()))
  app.get('/api/ai/chatgpt/models', async (c) => c.json(await chatgpt.models()))
  app.post('/api/ai/chatgpt/login', async (c) => {
    // The official callback returns to the computer running this service, not a remote portal.
    let origin: URL
    try { origin = new URL(c.req.header('origin') ?? c.req.url) } catch { return c.json({ error: '请在本机打开应用后登录。' }, 400) }
    if (!LOCAL_HOSTS.test(origin.host) || !['http:', 'https:'].includes(origin.protocol)) return c.json({ error: 'ChatGPT 登录需在运行笔记服务的同一台电脑完成。远程预览不支持此回调。' }, 400)
    const body = await c.req.json().catch(() => null)
    if (!body || (body.accountId !== undefined && typeof body.accountId !== 'string')) return c.json({ error: '请选择 ChatGPT 账号。' }, 400)
    c.header('Cache-Control', 'no-store')
    return c.json(await chatgpt.startLogin(body.accountId))
  })
  app.delete('/api/ai/chatgpt/login', async (c) => { await chatgpt.cancelLogin(); return c.json(await chatgpt.publicConfig()) })
  app.put('/api/ai/chatgpt/account', async (c) => {
    const body = await c.req.json().catch(() => null)
    if (!body || (body.accountId !== null && typeof body.accountId !== 'string') || (body.model !== undefined && typeof body.model !== 'string')) return c.json({ error: '请选择账号和模型。' }, 400)
    return c.json(await chatgpt.select(body.accountId, body.model))
  })
  app.post('/api/ai/chatgpt/logout', async (c) => {
    const body = await c.req.json().catch(() => null)
    if (typeof body?.accountId !== 'string') return c.json({ error: '请选择要退出的账号。' }, 400)
    return c.json(await chatgpt.signOut(body.accountId))
  })
  app.post('/api/ai/test', async (c) => {
    const slot = slotOf(c.req.query('slot'))
    const connection = await settingsFor(slot).resolve(await c.req.json().catch(() => null) as AIConnectionInput)
    try {
      if (slot === 'embedding') await embed(connection, ['连接测试'], c.req.raw.signal, opts.aiTransport)
      else await proposeEdit(connection, 'Connection test.', 'Return the supplied text unchanged.', c.req.raw.signal, opts.aiTransport)
      return c.json({ ok: true })
    } catch { return c.json({ error: '连接测试未通过，请检查地址、模型名称和密钥。' }, 502) }
  })
  const agentRequest = async (c: { req: { json: () => Promise<any> }; json: (body: unknown, status?: any) => Response }) => {
    const body = await c.req.json().catch(() => null)
    if (!body || typeof body.message !== 'string' || !body.message.trim() || body.message.length > 16000 || !['chat', 'note', 'folder'].includes(body.scope?.kind) || typeof body.scope?.folder !== 'string' || (body.scope.kind === 'note' && typeof body.scope.name !== 'string') || (body.session !== undefined && typeof body.session !== 'string') || (body.selection !== undefined && (typeof body.selection !== 'string' || body.selection.length > 20000))) return { error: c.json({ error: '请输入消息并选择对话范围。' }, 400) }
    const scope: AgentScope = body.scope.kind === 'note' ? { kind: 'note', folder: body.scope.folder, name: body.scope.name } : { kind: body.scope.kind, folder: body.scope.kind === 'chat' ? '' : body.scope.folder }
    let model: Awaited<ReturnType<Models['mainModel']>>['call']
    try { model = (await models.mainModel()).call }
    catch (error) { return { error: c.json({ error: error instanceof ChatGPTError || error instanceof AISettingsError || error instanceof AIRequestError ? error.message : '无法读取模型连接。' }, 502) } }
    return { body, scope, model }
  }
  // Agent runs: accepted once recorded, events can be reattached, and nothing is cancelled by disconnecting. Only Stop stops one.
  app.post('/api/agent-runs', async (c) => {
    const parsed = await agentRequest(c)
    if (parsed.error) return parsed.error
    const { body, scope, model } = parsed
    if (typeof body.requestKey !== 'string') return c.json({ error: '请提供请求键。' }, 400)
    return c.json(await agentRuns.start({ requestKey: body.requestKey, scope, session: body.session, message: body.message.trim(), selection: body.selection }, model), 202)
  })
  app.get('/api/agent-runs/:id', async (c) => c.json(await agentRuns.get(c.req.param('id'))))
  app.post('/api/agent-runs/:id/stop', async (c) => c.json(await agentRuns.stop(c.req.param('id'))))
  app.get('/api/agent-runs/:id/events', async (c) => {
    const run = await agentRuns.get(c.req.param('id'))
    const after = Number(c.req.header('last-event-id') ?? c.req.query('after') ?? 0) || 0
    return streamSSE(c, async (sse) => {
      let closed = false, wake: (() => void) | null = null
      const queue: { seq: number; event: AgentEvent }[] = []
      const attached = agentRuns.attach(run.id, after, entry => { queue.push(entry); wake?.() })
      sse.onAbort(() => { closed = true; attached?.detach(); wake?.() })
      // No id on the snapshot: a reconnect must resume from the last real event, not from the snapshot's position.
      await sse.writeSSE({ event: 'snapshot', data: JSON.stringify(attached?.run ?? run) })
      if (!attached) return
      queue.push(...attached.replay)
      let ended = queue.some(entry => entry.event.type === 'done')
      while (!closed && (!ended || queue.length)) {
        if (!queue.length) { await Promise.race([new Promise<void>(resolve => { wake = resolve }), sse.sleep(15000)]); wake = null; if (!queue.length && !closed && !ended) await sse.writeSSE({ event: 'ping', data: '' }); continue }
        const entry = queue.shift()!
        await sse.writeSSE({ event: 'agent', id: String(entry.seq), data: JSON.stringify(entry) })
        if (entry.event.type === 'done') ended = true
      }
      attached.detach()
    })
  })
  const parseScope = (raw: string | undefined): AgentScope => {
    let scope: AgentScope
    try { scope = JSON.parse(raw ?? '') } catch { throw new BadNameError('对话范围无效。') }
    if (!scope || !['chat', 'note', 'folder'].includes(scope.kind) || typeof scope.folder !== 'string' || (scope.kind === 'note' && typeof scope.name !== 'string')) throw new BadNameError('对话范围无效。')
    return scope.kind === 'note' ? { kind: 'note', folder: scope.folder, name: scope.name } : { kind: scope.kind, folder: scope.kind === 'chat' ? '' : scope.folder }
  }
  app.get('/api/ai/conversation', async c => {
    const state = await agent.state(parseScope(c.req.query('scope')))
    const activeRun = state ? agentRuns.runForSession(state.id) : null
    return c.json(state && activeRun ? { ...state, activeRun } : state)
  })
  app.get('/api/ai/changes', async c => c.json(await changes.list({ folder: c.req.query('folder') || undefined, name: c.req.query('name') || undefined, conversation: c.req.query('conversation') || undefined })))
  app.get('/api/ai/changes/:id', async c => {
    const set = await changes.get(c.req.param('id'))
    const result: ChangeSetDetail = { ...summarize(set, await changes.undoable(set)), diffs: set.files.map(({ area, name, before, after }) => ({ area, name, before, after })) }
    return c.json(result)
  })
  app.post('/api/ai/changes/:id/undo', async c => c.json(summarize(await changes.undo(c.req.param('id')), false)))
  app.get('/api/ai/proposals', async c => c.json(await proposals.list(c.req.query('status') as never || undefined)))
  app.get('/api/ai/proposals/:id', async c => c.json(proposalDetail(await proposals.get(c.req.param('id')))))
  app.post('/api/ai/proposals/:id/accept', async c => {
    const { proposal, changeset } = await proposals.accept(c.req.param('id'))
    return c.json({ proposal, changeset: summarize(changeset, await changes.undoable(changeset)) })
  })
  app.post('/api/ai/proposals/:id/reject', async c => c.json(await proposals.reject(c.req.param('id'))))

  const memoryTarget = (target: unknown, name: unknown): MemoryTarget => {
    if (target === 'library') return { kind: 'library' }
    if (target === 'folder' && typeof name === 'string') return { kind: 'folder', folder: name }
    if (target === 'note' && typeof name === 'string' && name) return { kind: 'note', name }
    throw new BadNameError('记忆目标无效。')
  }
  app.get('/api/memory', async c => {
    const target = memoryTarget(c.req.query('target'), c.req.query('name') ?? '')
    if (target.kind === 'note') await store.load(target.name)
    if (target.kind === 'folder') await store.folderPath(target.folder)
    const file = memoryFile(target), content = await files.read(file)
    return c.json({ target: target.kind, name: target.kind === 'note' ? target.name : target.kind === 'folder' ? target.folder : '', file, content: content ?? '', exists: content !== null })
  })
  app.put('/api/memory', async c => {
    const body = await c.req.json().catch(() => null)
    if (!body || typeof body.content !== 'string' || body.content.length > 200000 || (body.expected !== null && typeof body.expected !== 'string')) return c.json({ error: '请提供记忆内容。' }, 400)
    const target = memoryTarget(body.target, body.name)
    if (target.kind === 'note') await store.load(target.name)
    if (target.kind === 'folder') await store.folderPath(target.folder)
    // A direct edit by the user: written to the working tree and committed with the next push.
    await files.replaceFile(memoryFile(target), body.expected, body.content.trim() ? body.content : null)
    bus.emit({ type: 'memory-changed' })
    return c.json({ ok: true })
  })

  app.get('/api/repo/status', async c => c.json(await pusher.status()))
  app.put('/api/repo/remote', async c => {
    const body = await c.req.json().catch(() => null)
    if (!body || (body.url !== null && typeof body.url !== 'string')) return c.json({ error: '请填写远端仓库地址。' }, 400)
    return c.json(await pusher.setRemote(body.url || null))
  })
  app.post('/api/repo/push', async c => {
    c.header('Content-Type', 'application/x-ndjson')
    c.header('Cache-Control', 'no-store')
    return stream(c, async output => {
      const controller = new AbortController()
      output.onAbort(() => controller.abort())
      const signal = AbortSignal.any([controller.signal, c.req.raw.signal, AbortSignal.timeout(1800000), ...(opts.shutdown ? [opts.shutdown] : [])])
      const emit = async (event: PushEvent) => { if (!output.aborted) await output.write(JSON.stringify(event) + '\n') }
      try {
        if (agentRuns.busy || syncing) throw new ConflictError('助手任务或同步仍在进行，请完成后再同步。')
        syncing = true
        try { await track(store.writer.run(() => pusher.push(emit, signal))) }
        finally { syncing = false }
      }
      catch (error) {
        if (!(error instanceof GitError || error instanceof ConflictError || error instanceof AIRequestError || error instanceof ChatGPTError)) console.error(error)
        await emit({ type: 'error', text: signal.aborted ? '同步已停止。已更新的记忆保留在工作区，下次同步时一起提交。' : error instanceof GitError || error instanceof ConflictError || error instanceof AIRequestError || error instanceof ChatGPTError ? error.message : '同步失败，请稍后重试。' })
      } finally { await emit({ type: 'done' }) }
    })
  })
  app.post('/api/ai/propose', async (c) => {
    const body = await c.req.json().catch(() => null)
    if (!body || typeof body.source !== 'string' || typeof body.instruction !== 'string' || !body.source.trim() || !body.instruction.trim() || body.source.length > 100000 || body.instruction.length > 5000) return c.json({ error: '请选择内容并输入修改要求。' }, 400)
    try {
      const config = await chatgpt.publicConfig()
      if (config.unavailable) throw new ChatGPTError(config.error ?? '无法读取 ChatGPT 连接，请检查设置。')
      const replacement = config.activeAccountId ? await chatgpt.propose(body.source, body.instruction, c.req.raw.signal) : await proposeEdit(await ai.connection(), body.source, body.instruction, c.req.raw.signal, opts.aiTransport)
      return c.json({ replacement })
    } catch (e) { return c.json({ error: e instanceof ChatGPTError || e instanceof AISettingsError || e instanceof AIRequestError ? e.message : '无法连接模型服务，请检查设置后重试。' }, 502) }
  })

  app.post('/api/notes', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    if (body?.content !== undefined && (typeof body.content !== 'string' || body.content.length > 2000000)) return c.json({ error: 'Invalid content' }, 400)
    if (body?.folder !== undefined && typeof body.folder !== 'string') return c.json({ error: '文件夹路径无效。' }, 400)
    const name = await store.create(typeof body?.name === 'string' ? body.name : undefined, body?.content, body?.folder)
    bus.emit({ type: 'notes-changed' })
    return c.json({ name }, 201)
  })

  app.get('/api/notes/:name', async (c) => c.json(await store.load(c.req.param('name'))))
  app.get('/api/notes/:name/identity', async (c) => c.json(await store.identity(c.req.param('name'))))

  app.put('/api/notes/:name/content', async (c) => {
    const body = await c.req.json().catch(() => null)
    if (!body || typeof body.content !== 'string' || typeof body.expectedContent !== 'string' || body.content.length > 2000000) return c.json({ error: 'content and expectedContent required' }, 400)
    const name = c.req.param('name')
    await store.saveContent(name, body.content, body.expectedContent)
    bus.emit({ type: 'note-changed', name }); bus.emit({ type: 'notes-changed' })
    return c.json(await store.load(name))
  })

  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      let closed = false
      const unsubscribe = bus.subscribe((event) => {
        if (!closed) void stream.writeSSE({ data: JSON.stringify(event) })
      })
      stream.onAbort(() => {
        closed = true
        unsubscribe()
      })
      await stream.writeSSE({ data: JSON.stringify({ type: 'hello' }) })
      // Keep the connection alive until the browser goes away.
      while (!closed) {
        await stream.sleep(15000)
        if (!closed) await stream.writeSSE({ event: 'ping', data: '' })
      }
    }),
  )

  // Production: serve the built frontend from the same origin.
  if (opts.staticDir && fs.existsSync(opts.staticDir)) {
    const rel = path.relative(process.cwd(), opts.staticDir)
    // Compress only built resources, never the live event stream or note responses.
    app.use('/assets/*', compress())
    app.use('/*', serveStatic({ root: rel }))
    app.get('*', serveStatic({ path: path.join(rel, 'index.html') }))
  }

  return app
}
