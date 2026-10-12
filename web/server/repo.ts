import fs from 'node:fs/promises'
import path from 'node:path'
import { Git } from './git'
import { readRecord, StorageError, writeData, writeRecord } from './persistence'

export const REPO_MARKER = 'canvasnote.json'
const MIGRATION = '.canvasnote-migration.json'
const GITIGNORE = '# Canvas Note: cache is rebuildable; local contains durable history included in full backups, not Git.\n/cache/\n/local/\n.DS_Store\n'

/** Where each kind of data lives. Standalone mode (tests) keeps metadata beside the notes. */
export type DataPaths = {
  /** Root of the data repository (or the notes folder in standalone mode). */
  root: string
  notes: string
  memory: string
  canvas: string
  cache: string
  /** Durable raw history and recovery records. Not disposable and not pushed to Git. */
  local: string
  /** Stable note identities and saved provenance, committed with Markdown. */
  research: string
  /** Legacy v0.2 metadata, read only for migration fallbacks. */
  legacy: string
}

export function standalonePaths(notes: string): DataPaths {
  const root = path.resolve(notes), meta = path.join(root, '.canvasnote')
  return { root, notes: root, memory: path.join(meta, 'memory'), canvas: path.join(meta, 'canvas'), cache: path.join(meta, 'cache'), local: path.join(meta, 'local'), research: path.join(meta, 'research'), legacy: meta }
}

export function repoPaths(root: string): DataPaths {
  const resolved = path.resolve(root)
  return { root: resolved, notes: path.join(resolved, 'notes'), memory: path.join(resolved, 'memory'), canvas: path.join(resolved, 'canvas'), cache: path.join(resolved, 'cache'), local: path.join(resolved, 'local'), research: path.join(resolved, 'research'), legacy: path.join(resolved, 'cache', 'legacy-canvasnote') }
}

/** Directories only the repository layout creates; a legacy notes folder has Markdown in its root instead. */
const REPO_DIRECTORIES = ['notes', 'memory', 'canvas', 'cache', 'local', 'research']
const exists = (file: string) => fs.access(file).then(() => true, () => false)

type LegacyLibrary = { version: 1; notes?: Record<string, { position: { x: number; y: number } }>; frames?: { id: string; space: string; title: string; position: { x: number; y: number }; width: number; height: number; members: string[] }[] }

/**
 * Opens (and if needed creates or migrates) the single Git repository holding all app data:
 * notes/, memory/, canvas/ are committed together; cache/ is ignored.
 */
export async function openDataRepo(root: string, options: { git?: boolean } = {}): Promise<{ paths: DataPaths; git: Git | null; migrated: boolean }> {
  const paths = repoPaths(root)
  const marker = await readRecord<{ format: string; version: number }>(path.join(paths.root, REPO_MARKER))
  if (marker && (marker.format !== 'canvas-note-repo' || ![1, 2].includes(marker.version))) throw new StorageError('不支持这个数据仓库版本，未修改任何内容。请使用兼容版本打开。')
  await fs.mkdir(paths.root, { recursive: true })
  let migrated = false
  if (!await exists(path.join(paths.root, REPO_MARKER))) {
    const entries = (await fs.readdir(paths.root)).filter(name => name !== '.git')
    const pending = entries.includes(MIGRATION)
    // A directory that already has the repository's own layout but lost its version marker (an interrupted first start,
    // an incomplete restore, a manual clean-up) is not an old notes folder. Treating it as one would move its data
    // directories inside notes/, so refuse and change nothing.
    const layout = REPO_DIRECTORIES.filter(name => entries.includes(name))
    const hasData = async (name: string) => (await fs.readdir(path.join(paths.root, name))).length > 0
    // Only empty directories: a first start that stopped before writing the marker. Nothing to protect, finish it below.
    const interruptedInit = layout.length > 0 && entries.every(name => layout.includes(name) || name.startsWith('.')) && !(await Promise.all(layout.map(hasData))).some(Boolean)
    if (!interruptedInit && !pending && !entries.includes('.canvasnote') && ((entries.includes('notes') && layout.length >= 3) || entries.includes('local') || entries.includes('research'))) {
      throw new StorageError(`这个目录已经是新版数据仓库的结构（${layout.join('、')}），但缺少版本标记 ${REPO_MARKER}。为避免把它当作旧版笔记文件夹再次搬动，没有修改任何内容。请从备份恢复该文件，或确认目录无误后手动创建内容为 {"format":"canvas-note-repo","version":2} 的 ${REPO_MARKER}。`)
    }
    if (!interruptedInit && entries.length && (pending || entries.some(name => !name.startsWith('.')) || entries.includes('.canvasnote'))) {
      await migrateLegacy(paths)
      migrated = true
    }
    for (const directory of [paths.notes, paths.memory, paths.canvas, paths.cache]) await fs.mkdir(directory, { recursive: true })
    if (!await exists(path.join(paths.root, '.gitignore'))) await fs.writeFile(path.join(paths.root, '.gitignore'), GITIGNORE)
    await fs.writeFile(path.join(paths.root, REPO_MARKER), JSON.stringify({ format: 'canvas-note-repo', version: 1 }, null, 2) + '\n')
  }
  await preparePersistentData(paths)
  const ignore = path.join(paths.root, '.gitignore')
  const previous = await fs.readFile(ignore, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
  if (!previous.split('\n').some(line => line === 'local/' || line === '/local/')) await fs.writeFile(ignore, previous + '\n# Durable device history: use full backup, not Git.\n/local/\n')
  if (marker?.version !== 2) await writeRecord(path.join(paths.root, REPO_MARKER), { format: 'canvas-note-repo', version: 2 })
  let git: Git | null = null
  if (options.git !== false) {
    const candidate = new Git(paths.root)
    if (await candidate.available()) {
      if (!await candidate.isRepository()) await candidate.init()
      git = candidate
    }
  }
  return { paths, git, migrated }
}

/** Copy once, never delete the old history; incomplete copies are safely resumable. */
export async function preparePersistentData(paths: DataPaths): Promise<void> {
  for (const directory of [paths.notes, paths.memory, paths.canvas, paths.cache, paths.local, paths.research]) {
    await fs.mkdir(directory, { recursive: true })
    if (!(await fs.lstat(directory)).isDirectory()) throw new StorageError('数据目录不能使用符号链接：' + directory)
  }
  const marker = path.join(paths.local, 'history-migration.json')
  const migration = await readRecord<{ version: number; complete: boolean }>(marker)
  if (migration) {
    if (migration.version !== 1 || migration.complete !== true) throw new StorageError('历史迁移记录无效，未继续迁移。')
    return
  }
  const copy = async (source: string, target: string): Promise<void> => {
    let entries: import('node:fs').Dirent[]
    try {
      if (!(await fs.lstat(source)).isDirectory()) throw new StorageError('历史目录不能使用符号链接：' + source)
      entries = await fs.readdir(source, { withFileTypes: true })
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    await fs.mkdir(target, { recursive: true })
    if (!(await fs.lstat(target)).isDirectory()) throw new StorageError('历史目录不能使用符号链接：' + target)
    for (const entry of entries) {
      const from = path.join(source, entry.name), to = path.join(target, entry.name)
      if (entry.isDirectory()) { await copy(from, to); continue }
      if (!entry.isFile()) throw new StorageError('历史中存在非普通文件，未继续迁移：' + from)
      try { await writeData(to, await fs.readFile(from), true) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (!(await fs.lstat(to)).isFile()) throw new StorageError('历史目标不是普通文件：' + to)
        if (!(await fs.readFile(from)).equals(await fs.readFile(to))) throw new StorageError('历史迁移发现不同版本，保留了两份文件：' + to)
      }
    }
  }
  for (const name of ['conversations', 'changesets', 'proposals']) await copy(path.join(paths.cache, name), path.join(paths.local, name))
  await writeRecord(marker, { version: 1, complete: true })
}

/** v0.2 layout: Markdown directly in the root plus `.canvasnote/`. Resumable if interrupted. */
async function migrateLegacy(paths: DataPaths): Promise<void> {
  const progress = path.join(paths.root, MIGRATION), staging = path.join(paths.root, '.migrating-notes')
  let step = 'move'
  try { step = JSON.parse(await fs.readFile(progress, 'utf8')).step } catch { await fs.writeFile(progress, JSON.stringify({ step })) }
  if (step === 'move') {
    await fs.mkdir(staging, { recursive: true })
    for (const name of await fs.readdir(paths.root)) {
      if (name.startsWith('.')) continue
      await fs.rename(path.join(paths.root, name), path.join(staging, name))
    }
    await fs.rename(staging, paths.notes)
    await fs.writeFile(progress, JSON.stringify({ step: 'meta' }))
  }
  await migrateMetadata(paths)
  await fs.rm(progress, { force: true })
}

async function migrateMetadata(paths: DataPaths): Promise<void> {
  const legacyMeta = path.join(paths.root, '.canvasnote')
  if (!await exists(legacyMeta)) return
  await fs.mkdir(paths.cache, { recursive: true })
  let library: LegacyLibrary | null = null
  try { library = JSON.parse(await fs.readFile(path.join(legacyMeta, 'library.json'), 'utf8')) } catch { /* nothing to convert */ }
  if (library?.version === 1) {
    const folders = new Map<string, { notes: Record<string, { x: number; y: number }>; frames: unknown[] }>()
    const folderOf = (name: string) => name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : ''
    const folder = (name: string) => { if (!folders.has(name)) folders.set(name, { notes: {}, frames: [] }); return folders.get(name)! }
    for (const [name, entry] of Object.entries(library.notes ?? {})) {
      folder(folderOf(name)).notes[name.slice(name.lastIndexOf('/') + 1)] = entry.position
    }
    for (const frame of library.frames ?? []) {
      const { space, ...rest } = frame
      folder(space).frames.push({ ...rest, members: frame.members.map(name => name.slice(name.lastIndexOf('/') + 1)) })
    }
    for (const [name, layout] of folders) {
      const directory = path.join(paths.canvas, name)
      await fs.mkdir(directory, { recursive: true })
      await fs.writeFile(path.join(directory, '_canvas.json'), JSON.stringify({ version: 1, ...layout }, null, 2) + '\n')
    }
  }
  // Keep every old record; derived overviews are rebuilt from the notes.
  if (await exists(path.join(legacyMeta, 'agent-changes'))) await fs.rename(path.join(legacyMeta, 'agent-changes'), path.join(paths.cache, 'legacy-agent-changes'))
  await fs.rm(path.join(legacyMeta, 'overviews.json'), { force: true })
  await fs.rename(legacyMeta, paths.legacy)
}
