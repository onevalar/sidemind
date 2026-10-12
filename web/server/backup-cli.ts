import { backupRepository, restoreRepository } from './backup'
import { acquireWorkspace } from './workspace-lock'

const usage = `Offline Canvas Note backup/restore — the server MUST be stopped first.
The CLI acquires exclusive workspace ownership; pause external editors too.
Usage:
  tsx server/backup-cli.ts backup <source> <new-backup>
  tsx server/backup-cli.ts restore <backup> <new-data-directory>
The destination must not exist, its parent must exist, and it must be outside the source.
Configuration credentials, Git internals and rebuildable caches are excluded.`

async function main() {
  const [command, source, destination, ...extra] = process.argv.slice(2)
  if ((command !== 'backup' && command !== 'restore') || !source || !destination || extra.length) {
    console.error(usage)
    process.exitCode = 1
    return
  }
  console.error('Offline operation: the server MUST be stopped and all external editors paused.')
  const release = await acquireWorkspace(source)
  try {
    const completed = await (command === 'backup' ? backupRepository(source, destination) : restoreRepository(source, destination))
    console.log(`${command}: ${completed.root} (${completed.files} files, ${completed.directories} directories)`)
  } finally { await release() }
}

main().catch((error: unknown) => {
  // Filesystem/validation errors contain paths, never raw JSON or credential values.
  console.error(error instanceof Error ? error.message : 'Backup/restore failed.')
  process.exitCode = 1
})
