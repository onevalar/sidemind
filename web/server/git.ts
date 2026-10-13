import { execFile } from 'node:child_process'

export class GitError extends Error {
  constructor(message: string, readonly stderr = '', readonly code: number | null = null) { super(message) }
}

/**
 * Thin wrapper over the system `git` binary. Authentication is whatever the user's
 * git already uses (SSH keys, credential helpers); the app never stores git passwords.
 */
export class Git {
  constructor(readonly root: string, private binary = process.env.CANVAS_GIT_BINARY || 'git') {}

  run(args: string[], options: { input?: string; timeout?: number; allowFailure?: boolean } = {}): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve, reject) => {
      const child = execFile(this.binary, ['-C', this.root, '-c', 'core.quotepath=false', '-c', 'core.autocrlf=false', ...args], {
        timeout: options.timeout ?? 60000, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: 'utf8',
        // Never block on an interactive credential prompt inside the server.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: process.env.GIT_ASKPASS ?? '', LC_ALL: 'C' },
      }, (error, stdout, stderr) => {
        const code = error ? (typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? (error as unknown as { code: number }).code : null) : 0
        if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') return reject(new GitError('未找到 git，请先安装 Git 后再推送。'))
        if (error && !options.allowFailure) return reject(new GitError('git ' + args[0] + ' 失败：' + (stderr || error.message).trim().slice(0, 600), stderr, code))
        resolve({ stdout, stderr, code: code ?? 1 })
      })
      if (options.input !== undefined) child.stdin?.end(options.input)
    })
  }

  async available(): Promise<boolean> {
    try { await this.run(['--version']); return true } catch { return false }
  }

  async isRepository(): Promise<boolean> {
    const { stdout, code } = await this.run(['rev-parse', '--show-toplevel'], { allowFailure: true })
    if (code !== 0) return false
    const { realpath } = await import('node:fs/promises')
    return (await realpath(stdout.trim()).catch(() => '')) === await realpath(this.root)
  }

  async init(): Promise<void> {
    await this.run(['init', '-q', '-b', 'main']).catch(() => this.run(['init', '-q']))
  }

  async head(): Promise<string | null> {
    const { stdout, code } = await this.run(['rev-parse', '--verify', '-q', 'HEAD'], { allowFailure: true })
    return code === 0 ? stdout.trim() : null
  }

  async branch(): Promise<string> {
    const { stdout } = await this.run(['symbolic-ref', '--short', '-q', 'HEAD'], { allowFailure: true })
    return stdout.trim() || 'main'
  }

  /** Content of a path at a revision, or null if it did not exist there. */
  async show(revision: string, file: string): Promise<string | null> {
    const { stdout, code } = await this.run(['show', `${revision}:${file}`], { allowFailure: true })
    return code === 0 ? stdout : null
  }

  async identityArgs(): Promise<string[]> {
    const name = (await this.run(['config', 'user.name'], { allowFailure: true })).stdout.trim()
    const email = (await this.run(['config', 'user.email'], { allowFailure: true })).stdout.trim()
    return [...(name ? [] : ['-c', 'user.name=Sidemind']), ...(email ? [] : ['-c', 'user.email=sidemind@localhost'])]
  }

  /** Staged changes against HEAD with rename detection. Paths are repository-relative. */
  async stagedChanges(): Promise<{ status: string; path: string; from?: string }[]> {
    const head = await this.head()
    const args = head ? ['diff', '--cached', '--name-status', '-M', '-z', 'HEAD'] : ['diff', '--cached', '--name-status', '-z', '--root', '4b825dc642cb6eb9a060e54bf8d69288fbee4904']
    const { stdout } = await this.run(args)
    const parts = stdout.split('\0').filter(part => part !== '')
    const changes: { status: string; path: string; from?: string }[] = []
    for (let index = 0; index < parts.length;) {
      const status = parts[index++]!
      if (status.startsWith('R') || status.startsWith('C')) { const from = parts[index++]!, to = parts[index++]!; changes.push({ status: status[0]!, path: to, from }) }
      else changes.push({ status: status[0]!, path: parts[index++]! })
    }
    return changes
  }

  async workingChanges(): Promise<string[]> {
    const { stdout } = await this.run(['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    const entries = stdout.split('\0').filter(Boolean)
    const paths: string[] = []
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]!
      paths.push(entry.slice(3))
      if (entry[0] === 'R' || entry[0] === 'C') index++
    }
    return paths
  }

  async remoteUrl(name = 'origin'): Promise<string | null> {
    const { stdout, code } = await this.run(['remote', 'get-url', name], { allowFailure: true })
    return code === 0 ? stdout.trim() || null : null
  }

  async setRemote(url: string | null, name = 'origin'): Promise<void> {
    const current = await this.remoteUrl(name)
    if (!url) { if (current) await this.run(['remote', 'remove', name]); return }
    await this.run(current ? ['remote', 'set-url', name, url] : ['remote', 'add', name, url])
  }

  /** Commits ahead of the upstream, or null when there is no upstream yet. */
  async ahead(): Promise<number | null> {
    const { stdout, code } = await this.run(['rev-list', '--count', '@{upstream}..HEAD'], { allowFailure: true })
    return code === 0 ? Number(stdout.trim()) || 0 : null
  }
}
