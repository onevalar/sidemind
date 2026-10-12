import fs from 'node:fs/promises'
import { lock } from 'proper-lockfile'
import { StorageError } from './persistence'

/** Cooperative local ownership; the sibling lock is never part of user data or backups. */
export async function acquireWorkspace(root: string): Promise<() => Promise<void>> {
  const canonical = await fs.realpath(root)
  try {
    return await lock(canonical, {
      stale: 60000, update: 10000, retries: 0,
      // A lost lease must not leave an old server or backup process issuing more writes.
      onCompromised: () => {
        console.error('工作区占用锁已失效。为保护数据，进程已停止；请关闭其他写入程序后再启动。')
        process.exit(1)
      },
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOCKED') throw new StorageError('工作区正被另一服务或备份任务占用。请先停止它；异常退出后最多等待一分钟再试。')
    throw error
  }
}
