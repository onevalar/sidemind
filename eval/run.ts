import path from 'node:path'
import { evaluate, type Scenario } from './harness'
const [moduleName, ...args] = process.argv.slice(2)
const usage = 'Usage: node --import tsx eval/run.ts <scenario-module> [case-id] [--resume <report>]'
if (!moduleName || !/^[a-z-]+$/.test(moduleName)) throw new Error(usage)
let caseId: string | undefined, resumeReport: string | undefined
for (let index = 0; index < args.length; index++) {
  const arg = args[index]!
  if (arg === '--resume' && !resumeReport && args[index + 1] && !args[index + 1]!.startsWith('--')) resumeReport = args[++index]
  else if (!arg.startsWith('--') && !caseId) caseId = arg
  else throw new Error(usage)
}
const { scenarios } = await import('./scenarios/' + moduleName + '.ts') as { scenarios: Scenario[] }
const output = path.resolve(process.env.SIDEMIND_EVAL_OUTPUT || '/tmp/sidemind-live-eval')
const selected = scenarios.filter(item => !caseId || item.id === caseId)
if (!selected.length) throw new Error('Unknown scenario: ' + caseId)
if (resumeReport && selected.length !== 1) throw new Error('Select exactly one scenario when using --resume')
let failed = false
for (const scenario of selected) {
  const report = await evaluate(scenario, output, resumeReport ? {
    resumeReport,
    continuation: '继续刚才未完成的工作。先核对已经保存的内容，不要重复新建或移动；完成剩余核验后告诉我结果。',
  } : {})
  if (report.failure || !report.checks.length || report.checks.some(check => !check.passed)) failed = true
}
if (failed) process.exitCode = 1
