import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { AISettings } from '../server/ai-settings'
import { ChatGPTConnection } from '../server/chatgpt'
import { Models } from '../server/models'
import { NoteAgent } from '../server/agent'
import { AgentRunService } from '../server/agent-runs'
import { NoteStore } from '../server/store'
import { NoteIndex } from '../server/note-index'
import { MemoryFiles } from '../server/memory-files'
import { ChangeEngine } from '../server/changes'
import { ConversationStore } from '../server/conversations'
import { ProposalStore } from '../server/proposals'
import { EventBus } from '../server/events'
import type { AIMessage, AITurn } from '../server/ai'
import type { AgentEvent, AgentRunDTO, AgentScope } from '../shared/types'

export type Check = { name: string; passed: boolean; detail?: string }
export type RunOptions = {
  session?: string
  stopWhen?: (event: AgentEvent) => boolean
  beforeModel?: (messages: AIMessage[], round: number) => Promise<void>
  afterModel?: (turn: AITurn, round: number) => Promise<void>
  maxCalls?: number
}
export type RunResult = { id: string; session: string; status: AgentRunDTO['status']; events: AgentEvent[]; history: AIMessage[]; modelCalls: number; elapsedMs: number; error?: string }
export type Scenario = {
  id: string; description: string; notes: Record<string, string>; scope?: AgentScope
  setup?: (ctx: EvalContext) => Promise<void>
  execute: (ctx: EvalContext) => Promise<void>
  verify: (ctx: EvalContext) => Promise<Check[]>
  humanReview?: string[]
}
export type EvalContext = {
  root: string; modelLabel: string; store: NoteStore; files: MemoryFiles; changes: ChangeEngine
  conversations: ConversationStore; turns: RunResult[]; trace: unknown[]
  run: (message: string, options?: RunOptions) => Promise<RunResult>
  read: (name: string) => Promise<string | null>
}
export type EvaluationOptions = { resumeReport?: string; continuation?: string }
type ResumeReport = { scenario: string; root: string; model: string; implementation?: unknown; trace: unknown[]; turns: RunResult[] }

/** Only explicitly selected, matching evaluations in an actual system temporary directory may resume. */
async function loadResume(scenario: Scenario, options: EvaluationOptions): Promise<ResumeReport | null> {
  if (!options.resumeReport && !options.continuation) return null
  if (!options.resumeReport || !options.continuation?.trim()) throw new Error('Resume requires both a saved evaluation report and a continuation message')
  const report = JSON.parse(await fs.readFile(options.resumeReport, 'utf8')) as ResumeReport
  if (report.scenario !== scenario.id) throw new Error('Resume report scenario does not match the selected scenario')
  if (typeof report.root !== 'string' || !Array.isArray(report.trace) || !Array.isArray(report.turns)) throw new Error('Invalid evaluation resume report')
  const [root, temporary] = await Promise.all([fs.realpath(report.root), fs.realpath(os.tmpdir())])
  if (path.dirname(root) !== temporary || !path.basename(root).startsWith('sidemind-live-' + scenario.id + '-') || !(await fs.stat(root)).isDirectory()) {
    throw new Error('Resume is restricted to this scenario’s isolated system temporary directory')
  }
  if (await fs.realpath(path.join(root, 'notes')) !== path.join(root, 'notes')) throw new Error('Resume notes must be inside the isolated evaluation directory')
  const last = report.turns.at(-1)
  if (!last?.session || typeof last.session !== 'string' || ['queued', 'running'].includes(last.status)) throw new Error('Resume report must contain a terminal run and its saved conversation session')
  return { ...report, root }
}

/** Real production model and tools, synthetic data only. No mock model replies or credential copies. */
export async function evaluate(scenario: Scenario, outputRoot: string, options: EvaluationOptions = {}) {
  const resumed = await loadResume(scenario, options)
  const root = resumed?.root ?? await fs.mkdtemp(path.join(os.tmpdir(), 'sidemind-live-' + scenario.id + '-'))
  const destination = path.join(outputRoot, scenario.id + '.json')
  await fs.mkdir(outputRoot, { recursive: true })
  if (options.resumeReport) {
    const existingDestination = await fs.realpath(destination).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (existingDestination === await fs.realpath(options.resumeReport)) throw new Error('Resume output must not overwrite its source report')
  }
  const store = new NoteStore(path.join(root, 'notes'))
  if (!resumed) {
    await store.init()
    // init creates a welcome document for people; evaluation fixtures must be exact.
    await fs.rm(path.join(store.root, 'Welcome.md'), { force: true })
    for (const [name, content] of Object.entries(scenario.notes)) {
      const full = path.join(store.root, name)
      await fs.mkdir(path.dirname(full), { recursive: true }); await fs.writeFile(full, content)
    }
  }
  const implementation = Object.fromEntries(await Promise.all(['server/agent.ts', 'server/agent-tools.ts', 'server/agent-runs.ts', 'server/chatgpt.ts'].map(async file => [file, createHash('sha256').update(await fs.readFile(file)).digest('hex')])))
  await store.list()
  const settings = new AISettings(path.resolve(process.env.SIDEMIND_EVAL_SOURCE_WORKSPACE || 'workspace'))
  const models = new Models(settings, new ChatGPTConnection(settings.file + '.chatgpt.json'))
  const resolved = await models.mainModel()
  const bus = new EventBus(), index = new NoteIndex(store)
  const files = new MemoryFiles(store.paths.memory, store.writer), changes = new ChangeEngine(store, files, bus)
  const conversations = new ConversationStore(path.join(store.paths.local, 'conversations'), store.writer)
  const proposals = new ProposalStore(store.paths.local, changes)
  const agent = new NoteAgent({ store, index, files, changes, proposals, conversations, models, bus, git: null, semantic: async () => null })
  const tasks = new Set<Promise<unknown>>()
  const runs = new AgentRunService(store, agent, { track: async task => { tasks.add(task); try { return await task } finally { tasks.delete(task) } }, pendingProposals: async ids => { const pending: string[] = []; for (const id of ids) if ((await proposals.get(id)).status === 'pending') pending.push(id); return pending } })
  const trace: unknown[] = [...(resumed?.trace ?? [])], turns: RunResult[] = [...(resumed?.turns ?? [])]
  let session: string | undefined = resumed?.turns.at(-1)?.session
  if (resumed) {
    await conversations.get(session!) // Check the session exists before requesting the real model.
    trace.push({ kind: 'resume', at: Date.now(), report: path.resolve(options.resumeReport!), session, priorTurns: turns.length, priorModel: resumed.model, priorImplementation: resumed.implementation, implementation })
  }
  const checkpoint = () => fs.writeFile(destination, JSON.stringify({ scenario: scenario.id, root, model: resolved.label, implementation, trace, turns }, null, 2))
  const ctx: EvalContext = {
    root, modelLabel: resolved.label, store, files, changes, conversations, turns, trace,
    read: name => fs.readFile(path.join(store.root, name), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error }),
    run: async (message, options = {}) => {
      let count = 0
      const startedAt = Date.now(), events: AgentEvent[] = []
      trace.push({ kind: 'user', message, at: startedAt })
      const model: typeof resolved.call = async (messages, tools, signal, onDelta) => {
        if (++count > (options.maxCalls ?? 30)) throw new Error('Live evaluation model-call limit exceeded')
        const before = Date.now()
        // Only synthetic input/output is recorded. Never headers, auth state or encrypted response items.
        trace.push({ kind: 'model-input', round: count, tools: tools.map(tool => tool.function.name), messages: messages.filter(item => item.role !== 'system').map(({ responseOutput: _, ...item }) => item) })
        await options.beforeModel?.(messages, count)
        const result = await resolved.call(messages, tools, AbortSignal.any([signal, AbortSignal.timeout(180000)]), onDelta)
        trace.push({ kind: 'model-output', round: count, elapsedMs: Date.now() - before, text: result.text, calls: result.calls })
        console.log(JSON.stringify({ scenario: scenario.id, round: count, elapsedMs: Date.now() - before, tools: result.calls.map(call => call.function.name), text: result.text.slice(0, 120) }))
        await checkpoint()
        await options.afterModel?.(result, count)
        return result
      }
      const started = await runs.start({ requestKey: crypto.randomUUID(), scope: scenario.scope ?? { kind: 'folder', folder: '' }, session: options.session ?? session, message }, model)
      await new Promise<void>(resolve => {
        let detach: (() => void) | undefined
        const receive = ({ event }: { event: AgentEvent }) => {
          events.push(event)
          if (event.type === 'session') session = event.id
          if (options.stopWhen?.(event)) void runs.stop(started.id)
          if (event.type === 'done') { detach?.(); resolve() }
        }
        const attached = runs.attach(started.id, 0, receive)
        detach = attached?.detach
        if (!attached) { resolve(); return }
        for (const entry of attached.replay) receive(entry)
      })
      await Promise.allSettled([...tasks])
      const final = await runs.get(started.id)
      const history = session ? (await conversations.get(session)).messages : []
      const result: RunResult = { id: final.id, session: session ?? '', status: final.status, events, history: history.map(({ responseOutput: _, ...item }) => item), modelCalls: count, elapsedMs: Date.now() - startedAt, ...(final.error ? { error: final.error } : {}) }
      turns.push(result); await checkpoint(); return result
    },
  }
  let failure: string | undefined, checks: Check[] = []
  try {
    if (resumed) await ctx.run(options.continuation!)
    else { await scenario.setup?.(ctx); await scenario.execute(ctx) }
    checks = await scenario.verify(ctx)
  }
  catch (error) { failure = error instanceof Error ? error.message : String(error) }
  await Promise.allSettled([...tasks])
  const notes = Object.fromEntries(await Promise.all((await store.names()).map(async name => [name, await ctx.read(name)])))
  const report = { implementation, scenario: scenario.id, description: scenario.description, model: resolved.label, root, checks, failure, humanReview: scenario.humanReview, notes, trace, turns }
  await fs.writeFile(destination, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ scenario: scenario.id, report: destination, checks, failure, calls: turns.reduce((sum, turn) => sum + turn.modelCalls, 0) }))
  return report
}
