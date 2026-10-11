import fs from 'node:fs/promises'
import path from 'node:path'
import { Git } from './git'

export const REPO_MARKER = 'canvasnote.json'
const MIGRATION = '.canvasnote-migration.json'
const GITIGNORE = '# Canvas Note: local caches are rebuilt on each computer and never committed.\ncache/\n.DS_Store\n'

/** Where each kind of data lives. Standalone mode (tests) keeps metadata beside the notes. */
export type DataPaths = {
  /** Root of the data repository (or the notes folder in standalone mode). */
  root: string
  notes: string
  memory: string
  canvas: string
  cache: string
  /** Legacy v0.2 metadata, read only for migration fallbacks. */
  legacy: string
}

export function standalonePaths(notes: string): DataPaths {
  const root = path.resolve(notes), meta = path.join(root, '.canvasnote')
  return { root, notes: root, memory: path.join(meta, 'memory'), canvas: path.join(meta, 'canvas'), cache: path.join(meta, 'cache'), legacy: meta }
}

export function repoPaths(root: string): DataPaths {
  const resolved = path.resolve(root)
  return { root: resolved, notes: path.join(resolved, 'notes'), memory: path.join(resolved, 'memory'), canvas: path.join(resolved, 'canvas'), cache: path.join(resolved, 'cache'), legacy: path.join(resolved, 'cache', 'legacy-canvasnote') }
}

const exists = (file: string) => fs.access(file).then(() => true, () => false)

type LegacyLibrary = { version: 1; notes?: Record<string, { position: { x: number; y: number }; lastOpenedAt?: number }>; frames?: { id: string; space: string; title: string; position: { x: number; y: number }; width: number; height: number; members: string[] }[] }

/**
 * Opens (and if needed creates or migrates) the single Git repository holding all app data:
 * notes/, memory/, canvas/ are committed together; cache/ is ignored.
 */
export async function openDataRepo(root: string, options: { git?: boolean } = {}): Promise<{ paths: DataPaths; git: Git | null; migrated: boolean }> {
  const paths = repoPaths(root)
  await fs.mkdir(paths.root, { recursive: true })
  let migrated = false
  if (!await exists(path.join(paths.root, REPO_MARKER))) {
    const entries = (await fs.readdir(paths.root)).filter(name => name !== '.git')
    const pending = entries.includes(MIGRATION)
    if (entries.length && (pending || entries.some(name => !name.startsWith('.')) || entries.includes('.canvasnote'))) {
      await migrateLegacy(paths)
      migrated = true
    }
    for (const directory of [paths.notes, paths.memory, paths.canvas, paths.cache]) await fs.mkdir(directory, { recursive: true })
    if (!await exists(path.join(paths.root, '.gitignore'))) await fs.writeFile(path.join(paths.root, '.gitignore'), GITIGNORE)
    await fs.writeFile(path.join(paths.root, REPO_MARKER), JSON.stringify({ format: 'canvas-note-repo', version: 1 }, null, 2) + '\n')
  }
  for (const directory of [paths.notes, paths.memory, paths.canvas, paths.cache]) await fs.mkdir(directory, { recursive: true })
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
    const recent: Record<string, number> = {}
    const folders = new Map<string, { notes: Record<string, { x: number; y: number }>; frames: unknown[] }>()
    const folderOf = (name: string) => name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : ''
    const folder = (name: string) => { if (!folders.has(name)) folders.set(name, { notes: {}, frames: [] }); return folders.get(name)! }
    for (const [name, entry] of Object.entries(library.notes ?? {})) {
      folder(folderOf(name)).notes[name.slice(name.lastIndexOf('/') + 1)] = entry.position
      if (entry.lastOpenedAt) recent[name] = entry.lastOpenedAt
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
    await fs.writeFile(path.join(paths.cache, 'recent.json'), JSON.stringify({ version: 1, notes: recent }))
  }
  // Keep every old record; derived overviews are rebuilt from the notes.
  if (await exists(path.join(legacyMeta, 'agent-changes'))) await fs.rename(path.join(legacyMeta, 'agent-changes'), path.join(paths.cache, 'legacy-agent-changes'))
  await fs.rm(path.join(legacyMeta, 'overviews.json'), { force: true })
  await fs.rename(legacyMeta, paths.legacy)
}
