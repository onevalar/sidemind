import fs from 'node:fs/promises'
import { lock } from 'proper-lockfile'
import { StorageError } from './persistence'

/** Cooperative local ownership; the sibling lock is never part of user data or backups. */
export async function acquireWorkspace(root: string, options: { /** Keep trying this long (ms) when the lock is held, instead of failing at once. */ wait?: number; stale?: number } = {}): Promise<() => Promise<void>> {
  const canonical = await fs.realpath(root)
  const stale = options.stale ?? 60000, deadline = Date.now() + (options.wait ?? 0)
  for (let announced = false; ; announced = true) {
    try { return await acquire(canonical, stale) }
    catch (error) {
      // A process that was killed leaves its lease behind until it goes stale. A server restarted at once by its supervisor
      // should wait that out rather than exit and be restarted in a loop until the supervisor gives up.
      if (!(error instanceof StorageError) || Date.now() >= deadline) throw error
      if (!announced) console.error('工作区占用锁尚未过期（上一个进程可能异常退出）。等待它过期后继续启动……')
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  }
}

async function acquire(canonical: string, stale: number): Promise<() => Promise<void>> {
  try {
    return await lock(canonical, {
      stale, update: Math.min(10000, Math.max(250, Math.floor(stale / 6))), retries: 0,
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
