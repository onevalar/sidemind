import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RunResult, Check } from './harness'

type Call = { id: string; function: { name: string; arguments: string } }
type Trace = { kind: string; messages?: RunResult['history']; calls?: Call[]; text?: string; elapsedMs?: number }
type Report = {
  scenario: string; model: string; implementation?: Record<string, string>; failure?: string
  checks: Check[]; trace: Trace[]; turns: RunResult[]; notes?: Record<string, string>
}
const writes = new Set(['edit_note', 'edit_section', 'rewrite_note', 'create_note', 'batch_replace', 'rename_note', 'batch_rename', 'move_notes', 'rename_folder', 'delete_notes', 'split_note', 'arrange_notes', 'create_frame', 'update_frame', 'dissolve_frame', 'layout_groups', 'remember', 'revise_memory'])
const reads = new Set(['workspace_context', 'list_notes', 'search_notes', 'read_note', 'read_section', 'read_memory', 'note_history', 'note_diff', 'note_links', 'read_canvas', 'semantic_search', 'related_notes'])
const presentation = new Set(['update_plan', 'focus_notes'])

/** Comparable trace metrics, not provider token usage or an automated semantic quality score. */
export function analyze(report: Report) {
  const outputs = report.trace.filter(item => item.kind === 'model-output')
  const calls = outputs.flatMap(item => item.calls ?? [])
  const histogram: Record<string, number> = {}
  for (const call of calls) histogram[call.function.name] = (histogram[call.function.name] ?? 0) + 1
  const toolResults = new Map(report.turns.flatMap(turn => turn.history.filter(item => item.role === 'tool').map(item => [item.tool_call_id, item.content] as const)))
  const errors: { tool: string; code: string; error: string }[] = []
  for (const call of calls) {
    const raw = toolResults.get(call.id)
    if (typeof raw !== 'string') continue
    try {
      const parsed = JSON.parse(raw)
      if (parsed?.error) errors.push({ tool: call.function.name, code: parsed.code ?? 'unknown', error: String(parsed.error) })
    } catch { /* The trace preserves any non-JSON result for manual review. */ }
  }
  const only = (names: Set<string>) => outputs.filter(item => item.calls?.length && item.calls.every(call => names.has(call.function.name))).length
  const lastWriteCall = calls.reduce((last, call, index) => writes.has(call.function.name) ? index : last, -1)
  return {
    scenario: report.scenario, model: report.model, implementation: report.implementation,
    terminalStatuses: report.turns.map(turn => turn.status), runtimeFailure: report.failure ?? report.turns.find(turn => turn.error)?.error ?? null,
    checksPassed: report.checks.filter(check => check.passed).length, checksTotal: report.checks.length,
    failedChecks: report.checks.filter(check => !check.passed),
    modelCalls: report.turns.reduce((sum, turn) => sum + turn.modelCalls, 0), completedModelResponses: outputs.length,
    elapsedMs: report.turns.reduce((sum, turn) => sum + turn.elapsedMs, 0),
    completedModelResponseMs: outputs.reduce((sum, item) => sum + (item.elapsedMs ?? 0), 0),
    // Captured synthetic conversation only; excludes system prompts, schemas, opaque reasoning and protocol overhead.
    maxConversationChars: Math.max(0, ...report.trace.filter(item => item.kind === 'model-input').map(item => (item.messages ?? []).reduce((sum, message) => sum + (message.content?.length ?? 0) + JSON.stringify(message.tool_calls ?? '').length, 0))),
    capturedInputChars: report.trace.filter(item => item.kind === 'model-input').reduce((sum, item) => sum + JSON.stringify(item.messages ?? []).length, 0),
    capturedOutputChars: outputs.reduce((sum, item) => sum + (item.text?.length ?? 0) + JSON.stringify(item.calls ?? []).length, 0),
    // Calls are model requests; errors/cancellation may prevent their successful execution.
    toolCalls: calls.length, toolHistogram: histogram,
    readToolCalls: calls.filter(call => reads.has(call.function.name)).length,
    writeToolCalls: calls.filter(call => writes.has(call.function.name)).length,
    planOnlyRounds: only(new Set(['update_plan'])), focusOnlyRounds: only(new Set(['focus_notes'])), presentationOnlyRounds: only(presentation),
    mixedPresentationRounds: outputs.filter(item => item.calls?.some(call => presentation.has(call.function.name)) && item.calls.some(call => !presentation.has(call.function.name))).length,
    postWriteReadToolCalls: calls.slice(lastWriteCall + 1).filter(call => reads.has(call.function.name)).length,
    toolErrors: errors,
    noteChars: Object.fromEntries(Object.entries(report.notes ?? {}).map(([name, content]) => [name, content.length])),
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length < 3) throw new Error('Usage: node --import tsx eval/analyze.ts <report.json> [...]')
  for (const filename of process.argv.slice(2)) {
    const report = JSON.parse(await fs.readFile(filename, 'utf8')) as Report
    console.log(JSON.stringify({ report: path.resolve(filename), ...analyze(report) }))
  }
}
