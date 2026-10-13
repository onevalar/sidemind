import fs from 'node:fs/promises'
import { constants, type Stats } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { BACKUP_FORMAT, LEGACY_BACKUP_FORMAT, LEGACY_FORMAT, LEGACY_MARKER, REPO_FORMAT, REPO_MARKER, REPO_VERSION, configDirectory, legacyConfigDirectory } from './sidemind'

// Deliberately independent of repo.ts: opening a repository can initialize or migrate it.
// Both marker names are payload: Sidemind's own, and the one kept under Canvas Note's name that makes an old version refuse the directory.
const MARKERS = [REPO_MARKER, LEGACY_MARKER]
const DATA = ['notes', 'memory', 'canvas', 'research', 'local']
const HISTORY = ['conversations', 'changesets', 'proposals']
type RepoVersion = 1 | 2
type Entry = { path: string; type: 'directory' } | { path: string; type: 'file'; bytes: number; sha256: string }
type Manifest = { format: typeof BACKUP_FORMAT; version: 1; repositoryVersion: RepoVersion; entries: Entry[] }
type Snapshot = { entries: Entry[]; identities: string[] }
export type BackupResult = { root: string; repositoryVersion: RepoVersion; files: number; directories: number }
export class BackupError extends Error {}

function fail(message: string): never { throw new BackupError(message) }
function missing(error: unknown) { return (error as NodeJS.ErrnoException).code === 'ENOENT' }
async function statOptional(file: string) {
  try { return await fs.lstat(file) } catch (error) { if (missing(error)) return null; throw error }
}
function within(parent: string, child: string) {
  const relative = path.relative(parent, child)
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

/** Refuse symlinks in ancestors too, not only the final payload component. */
async function safeDirectory(directory: string) {
  const absolute = path.resolve(directory)
  let current = path.parse(absolute).root
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    const stat = await fs.lstat(current)
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`Expected a real directory (no symlinks): ${current}`)
  }
  return absolute
}

function validPath(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || value.normalize('NFC') !== value) fail('Invalid or ambiguous manifest path.')
  for (const part of value.split('/')) {
    if (!part || part === '.' || part === '..' || /[\\:\x00-\x1f\x7f]/.test(part) || /[. ]$/.test(part)
      || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part) || part.toLowerCase() === '.git') {
      fail(`Unsafe or non-portable path: ${value}`)
    }
  }
}
const identity = (stat: Stats) => [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs].join(':')
const digestEqual = (a: Entry[], b: Entry[]) => JSON.stringify(a) === JSON.stringify(b)
const sorted = (entries: Entry[]) => entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)

/** Hash raw bytes, optionally copying them. Never decode notes or attachments. */
async function fileBytes(file: string, output?: string): Promise<{ bytes: number; sha256: string; identity: string }> {
  await safeDirectory(path.dirname(file))
  const before = await fs.lstat(file)
  if (!before.isFile() || before.isSymbolicLink()) fail(`Expected a regular file (no symlinks): ${file}`)
  const input = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let target: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    const opened = await input.stat()
    if (!opened.isFile() || identity(opened) !== identity(before)) fail(`File changed while reading: ${file}`)
    if (output) target = await fs.open(output, 'wx', 0o600)
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024)
    let bytes = 0
    for (;;) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null)
      if (!bytesRead) break
      const chunk = buffer.subarray(0, bytesRead)
      hash.update(chunk)
      if (target) await target.writeFile(chunk)
      bytes += bytesRead
    }
    if (identity(await input.stat()) !== identity(before) || identity(await fs.lstat(file)) !== identity(before)) {
      fail(`File changed while reading: ${file}`)
    }
    return { bytes, sha256: hash.digest('hex'), identity: identity(before) }
  } finally {
    await target?.close()
    await input.close()
  }
}

async function readJson(file: string): Promise<unknown> {
  // Use the same no-follow and stable-file checks as payload reads.
  const before = await fileBytes(file)
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    if (identity(await handle.stat()) !== before.identity) fail(`File changed while reading: ${file}`)
    const buffer = await handle.readFile()
    if (createHash('sha256').update(buffer).digest('hex') !== before.sha256) fail(`File changed while reading: ${file}`)
    try { return JSON.parse(buffer.toString('utf8')) } catch { return fail(`Invalid JSON: ${file}`) }
  } finally { await handle.close() }
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
/**
 * Internal repository versions: 1 = Canvas Note v1 (history still in cache/), 2 = history in local/ and research/, which is
 * what Sidemind's own `sidemind-repo` version 1 and Canvas Note's v2 both are.
 */
async function repoVersion(root: string): Promise<RepoVersion> {
  const read = async (name: string) => (await statOptional(path.join(root, name))) ? readJson(path.join(root, name)) : null
  const modern = await read(REPO_MARKER)
  if (modern !== null) {
    if (!record(modern) || modern.format !== REPO_FORMAT || modern.version !== REPO_VERSION) fail(`Unsupported repository marker; expected ${REPO_FORMAT} version ${REPO_VERSION}: ${path.join(root, REPO_MARKER)}`)
    return 2
  }
  const legacy = await read(LEGACY_MARKER)
  if (!record(legacy) || legacy.format !== LEGACY_FORMAT || (legacy.version !== 1 && legacy.version !== 2)) {
    fail(`Unsupported repository marker; expected ${REPO_FORMAT} version ${REPO_VERSION} (or ${LEGACY_FORMAT} version 1 or 2): ${path.join(root, REPO_MARKER)}`)
  }
  return legacy.version
}

async function canonicalLocation(location: string): Promise<string> {
  try { return await fs.realpath(location) }
  catch (error) {
    if (!missing(error)) throw error
    const parent = path.dirname(location)
    if (parent === location) throw error
    return path.join(await canonicalLocation(parent), path.basename(location))
  }
}
async function exclusions(root: string, version: RepoVersion) {
  // Neither Sidemind's settings location nor Canvas Note's old one may end up in a backup, in either spelling.
  const candidates = [...new Set(await Promise.all([configDirectory(), legacyConfigDirectory()].flatMap(directory => [Promise.resolve(directory), canonicalLocation(directory)])))]
  const critical = [...DATA, ...MARKERS, '.gitignore', ...HISTORY.map(name => `local/${name}`), ...(version === 1 ? HISTORY.map(name => `cache/${name}`) : [])]
  for (const directory of candidates) {
    if (within(directory, root) || critical.some(name => within(directory, path.join(root, name)))) {
      fail(`Configuration directory overlaps essential repository data; move configuration outside the repository before backup: ${directory}`)
    }
    const stat = await statOptional(directory)
    if (stat && !stat.isDirectory() && !stat.isSymbolicLink()) fail(`Configuration path is not a directory: ${directory}`)
  }
  return candidates.filter(directory => within(root, directory))
}

async function scan(root: string, version?: RepoVersion, excluded: string[] = []): Promise<Snapshot> {
  const entries: Entry[] = [], identities: string[] = [], seen = new Set<string>()
  async function visit(relative: string) {
    const absolute = path.join(root, relative)
    if (excluded.some(directory => within(directory, absolute))) return
    validPath(relative)
    const key = relative.toLowerCase()
    if (seen.has(key)) fail(`Duplicate or case-ambiguous path: ${relative}`)
    seen.add(key)
    const stat = await fs.lstat(absolute)
    if (stat.isSymbolicLink()) fail(`Symlinks cannot be backed up or restored: ${relative}`)
    if (stat.isDirectory()) {
      entries.push({ path: relative, type: 'directory' })
      for (const name of (await fs.readdir(absolute)).sort()) {
        // Only these version-1 cache records are irreplaceable. Everything else is rebuilt.
        if (version && relative === 'cache' && !HISTORY.includes(name)) continue
        await visit(`${relative}/${name}`)
      }
      if (identity(await fs.lstat(absolute)) !== identity(stat)) fail(`Directory changed while reading: ${relative}`)
      identities.push(`${relative}:${identity(stat)}`)
    } else if (stat.isFile()) {
      const file = await fileBytes(absolute)
      entries.push({ path: relative, type: 'file', bytes: file.bytes, sha256: file.sha256 })
      identities.push(`${relative}:${file.identity}`)
    } else fail(`Only regular files and directories are supported: ${relative}`)
  }
  for (const name of (await fs.readdir(root)).sort()) {
    if (version && ![...DATA, ...MARKERS, '.gitignore', ...(version === 1 ? ['cache'] : [])].includes(name)) continue
    await visit(name)
  }
  return { entries: sorted(entries), identities: identities.sort() }
}

function allowed(relative: string, version: RepoVersion) {
  const [first, second] = relative.split('/')
  return DATA.includes(first!) || MARKERS.includes(relative) || relative === '.gitignore'
    || (version === 1 && first === 'cache' && (second === undefined || HISTORY.includes(second)))
}
function exactKeys(object: Record<string, unknown>, keys: string[]) {
  return Object.keys(object).sort().join(',') === keys.sort().join(',')
}
function validateManifest(value: unknown): Manifest {
  if (!record(value) || !exactKeys(value, ['format', 'version', 'repositoryVersion', 'entries'])
    || (value.format !== BACKUP_FORMAT && value.format !== LEGACY_BACKUP_FORMAT) || value.version !== 1
    || (value.repositoryVersion !== 1 && value.repositoryVersion !== 2) || !Array.isArray(value.entries)) fail('Unsupported backup manifest.')
  const paths = new Map<string, Entry>(), folded = new Set<string>()
  for (const item of value.entries) {
    if (!record(item)) fail('Invalid manifest entry.')
    validPath(item.path)
    if (!allowed(item.path, value.repositoryVersion)) fail(`Unexpected payload path: ${item.path}`)
    const file = item.type === 'file'
    if ((item.type !== 'directory' && !file) || !exactKeys(item, file ? ['path', 'type', 'bytes', 'sha256'] : ['path', 'type'])
      || (file && (!Number.isSafeInteger(item.bytes) || (item.bytes as number) < 0 || typeof item.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(item.sha256)))) {
      fail(`Invalid manifest entry: ${item.path}`)
    }
    if (folded.has(item.path.toLowerCase())) fail(`Duplicate or case-ambiguous path: ${item.path}`)
    folded.add(item.path.toLowerCase())
    paths.set(item.path, item as Entry)
  }
  for (const item of paths.values()) {
    const parent = path.posix.dirname(item.path)
    if (parent !== '.' && paths.get(parent)?.type !== 'directory') fail(`Missing or ambiguous parent directory: ${item.path}`)
    if ((DATA.includes(item.path) || item.path === 'cache' || HISTORY.some(name => item.path === `cache/${name}`)) && item.type !== 'directory') {
      fail(`Expected data directory: ${item.path}`)
    }
  }
  for (const name of ['notes', 'memory', 'canvas']) if (paths.get(name)?.type !== 'directory') fail(`Missing data directory: ${name}`)
  if (!MARKERS.some(name => paths.get(name)?.type === 'file') || MARKERS.some(name => paths.has(name) && paths.get(name)?.type !== 'file') || (paths.has('.gitignore') && paths.get('.gitignore')?.type !== 'file')) fail('Missing or invalid repository metadata.')
  return { format: BACKUP_FORMAT, version: 1, repositoryVersion: value.repositoryVersion, entries: sorted([...paths.values()]) }
}

async function verifyBackup(root: string): Promise<Manifest> {
  await safeDirectory(root)
  if ((await fs.readdir(root)).sort().join(',') !== 'manifest.json,payload') fail(`Unexpected or missing backup contents: ${root}`)
  const manifest = validateManifest(await readJson(path.join(root, 'manifest.json')))
  const payload = await safeDirectory(path.join(root, 'payload'))
  const actual = await scan(payload)
  if (!digestEqual(manifest.entries, actual.entries)) fail(`Backup payload does not match its manifest (paths, bytes or SHA-256): ${root}`)
  if (await repoVersion(payload) !== manifest.repositoryVersion) fail('Repository version does not match the backup manifest.')
  return manifest
}

async function newDestination(source: string, requested: string) {
  const destination = path.resolve(requested)
  await safeDirectory(path.dirname(destination))
  if (within(source, destination)) fail(`Destination must be outside the source directory: ${destination}`)
  if (await statOptional(destination)) fail(`Destination already exists; choose a new directory: ${destination}`)
  return destination
}
async function copyEntries(source: string, target: string, entries: Entry[]) {
  for (const entry of entries) {
    const output = path.join(target, entry.path)
    if (entry.type === 'directory') await fs.mkdir(output, { mode: 0o700 })
    else {
      const actual = await fileBytes(path.join(source, entry.path), output)
      if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) fail(`Source changed while copying: ${entry.path}`)
    }
  }
}
async function publish(staging: string, destination: string) {
  // rename alone would silently replace a pre-existing empty directory on POSIX.
  // Reserve with exclusive mkdir first; never rename over somebody else's target.
  await fs.mkdir(destination, { mode: 0o700 })
  const reservation = await fs.lstat(destination)
  try { await fs.rename(staging, destination) }
  catch (error) {
    const current = await statOptional(destination)
    if (current && identity(current) === identity(reservation)) await fs.rmdir(destination).catch(() => {})
    throw error
  }
}
function result(root: string, manifest: Manifest): BackupResult {
  return { root, repositoryVersion: manifest.repositoryVersion, files: manifest.entries.filter(entry => entry.type === 'file').length, directories: manifest.entries.filter(entry => entry.type === 'directory').length }
}

/**
 * Offline only. The caller MUST stop the server and hold workspace ownership for
 * this entire operation. Before/after scans detect external edits, but are NOT a
 * replacement for that lock (nor a defense against a hostile filesystem writer).
 * The destination's parent must already exist. No source migration or writes.
 */
export async function backupRepository(sourceRoot: string, newBackupRoot: string): Promise<BackupResult> {
  const source = await safeDirectory(sourceRoot)
  const destination = await newDestination(source, newBackupRoot)
  const version = await repoVersion(source), excluded = await exclusions(source, version)
  const before = await scan(source, version, excluded)
  const manifest = validateManifest({ format: BACKUP_FORMAT, version: 1, repositoryVersion: version, entries: before.entries })
  const staging = await fs.mkdtemp(path.join(path.dirname(destination), '.sidemind-backup-'))
  try {
    const payload = path.join(staging, 'payload')
    await fs.mkdir(payload, { mode: 0o700 })
    await copyEntries(source, payload, manifest.entries)
    await fs.writeFile(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    await verifyBackup(staging)
    const after = await scan(source, version, excluded)
    if (!digestEqual(before.entries, after.entries) || JSON.stringify(before.identities) !== JSON.stringify(after.identities)) fail('Source changed during backup; stop all writers and retry.')
    await publish(staging, destination)
    return result(destination, manifest)
  } finally { await fs.rm(staging, { recursive: true, force: true }) }
}

/** Validate the entire backup before writing; restore only into a new directory. Same offline/ownership requirement as backupRepository. */
export async function restoreRepository(backupRoot: string, newDataRoot: string): Promise<BackupResult> {
  const source = await safeDirectory(backupRoot)
  const destination = await newDestination(source, newDataRoot)
  const manifest = await verifyBackup(source)
  const staging = await fs.mkdtemp(path.join(path.dirname(destination), '.sidemind-restore-'))
  try {
    await copyEntries(path.join(source, 'payload'), staging, manifest.entries)
    if (!digestEqual((await scan(staging)).entries, manifest.entries)) fail('Restored files failed verification.')
    // A modified backup must not be published even if its previous bytes were copied successfully.
    if (JSON.stringify(await verifyBackup(source)) !== JSON.stringify(manifest)) fail('Backup changed during restore.')
    await publish(staging, destination)
    return result(destination, manifest)
  } finally { await fs.rm(staging, { recursive: true, force: true }) }
}
