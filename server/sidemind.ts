import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Names that identify Sidemind's own data and settings. The old product names (Canvas Note: `canvasnote.json`,
 * `canvas-note-repo`, `CANVAS_*`, `~/.config/canvas-note`) are only ever read, to recognise and carry over older data;
 * nothing new is written under them except the one refusal marker described below.
 */
export const REPO_MARKER = 'sidemind.json'
export const REPO_FORMAT = 'sidemind-repo'
export const REPO_VERSION = 1
export const BACKUP_FORMAT = 'sidemind-backup'

export const LEGACY_MARKER = 'canvasnote.json'
export const LEGACY_FORMAT = 'canvas-note-repo'
export const LEGACY_BACKUP_FORMAT = 'canvas-note-backup'
/**
 * Sidemind keeps a marker under the old name with a version no Canvas Note release understands, so an old Canvas Note
 * pointed at a Sidemind directory refuses to open it instead of taking it for an old notes folder and moving its contents.
 */
export const GUARD_VERSION = 99
export const guardMarker = () => ({ format: LEGACY_FORMAT, version: GUARD_VERSION, note: 'This directory belongs to Sidemind. Older Canvas Note versions must not open it.' })

/** `SIDEMIND_<NAME>`, falling back to the old `CANVAS_<NAME>` so existing launch scripts keep working. */
export const setting = (name: string, source: NodeJS.ProcessEnv = process.env): string | undefined => source['SIDEMIND_' + name] || source['CANVAS_' + name] || undefined

const under = (...segments: string[]) => path.join(...segments)

/** Where private model connections live (outside the notes folder). An explicit override is used as given. */
export function configDirectory(source: NodeJS.ProcessEnv = process.env): string {
  const override = setting('CONFIG_DIR', source)
  if (override) return path.resolve(override)
  if (process.platform === 'darwin') return under(os.homedir(), 'Library', 'Application Support', 'Sidemind', 'connections')
  if (process.platform === 'win32') return under(source.APPDATA || os.homedir(), 'Sidemind', 'connections')
  return path.resolve(source.XDG_CONFIG_HOME || under(os.homedir(), '.config'), 'sidemind', 'connections')
}

/** Where Canvas Note kept them. */
export function legacyConfigDirectory(source: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === 'darwin') return under(os.homedir(), 'Library', 'Application Support', 'CanvasNote', 'connections')
  if (process.platform === 'win32') return under(source.APPDATA || os.homedir(), 'CanvasNote', 'connections')
  return path.resolve(source.XDG_CONFIG_HOME || under(os.homedir(), '.config'), 'canvas-note', 'connections')
}

/**
 * The first time Sidemind runs with the default settings location and Canvas Note's exists, copy the saved connections over
 * (never delete or change the originals). Not done when the location is set explicitly. Returns how many files were copied.
 */
export function adoptLegacyConnections(source: NodeJS.ProcessEnv = process.env): number {
  if (setting('CONFIG_DIR', source)) return 0
  const target = configDirectory(source), legacy = legacyConfigDirectory(source)
  if (fs.existsSync(target) || !fs.existsSync(legacy)) return 0
  let copied = 0
  try {
    fs.mkdirSync(target, { recursive: true, mode: 0o700 })
    for (const name of fs.readdirSync(legacy)) {
      const from = path.join(legacy, name)
      if (!fs.lstatSync(from).isFile()) continue
      fs.copyFileSync(from, path.join(target, name), fs.constants.COPYFILE_EXCL)
      fs.chmodSync(path.join(target, name), 0o600)
      copied++
    }
  } catch { /* a failed copy leaves the connections to be entered again; never block startup */ }
  return copied
}
