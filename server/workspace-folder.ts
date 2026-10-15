import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const launchDirectory: Launcher = (command, args) => {
  if (command !== 'explorer.exe') return execute(command, args, { timeout: 8000, maxBuffer: 65536, windowsHide: true })
  // Explorer may keep its process alive with the window: never time out and kill it.
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { shell: false, detached: true, stdio: 'ignore', windowsHide: true })
    child.once('error', reject)
    child.once('spawn', () => { child.unref(); resolve() })
  })
}
type Launcher = (command: string, args: string[]) => Promise<unknown>
export class FolderOpenError extends Error {}

/** Receives a workspace directory validated by NoteStore, never an unchecked client path. */
export async function openWorkspaceFolder(root: string, platform: NodeJS.Platform = process.platform, launch: Launcher = launchDirectory) {
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'explorer.exe' : platform === 'linux' ? 'xdg-open' : null
  if (!command) throw new FolderOpenError('此系统暂不支持打开文件夹，请在文件管理器中打开设置页显示的工作区路径。')
  if (!path.isAbsolute(root) || !(await fs.stat(root).catch(() => null))?.isDirectory()) throw new FolderOpenError('笔记文件夹不存在或暂时无法访问。')
  try { await launch(command, [root]) }
  catch { throw new FolderOpenError('无法打开文件管理器。请在文件管理器中打开设置页显示的工作区路径。') }
}
