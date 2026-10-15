import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { backupRepository, restoreRepository } from '../server/backup'

let directory: string, source: string, backup: string, restored: string
const note = Buffer.from('# 原始笔记\r\n\r\n![附件](assets/image.bin)\r\n')
const attachment = Buffer.from(Array.from({ length: 150_000 }, (_, i) => i % 256))
const absent = async (file: string) => expect(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' })
async function put(root: string, relative: string, data: string | Buffer) {
  const file = path.join(root, relative)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, data)
}
async function fixture(version = 2) {
  for (const name of ['notes/empty/nested', 'memory', 'canvas', 'research', 'local/conversations', 'local/proposals']) {
    await fs.mkdir(path.join(source, name), { recursive: true })
  }
  await put(source, 'canvasnote.json', JSON.stringify({ format: 'canvas-note-repo', version }) + '\n')
  await put(source, '.gitignore', 'cache/\nlocal/\n')
  await put(source, 'notes/a.md', note)
  await put(source, 'notes/assets/image.bin', attachment)
  await put(source, 'notes/zero.bin', Buffer.alloc(0))
  await put(source, 'local/conversations/one.json', '{"messages":["draft"]}')
  await put(source, 'local/proposals/one.json', '{"status":"pending"}')
  await put(source, 'local/changesets/one.json', '{"before":"previous bytes"}')
  await put(source, 'research/identities.json', '{"note":"stable-id"}')
  await put(source, 'cache/search.json', 'rebuildable')
  await put(source, 'cache/conversations/old.json', 'old conversation')
  await put(source, 'cache/changesets/old.json', 'old undo data')
  await put(source, 'cache/proposals/old.json', 'old proposal')
  await put(source, '.git/config', 'credential-not-for-backup')
}
async function tree(root: string): Promise<Record<string, string>> {
  const output: Record<string, string> = {}
  async function visit(relative: string) {
    const absolute = path.join(root, relative), stat = await fs.lstat(absolute)
    output[relative] = stat.isDirectory() ? 'directory' : (await fs.readFile(absolute)).toString('base64')
    if (stat.isDirectory()) for (const child of (await fs.readdir(absolute)).sort()) await visit(relative ? `${relative}/${child}` : child)
  }
  await visit('')
  return output
}
type TestManifest = { format: string; version: number; repositoryVersion: number; entries: { path: string; type: string; bytes?: number; sha256?: string }[] }
async function editManifest(edit: (manifest: TestManifest) => void) {
  const file = path.join(backup, 'manifest.json')
  const manifest = JSON.parse(await fs.readFile(file, 'utf8')) as TestManifest
  edit(manifest)
  await fs.writeFile(file, JSON.stringify(manifest))
}
async function noTemporaryDirectories() {
  expect((await fs.readdir(directory)).filter(name => /^\.canvasnote-(backup|restore)-/.test(name))).toEqual([])
}

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-backup-test-'))
  source = path.join(directory, 'source'); backup = path.join(directory, 'backup'); restored = path.join(directory, 'restored')
  vi.stubEnv('SIDEMIND_CONFIG_DIR', path.join(directory, 'private-config'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await fs.rm(directory, { recursive: true, force: true })
})

describe('offline repository backup and restore', () => {
  it.each([1, 2])('round-trips v%i raw bytes, attachments, empty folders and durable history without touching the source', async version => {
    await fixture(version)
    const before = await tree(source)
    const originalStat = await fs.stat(path.join(source, 'notes/a.md'))
    const saved = await backupRepository(source, backup)
    const loaded = await restoreRepository(backup, restored)
    expect(saved.repositoryVersion).toBe(version)
    expect(loaded.files).toBe(saved.files)
    expect(loaded.directories).toBe(saved.directories)
    expect(await fs.readFile(path.join(restored, 'notes/a.md'))).toEqual(note)
    expect(await fs.readFile(path.join(restored, 'notes/assets/image.bin'))).toEqual(attachment)
    expect(await fs.readdir(path.join(restored, 'notes/empty/nested'))).toEqual([])
    for (const file of ['canvasnote.json', '.gitignore', 'local/conversations/one.json', 'local/proposals/one.json', 'local/changesets/one.json', 'research/identities.json', 'notes/zero.bin']) {
      expect(await fs.readFile(path.join(restored, file))).toEqual(await fs.readFile(path.join(source, file)))
    }
    await absent(path.join(restored, '.git'))
    await absent(path.join(restored, 'cache/search.json'))
    if (version === 1) for (const name of ['conversations', 'changesets', 'proposals']) {
      expect(await fs.readFile(path.join(restored, `cache/${name}/old.json`))).toEqual(await fs.readFile(path.join(source, `cache/${name}/old.json`)))
    }
    else await absent(path.join(restored, 'cache'))
    const manifest = JSON.parse(await fs.readFile(path.join(backup, 'manifest.json'), 'utf8')) as TestManifest
    expect(manifest.entries.find(entry => entry.path === 'notes/assets/image.bin')).toEqual({ path: 'notes/assets/image.bin', type: 'file', bytes: attachment.length, sha256: createHash('sha256').update(attachment).digest('hex') })
    expect(await tree(source)).toEqual(before)
    expect((await fs.stat(path.join(source, 'notes/a.md'))).mtimeMs).toBe(originalStat.mtimeMs)
    await noTemporaryDirectories()
  })

  it('backs up and restores a Sidemind repository with both markers byte for byte', async () => {
    await fixture()
    await put(source, 'sidemind.json', JSON.stringify({ format: 'sidemind-repo', version: 1 }) + '\n')
    await put(source, 'canvasnote.json', JSON.stringify({ format: 'canvas-note-repo', version: 99 }) + '\n')
    const saved = await backupRepository(source, backup)
    expect(saved.repositoryVersion).toBe(2)
    const manifest = JSON.parse(await fs.readFile(path.join(backup, 'manifest.json'), 'utf8')) as TestManifest
    expect(manifest.format).toBe('sidemind-backup')
    await restoreRepository(backup, restored)
    for (const file of ['sidemind.json', 'canvasnote.json']) expect(await fs.readFile(path.join(restored, file))).toEqual(await fs.readFile(path.join(source, file)))
  })

  it('still restores a backup written under the Canvas Note format name', async () => {
    await fixture()
    await backupRepository(source, backup)
    const file = path.join(backup, 'manifest.json')
    const manifest = JSON.parse(await fs.readFile(file, 'utf8'))
    await fs.writeFile(file, JSON.stringify({ ...manifest, format: 'canvas-note-backup' }))
    await restoreRepository(backup, restored)
    expect(await fs.readFile(path.join(restored, 'notes/a.md'))).toEqual(note)
  })

  it.each(['wrong-format', 'future-version', 'malformed', 'missing'])('strictly rejects %s markers without initializing or migrating', async kind => {
    await fixture()
    const marker = path.join(source, 'canvasnote.json')
    if (kind === 'missing') await fs.unlink(marker)
    else await fs.writeFile(marker, kind === 'malformed' ? 'invalid-secret-json' : JSON.stringify({ format: kind === 'wrong-format' ? 'unknown' : 'canvas-note-repo', version: 99 }))
    const before = await tree(source)
    await expect(backupRepository(source, backup)).rejects.toThrow()
    await absent(backup)
    expect(await tree(source)).toEqual(before)
  })

  it.each(['bytes', 'size', 'hash', 'extra-file', 'extra-directory', 'extra-root', 'missing-file', 'version'])('rejects damaged backup (%s) before creating a destination', async damage => {
    await fixture(); await backupRepository(source, backup)
    if (damage === 'bytes') await put(backup, 'payload/notes/a.md', Buffer.alloc(note.length, 65))
    if (damage === 'size') await editManifest(manifest => { manifest.entries.find(entry => entry.path === 'notes/a.md')!.bytes!++ })
    if (damage === 'hash') await editManifest(manifest => { manifest.entries.find(entry => entry.path === 'notes/a.md')!.sha256 = '0'.repeat(64) })
    if (damage === 'extra-file') await put(backup, 'payload/notes/unlisted.bin', 'extra')
    if (damage === 'extra-directory') await fs.mkdir(path.join(backup, 'payload/notes/unlisted'))
    if (damage === 'extra-root') await put(backup, 'unexpected', 'extra')
    if (damage === 'missing-file') await fs.unlink(path.join(backup, 'payload/notes/a.md'))
    if (damage === 'version') await editManifest(manifest => { manifest.repositoryVersion = 1 })
    await expect(restoreRepository(backup, restored)).rejects.toThrow()
    await absent(restored); await noTemporaryDirectories()
  })

  it.each(['../escape', '/absolute', 'notes/../../escape', 'notes\\escape', 'notes//escape', 'notes/./escape', 'notes/C:escape', 'notes/trailing.', 'notes/.git/config'])('rejects unsafe manifest path %s', async unsafe => {
    await fixture(); await backupRepository(source, backup)
    await editManifest(manifest => { manifest.entries.push({ path: unsafe, type: 'directory' }) })
    await expect(restoreRepository(backup, restored)).rejects.toThrow()
    await absent(restored); await absent(path.join(directory, 'escape')); await noTemporaryDirectories()
  })

  it.each(['duplicate', 'case', 'parent-case', 'missing-parent'])('rejects ambiguous or incomplete manifests: %s', async kind => {
    await fixture(); await backupRepository(source, backup)
    await editManifest(manifest => {
      const entry = manifest.entries.find(item => item.path === 'notes/a.md')!
      if (kind === 'duplicate') manifest.entries.push({ ...entry })
      if (kind === 'case') manifest.entries.push({ ...entry, path: 'notes/A.md' })
      if (kind === 'parent-case') entry.path = 'Notes/a.md'
      if (kind === 'missing-parent') entry.path = 'notes/missing/a.md'
    })
    await expect(restoreRepository(backup, restored)).rejects.toThrow()
    await absent(restored)
  })

  it('refuses existing empty or populated destinations and destinations inside the source', async () => {
    await fixture()
    await fs.mkdir(backup)
    await expect(backupRepository(source, backup)).rejects.toThrow(/already exists/)
    await fs.rmdir(backup)
    await expect(backupRepository(source, path.join(source, 'backup'))).rejects.toThrow(/outside/)
    await backupRepository(source, backup)
    await fs.mkdir(restored)
    await expect(restoreRepository(backup, restored)).rejects.toThrow(/already exists/)
    await put(restored, 'keep', 'untouched')
    await expect(restoreRepository(backup, restored)).rejects.toThrow(/already exists/)
    expect(await fs.readFile(path.join(restored, 'keep'), 'utf8')).toBe('untouched')
  })

  it('rejects source and payload symlinks, including symlink ancestors and manifest files', async () => {
    await fixture()
    await fs.symlink(path.join(source, 'notes/a.md'), path.join(source, 'notes/link.md'))
    await expect(backupRepository(source, backup)).rejects.toThrow(/symlink/i)
    await absent(backup)
    await fs.unlink(path.join(source, 'notes/link.md'))
    const alias = path.join(directory, 'alias')
    await fs.symlink(source, alias)
    await expect(backupRepository(alias, backup)).rejects.toThrow(/symlink/i)
    await expect(backupRepository(source, path.join(alias, 'backup'))).rejects.toThrow(/symlink/i)
    await backupRepository(source, backup)
    const payloadNote = path.join(backup, 'payload/notes/a.md')
    await fs.unlink(payloadNote); await fs.symlink(path.join(source, 'notes/a.md'), payloadNote)
    await expect(restoreRepository(backup, restored)).rejects.toThrow(/symlink/i)
    await fs.unlink(payloadNote); await fs.writeFile(payloadNote, note)
    await fs.rename(path.join(backup, 'manifest.json'), path.join(directory, 'manifest.json'))
    await fs.symlink(path.join(directory, 'manifest.json'), path.join(backup, 'manifest.json'))
    await expect(restoreRepository(backup, restored)).rejects.toThrow(/symlink/i)
    await absent(restored)
  })

  it('rejects non-regular files without blocking on a FIFO', async () => {
    await fixture()
    await promisify(execFile)('mkfifo', [path.join(source, 'notes/pipe')])
    await expect(backupRepository(source, backup)).rejects.toThrow(/regular files/)
    await absent(backup)
  })

  it.skipIf(process.platform === 'darwin')('rejects case-ambiguous source paths', async () => {
    await fixture(); await put(source, 'notes/A.md', 'different')
    await expect(backupRepository(source, backup)).rejects.toThrow(/case-ambiguous/)
    await absent(backup)
  })

  it.each(['private-settings', 'local/private-settings', 'notes/private-settings'])('excludes the whole configuration subtree at %s, including API and OAuth credentials', async relative => {
    await fixture()
    const config = path.join(source, relative)
    vi.stubEnv('SIDEMIND_CONFIG_DIR', config)
    await put(config, 'model.json', 'fake-api-credential')
    await put(config, 'oauth/token.json', 'fake-oauth-credential')
    await backupRepository(source, backup); await restoreRepository(backup, restored)
    await absent(path.join(restored, relative))
    expect(JSON.stringify(await tree(backup))).not.toContain(Buffer.from('fake-api-credential').toString('base64'))
    expect(await fs.readFile(path.join(config, 'oauth/token.json'), 'utf8')).toBe('fake-oauth-credential')
    expect(await fs.readFile(path.join(restored, 'local/conversations/one.json'), 'utf8')).toContain('draft')
  })

  it.each(['', 'notes', 'local', 'research', 'cache', 'cache/conversations', 'local/proposals'])('rejects configuration overlap with essential data: %s', async relative => {
    await fixture(1)
    vi.stubEnv('SIDEMIND_CONFIG_DIR', path.join(source, relative))
    await expect(backupRepository(source, backup)).rejects.toThrow(/overlaps/)
    await absent(backup)
  })

  it('excludes credentials reached through an outside configuration alias', async () => {
    await fixture()
    const config = path.join(source, 'local/private-settings'), alias = path.join(directory, 'config-alias')
    await put(config, 'oauth.json', 'fake-token')
    await fs.symlink(config, alias)
    vi.stubEnv('SIDEMIND_CONFIG_DIR', alias)
    await backupRepository(source, backup); await restoreRepository(backup, restored)
    await absent(path.join(restored, 'local/private-settings'))
  })

  it.each(['edit', 'add'])('fails and cleans up when an external writer changes the source during copying (%s)', async change => {
    await fixture()
    const open = fs.open.bind(fs)
    let changed = false
    vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
      if (!changed && flags === 'wx') {
        changed = true
        await put(source, change === 'edit' ? 'notes/a.md' : 'notes/new.md', 'external write')
      }
      return open(file, flags, mode)
    })
    await expect(backupRepository(source, backup)).rejects.toThrow(/changed/i)
    expect(changed).toBe(true)
    await absent(backup); await noTemporaryDirectories()
    expect(await fs.readFile(path.join(source, change === 'edit' ? 'notes/a.md' : 'notes/new.md'), 'utf8')).toBe('external write')
  })

  it('cleans up only its own staging directory after a restore copy failure', async () => {
    await fixture(); await backupRepository(source, backup)
    const unrelated = path.join(directory, '.sidemind-restore-unrelated')
    await put(unrelated, 'keep', 'untouched')
    const before = await tree(backup), open = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
      if (flags === 'wx') throw new Error('Injected disk write failure')
      return open(file, flags, mode)
    })
    await expect(restoreRepository(backup, restored)).rejects.toThrow(/disk write failure/)
    await absent(restored)
    expect(await tree(backup)).toEqual(before)
    expect((await fs.readdir(directory)).filter(name => name.startsWith('.sidemind-restore-'))).toEqual(['.sidemind-restore-unrelated'])
    expect(await fs.readFile(path.join(unrelated, 'keep'), 'utf8')).toBe('untouched')
  })

  it('does not overwrite a destination created by another process during copying', async () => {
    await fixture(); await backupRepository(source, backup)
    const open = fs.open.bind(fs)
    let created = false
    vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
      if (!created && flags === 'wx') { created = true; await fs.mkdir(restored) }
      return open(file, flags, mode)
    })
    await expect(restoreRepository(backup, restored)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await fs.readdir(restored)).toEqual([])
    await noTemporaryDirectories()
  })

  it('CLI prints offline-only instructions and performs a byte-preserving round trip', async () => {
    await fixture()
    const run = promisify(execFile), cli = path.resolve('server/backup-cli.ts')
    const saved = await run(process.execPath, ['--import', 'tsx', cli, 'backup', source, backup])
    expect(saved.stderr).toContain('server MUST be stopped')
    expect(saved.stdout).toContain(backup)
    expect(saved.stdout).not.toContain('draft')
    const loaded = await run(process.execPath, ['--import', 'tsx', cli, 'restore', backup, restored])
    expect(loaded.stdout).toContain(restored)
    expect(await fs.readFile(path.join(restored, 'notes/assets/image.bin'))).toEqual(attachment)
    await expect(run(process.execPath, ['--import', 'tsx', cli])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Usage:') })
  })
})
