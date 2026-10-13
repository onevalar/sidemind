import fs from 'node:fs/promises'
import path from 'node:path'
import { backupRepository } from './backup'
import { importLegacyConversations, legacyPreflight, verifyLegacyImport } from './import-legacy'
import { importChatGit, preflight, readBatch, rollbackImport, verifyImport, type Issue, type Preflight } from './import-chatgit'
import { ResearchStore } from './discussions'
import { openDataRepo, repoPaths } from './repo'
import { NoteStore } from './store'
import { acquireWorkspace } from './workspace-lock'

const usage = `Import ChatGit canvases into a Sidemind data directory — offline: the server MUST be stopped.
Reads a mongoexport copy (chatgit_canvases.json + chatgit_nodes.json). Never reads credentials and never calls a model.

  tsx server/import-cli.ts preflight <export-dir>
      Read-only report: counts, illegal edges, orphans, attachments, what cannot be migrated. Writes nothing.
  tsx server/import-cli.ts import <export-dir> <data-dir> [--backup <new-backup-dir>]
      Imports into <data-dir> (created if it does not exist), then verifies. An existing data directory requires
      --backup: a full backup is made and checked before anything is written. Safe to repeat or resume.
  tsx server/import-cli.ts verify <export-dir> <data-dir>
      Compares the export with the store node by node (counts, edges, text checksums, drafts, unfinished answers).
  tsx server/import-cli.ts rollback <batch-id> <data-dir> [--backup <new-backup-dir>]
      Removes what a batch created, keeping a full archive first. Refused while a note cites an imported answer.

Old Canvas Note history (the Agent's linear conversations) can be mapped onto read-only discussions in the same data directory:
  tsx server/import-cli.ts legacy-preflight <data-dir>
      Read-only: lists readable and corrupt conversations, missing or unlinked change records, proposals. Writes nothing.
  tsx server/import-cli.ts legacy-import <data-dir> --backup <new-backup-dir>
  tsx server/import-cli.ts legacy-verify <data-dir>
      Rollback of a batch is the same \`rollback\` command (batch ids start with legacy-). Original records are never modified.

Exit status is non-zero when the export has errors, a canvas conflicts, verification fails or a rollback is refused.`

const legacyCommands = ['legacy-preflight', 'legacy-import', 'legacy-verify']
const mark = { error: '✗', warning: '!', info: '·' } as const
const show = (issue: Issue) => console.log(`  ${mark[issue.severity]} [${issue.code}] ${issue.where}: ${issue.message}`)
function report(result: Preflight) {
  const c = result.counts
  console.log(`导出 ${result.digest.slice(0, 16)}：${c.canvases} 个画布，${c.nodes} 个节点，${c.drafts} 个草稿（${c.draftItems} 条），状态 ${JSON.stringify(c.byStatus)}，摘要 ${c.withSummary}，附件 ${c.withFiles}，建议 ${c.withSuggestions}`)
  for (const canvas of result.canvases) console.log(`  - ${canvas.name || '（无名）'} [${canvas.canvasId}] → ${canvas.status === 'importable' ? '可导入' : '跳过：' + canvas.reason}（${canvas.nodes} 个节点，${canvas.drafts} 个草稿）`)
  console.log(`问题 ${result.issues.length} 条（错误 ${result.issues.filter(i => i.severity === 'error').length}，警告 ${result.issues.filter(i => i.severity === 'warning').length}）：`)
  result.issues.forEach(show)
}

async function exists(directory: string) { try { return (await fs.readdir(directory)).length > 0 } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error } }

async function open(dataDir: string) {
  const { paths } = await openDataRepo(dataDir, { git: false })
  const store = new NoteStore(paths)
  await store.init()
  return { store, research: new ResearchStore(store) }
}

async function withBackup(dataDir: string, backup: string | undefined, existed: boolean) {
  if (!existed) return
  if (!backup) throw new Error('目标目录已有数据：请用 --backup <新的备份目录> 先做完整备份，再导入。')
  const made = await backupRepository(dataDir, backup)
  console.log(`备份已完成并校验：${made.root}（${made.files} 个文件，${made.directories} 个目录）`)
}

async function legacy(command: string, dataDir: string, backup: string | undefined) {
  if (command === 'legacy-preflight') {
    // Read-only and without opening the repository, which could migrate or create files.
    const report = await legacyPreflight(repoPaths(dataDir))
    const c = report.counts
    console.log(`旧对话：${c.conversations} 个文件，${c.readable} 个可读，${c.transcriptTurns} 轮问答；修改记录 ${c.changesets}，提案 ${c.proposals}，v0.2 改动记录 ${c.legacyAgentChanges}`)
    for (const item of report.conversations) console.log(`  - ${item.id} [${item.scope.kind}${item.scope.kind === 'note' ? ':' + item.scope.name : ''}] → ${item.status === 'importable' ? '可导入' : '跳过：' + item.reason}（${item.turns} 轮）`)
    console.log(`问题 ${report.issues.length} 条：`); report.issues.forEach(show)
    if (report.issues.some(issue => issue.severity === 'error')) process.exitCode = 1
    return
  }
  console.error('Offline operation: the server MUST be stopped and all external editors paused.')
  if (!await exists(dataDir)) throw new Error('数据目录不存在或为空。')
  const release = await acquireWorkspace(dataDir)
  try {
    if (command === 'legacy-import') await withBackup(dataDir, backup, true)
    const { store, research } = await open(dataDir)
    if (command === 'legacy-import') {
      const result = await importLegacyConversations(store, research)
      console.log(`导入批次 ${result.batch}${result.resumed ? '（接着上次继续）' : ''}：新建 ${result.totals.created}，已存在且相同 ${result.totals.identical}，冲突 ${result.totals.conflict}，跳过 ${result.totals.skipped}`)
      result.issues.forEach(show)
      for (const item of result.items) console.log(`  - ${item.id}：${item.result}${item.reason ? '（' + item.reason + '）' : ''}，${item.turns} 轮 / ${item.answers} 个回答`)
      if (result.totals.conflict) process.exitCode = 1
    }
    const verified = await verifyLegacyImport(store, research)
    console.log(`核对：${verified.ok ? '全部一致' : '有不一致'} —— ${JSON.stringify(verified.checked)}`)
    verified.mismatches.forEach(item => console.log(`  ✗ ${item.where}: ${item.message}`))
    if (!verified.ok) process.exitCode = 1
  } finally { await release() }
}

async function main() {
  const args = process.argv.slice(2)
  const flag = args.indexOf('--backup'), backup = flag >= 0 ? args[flag + 1] : undefined
  if (flag >= 0) args.splice(flag, 2)
  const [command, first, second, ...extra] = args
  if (legacyCommands.includes(command ?? '')) {
    if (!first || second || extra.length) { console.error(usage); process.exitCode = 1; return }
    await legacy(command!, path.resolve(first), backup)
    return
  }
  if (extra.length || !['preflight', 'import', 'verify', 'rollback'].includes(command ?? '') || !first || (command !== 'preflight' && !second)) { console.error(usage); process.exitCode = 1; return }
  if (command === 'preflight') {
    const result = await preflight(path.resolve(first))
    report(result)
    if (result.issues.some(issue => issue.severity === 'error')) process.exitCode = 1
    return
  }
  const dataDir = path.resolve(second!)
  console.error('Offline operation: the server MUST be stopped and all external editors paused.')
  const existed = await exists(dataDir)
  await fs.mkdir(dataDir, { recursive: true })
  const release = await acquireWorkspace(dataDir)
  try {
    if (command === 'import') {
      const found = await preflight(path.resolve(first))
      report(found)
      if (found.issues.some(issue => issue.severity === 'error')) { console.error('预检发现错误，未写入任何内容。'); process.exitCode = 1; return }
      await withBackup(dataDir, backup, existed)
      const { store, research } = await open(dataDir)
      const result = await importChatGit(store, research, path.resolve(first))
      console.log(`\n导入批次 ${result.batch}${result.resumed ? '（接着上次继续）' : ''}：新建 ${result.totals.created}，已存在且相同 ${result.totals.identical}，冲突 ${result.totals.conflict}，跳过 ${result.totals.skipped}`)
      for (const item of result.items) console.log(`  - ${item.name || '（无名）'}：${item.result}${item.reason ? '（' + item.reason + '）' : ''}，${item.turns} 个问题 / ${item.answers} 个回答 / ${item.unfinished} 个未完成 / ${item.drafts} 个草稿 / ${item.summaries} 个摘要`)
      const verified = await verifyImport(store, research, path.resolve(first))
      console.log(`\n核对：${verified.ok ? '全部一致' : '有不一致'} —— ${JSON.stringify(verified.checked)}`)
      verified.mismatches.forEach(item => console.log(`  ✗ ${item.where}: ${item.message}`))
      if (!verified.ok || result.totals.conflict) process.exitCode = 1
    } else if (command === 'verify') {
      const { store, research } = await open(dataDir)
      const verified = await verifyImport(store, research, path.resolve(first))
      console.log(`核对：${verified.ok ? '全部一致' : '有不一致'} —— ${JSON.stringify(verified.checked)}`)
      verified.mismatches.forEach(item => console.log(`  ✗ ${item.where}: ${item.message}`))
      if (!verified.ok) process.exitCode = 1
    } else {
      const { store, research } = await open(dataDir)
      if (!await readBatch(store, first)) throw new Error('没有找到这个导入批次。')
      await withBackup(dataDir, backup, existed)
      const done = await rollbackImport(store, research, first)
      console.log(`已回退批次 ${done.batch}：移走 ${done.discussions} 个讨论、${done.drafts} 个草稿、${done.runs} 条运行记录；完整副本在 ${done.archived}`)
      for (const added of done.additions) console.log(`  ! 讨论 ${added.discussion} 在导入后新增了 ${added.turns} 个问题，已随归档保留。`)
    }
  } finally { await release() }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : '导入失败。')
  process.exitCode = 1
})
