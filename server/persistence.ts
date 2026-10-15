import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'

export class StorageError extends Error {}

/** Records are published only after their complete contents have reached the filesystem. */
export async function writeRecord(file: string, value: unknown): Promise<void> {
  await writeData(file, JSON.stringify(value) + '\n')
}

/** Atomic publication, including new files: an interrupted write never exposes partial bytes. */
export async function writeData(file: string, value: string | Buffer, exclusive = false): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = path.join(path.dirname(file), '.' + path.basename(file) + '.' + randomUUID() + '.tmp')
  try {
    const handle = await fs.open(temporary, 'wx', 0o600)
    try { await handle.writeFile(value); await handle.sync() }
    finally { await handle.close() }
    if (exclusive) await fs.link(temporary, file)
    else await fs.rename(temporary, file)
  } finally { await fs.rm(temporary, { force: true }) }
}

export async function readRecord<T>(file: string): Promise<T | null> {
  try {
    const value = JSON.parse(await fs.readFile(file, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected record')
    return value as T
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new StorageError('无法读取保存记录，请保留文件并从备份检查恢复：' + file)
  }
}

/** One reentrant queue per workspace. Nested store calls belong to the same transaction. */
export class WorkspaceWriter {
  private tail: Promise<unknown> = Promise.resolve()
  private context = new AsyncLocalStorage<{ active: boolean }>()
  private failure: string | null = null

  halt(message: string) { this.failure = message }

  async run<T>(action: () => Promise<T>): Promise<T> {
    if (this.failure) throw new StorageError(this.failure)
    if (this.context.getStore()?.active) return action()
    const execute = async () => {
      if (this.failure) throw new StorageError(this.failure)
      const token = { active: true }
      return this.context.run(token, async () => {
        try { return await action() } finally { token.active = false }
      })
    }
    const result = this.tail.then(execute, execute)
    this.tail = result.catch(() => undefined)
    return result
  }
}

const writers = new Map<string, WorkspaceWriter>()
export function workspaceWriter(root: string): WorkspaceWriter {
  const key = path.resolve(root)
  if (!writers.has(key)) writers.set(key, new WorkspaceWriter())
  return writers.get(key)!
}
