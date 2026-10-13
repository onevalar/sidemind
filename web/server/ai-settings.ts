import { adoptLegacyConnections, configDirectory, setting } from './sidemind'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash, randomUUID } from 'node:crypto'

export const DEFAULT_AI_URL = 'https://api.openai.com/v1'
export type AIConnection = { model: string; baseUrl: string; key: string }
export type AIConnectionInput = { model: string; baseUrl: string; key?: string }
export class AISettingsError extends Error {}

export function normalizeAIUrl(value: string): string {
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new AISettingsError('请输入完整的模型服务地址。') }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new AISettingsError('模型服务需要 HTTPS；本机服务可使用 HTTP。')
  if (url.username || url.password || url.search || url.hash) throw new AISettingsError('服务地址不能包含账号、密钥、查询参数或锚点。')
  if (/\/(chat\/completions|embeddings)\/?$/.test(url.pathname)) throw new AISettingsError('请输入服务的基础地址，通常以 /v1 结尾。')
  return url.toString().replace(/\/+$/, '')
}

function validate(input: AIConnectionInput): AIConnectionInput {
  if (!input || typeof input.model !== 'string' || !input.model.trim() || input.model.length > 200 || typeof input.baseUrl !== 'string' || input.baseUrl.length > 2000 || (input.key !== undefined && typeof input.key !== 'string')) throw new AISettingsError('请填写模型名称和服务地址。')
  const key = input.key?.trim()
  if (key && (key.length > 8192 || /\s|[\x00-\x1f\x7f]/.test(key))) throw new AISettingsError('密钥格式无效，请重新输入。')
  return { model: input.model.trim(), baseUrl: normalizeAIUrl(input.baseUrl), key }
}

function defaultDirectory(): string {
  adoptLegacyConnections()
  return configDirectory()
}

/** Private server settings live outside the notes folder and are scoped to its path. */
export type ModelSlot = 'main' | 'summary' | 'embedding'
export const MODEL_SLOTS: ModelSlot[] = ['main', 'summary', 'embedding']

export class AISettings {
  readonly file: string
  private queue: Promise<unknown> = Promise.resolve()
  /** One connection per slot: the main chat model, the cheap summary/check model and the embedding service. */
  constructor(private workspace: string, private directory = defaultDirectory(), private environment: NodeJS.ProcessEnv = process.env, readonly slot: ModelSlot = 'main') {
    this.file = path.join(directory, createHash('sha256').update(path.resolve(workspace)).digest('hex').slice(0, 24) + (slot === 'main' ? '' : '.' + slot) + '.json')
    // Environment variables only ever describe the main connection.
    if (slot !== 'main') this.environment = {}
  }
  forSlot(slot: ModelSlot): AISettings { return new AISettings(this.workspace, this.directory, this.environment, slot) }
  private async read(): Promise<{ connection: AIConnection | null; source: 'saved' | 'environment' | 'none' }> {
    let raw: string
    try { raw = await fs.readFile(this.file, 'utf8') }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new AISettingsError('无法读取本机的模型连接设置。')
      const key = setting('AI_API_KEY', this.environment) || setting('AI_KEY', this.environment) || ''
      const model = setting('AI_MODEL', this.environment) || ''
      if (!key || !model) return { connection: null, source: 'none' }
      const config = validate({ model, baseUrl: setting('AI_BASE_URL', this.environment) || DEFAULT_AI_URL, key })
      return { connection: config as AIConnection, source: 'environment' }
    }
    try {
      const data = JSON.parse(raw)
      if (data.version !== 1) throw new Error()
      if (data.disabled === true) return { connection: null, source: 'saved' }
      const config = validate(data)
      if (!config.key) throw new Error()
      return { connection: config as AIConnection, source: 'saved' }
    } catch { throw new AISettingsError('本机的模型连接设置无法读取，请重新保存或移除连接。') }
  }
  async connection(): Promise<AIConnection | null> { return (await this.read()).connection }
  async publicConfig() {
    try {
      const { connection, source } = await this.read()
      return { configured: Boolean(connection), keySaved: Boolean(connection?.key), model: connection?.model || '', baseUrl: connection?.baseUrl || DEFAULT_AI_URL, source }
    } catch (error) {
      if (!(error instanceof AISettingsError)) throw error
      // Keep the settings form usable for explicit repair; connection() still fails closed.
      return { configured: false, keySaved: false, model: '', baseUrl: DEFAULT_AI_URL, source: 'none' as const, error: error.message }
    }
  }
  private async write(value: unknown): Promise<void> {
    const directory = path.dirname(this.file)
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    const tmp = this.file + '.' + randomUUID() + '.tmp'
    try {
      await fs.writeFile(tmp, JSON.stringify(value), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      await fs.rename(tmp, this.file)
    } catch {
      await fs.rm(tmp, { force: true }).catch(() => {})
      throw new AISettingsError('无法保存本机的模型连接设置，原连接未更改。')
    }
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => {}).then(action)
    this.queue = next
    return next
  }
  async resolve(input: AIConnectionInput): Promise<AIConnection> {
    const config = validate(input)
    const current = config.key ? null : await this.connection()
    const key = config.key || (current?.baseUrl === config.baseUrl ? current.key : '')
    if (!key) throw new AISettingsError('请输入这个服务的 API 密钥。切换地址时，需要重新填写密钥。')
    return { ...config, key }
  }
  async save(input: AIConnectionInput) {
    return this.serial(async () => {
      const config = await this.resolve(input)
      await this.write({ version: 1, ...config })
      return this.publicConfig()
    })
  }
  async clear() {
    return this.serial(async () => {
      // Explicit disconnection must not resurrect an environment key on restart.
      await this.write({ version: 1, disabled: true })
      return this.publicConfig()
    })
  }
}
