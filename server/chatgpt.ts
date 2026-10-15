import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { createRemoteJWKSet, customFetch, jwtVerify, type RemoteJWKSet } from 'jose'
import type { PublicChatGPTConfig } from '../shared/types'
import type { AICall, AIMessage, AITool, AITurn } from './ai'

const ISSUER = 'https://auth.openai.com'
const AUTHORIZE = ISSUER + '/api/accounts/authorize'
const TOKEN = ISSUER + '/api/accounts/oauth/token'
const RESOURCE = 'https://api.openai.com/v1'
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
const PLAN_SCOPES = ['resource.invoke', 'chatgpt.tokens.use.direct']
const INSTRUCTIONS = 'Rewrite the supplied Markdown according to the instruction. Return ONLY the replacement Markdown, without an explanation or an outer code fence. Never modify content outside the supplied source.'
const MAX_JSON = 1024 * 1024
const MAX_OUTPUT = 8 * 1024 * 1024
const credentialWrites = new Map<string, Promise<unknown>>()

type Tokens = { accessToken: string; refreshToken: string; idToken: string; scopes: string[]; expiresAt: number }
type Account = { id: string; label: string; email: string; subject: string; clientId: string; model: string; tokens?: Tokens }
type Saved = { version: 1; hostId: string; accounts: Account[]; activeAccountId: string | null }
type Attempt = {
  server: Server; redirectUri: string; state: string; nonce: string; verifier: string
  account?: Account; controller: AbortController; timer: NodeJS.Timeout; consumed: boolean
}
type Model = { slug: string; displayName: string }

/** All messages are app-owned: never expose a remote error body or a credential. */
export class ChatGPTError extends Error {
  constructor(message: string, readonly unusableTokens = false) { super(message); this.name = 'ChatGPTError' }
}
const authError = () => new ChatGPTError('ChatGPT 登录验证失败，请重新连接。')
const storageError = () => new ChatGPTError('无法读取或保存本机 ChatGPT 连接，请检查私有配置文件及权限。')
const permissionError = () => new ChatGPTError('尚未授权使用 ChatGPT 方案，请重新连接并允许方案使用；可在 https://chatgpt.com/settings/usage 管理授权。')
const hasPlan = (tokens?: Tokens) => Boolean(tokens && PLAN_SCOPES.every(scope => tokens.scopes.includes(scope)))
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function safeRemoteError(status: number, data: unknown, refresh = false): ChatGPTError {
  const record = data as { error?: { code?: unknown } | string } | null
  const code = typeof record?.error === 'string' ? record.error : record?.error?.code
  if (refresh && ['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'].includes(String(code))) {
    return new ChatGPTError('ChatGPT 会话已失效，请重新连接。', true)
  }
  if (code === 'invalid_client') return new ChatGPTError('ChatGPT 客户端注册无效，请检查连接注册配置。')
  if (status === 429 || code === 'subscription_sharing_usage_limit_exceeded') return new ChatGPTError('ChatGPT 方案或应用使用额度已达上限，请在 https://chatgpt.com/settings/usage 查看限额后重试。')
  if (code === 'subscription_sharing_user_not_eligible') return new ChatGPTError('当前 ChatGPT 用户、工作区或策略不允许方案使用，请检查 ChatGPT 设置；重复登录不会解除此限制。')
  if (code === 'subscription_sharing_unsupported_capability' || code === 'subscription_sharing_route_not_supported') return new ChatGPTError('ChatGPT 不支持本次请求的模型、功能或路由，请检查模型与连接配置。')
  if (status === 401 || code === 'subscription_sharing_invalid_user') return new ChatGPTError('ChatGPT 身份或方案授权未被接受，请检查所选账号并重新连接。')
  if (status === 403 || code === 'chatpass_v2_scope_not_authorized' || code === 'chatpass_v2_invalid_authorization_context') return new ChatGPTError('ChatGPT 方案授权、地区或策略限制了请求，请检查授权与使用设置。')
  if (status >= 500 || code === 'subscription_sharing_usage_unavailable' || code === 'subscription_sharing_user_unavailable') return new ChatGPTError('ChatGPT 服务或方案用量检查暂不可用，连接已保留，请稍后重试。')
  return new ChatGPTError('ChatGPT 请求失败，请检查连接及模型设置后重试。')
}

function aborted(signal: AbortSignal): ChatGPTError {
  return new ChatGPTError(signal.reason?.name === 'TimeoutError' ? 'ChatGPT 请求超时，请稍后重试。' : 'ChatGPT 请求已取消。')
}
async function interruptible<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void promise.catch(() => {}); throw aborted(signal) }
  let listener: () => void = () => {}
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      listener = () => reject(aborted(signal))
      signal.addEventListener('abort', listener, { once: true })
    })])
  } finally { signal.removeEventListener('abort', listener) }
}
async function jsonBody(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new ChatGPTError('ChatGPT 返回了无效响应。')
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let body = '', size = 0
  try {
    for (;;) {
      const { value, done } = await interruptible(reader.read(), signal)
      if (done) break
      size += value.byteLength
      if (size > MAX_JSON) throw new Error()
      body += decoder.decode(value, { stream: true })
    }
    return JSON.parse(body + decoder.decode()) as unknown
  } catch (error) {
    if (signal.aborted) throw aborted(signal)
    if (error instanceof ChatGPTError) throw error
    throw new ChatGPTError('ChatGPT 返回了无效响应。')
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
}

/** Server-only OAuth credentials. The caller supplies a private path OUTSIDE the notes directory. */
export class ChatGPTConnection {
  private readonly file: string
  private readonly transport: typeof fetch
  private pending?: Attempt
  private starting = false
  private generation = 0
  private loginStatus: PublicChatGPTConfig['loginStatus'] = 'idle'
  private error?: string
  private discovery?: { jwks: RemoteJWKSet; revocation?: string }
  private readonly requests = new Map<string, Set<AbortController>>()

  constructor(file: string, options: { transport?: typeof fetch } = {}) {
    this.file = path.resolve(file)
    this.transport = options.transport ?? fetch
  }

  private async read(): Promise<Saved> {
    try {
      const stat = await fs.lstat(this.file)
      if (!stat.isFile() || stat.size > MAX_JSON || (process.getuid && stat.uid !== process.getuid())) throw new Error()
      if (process.platform !== 'win32') await fs.chmod(this.file, 0o600)
      const value = JSON.parse(await fs.readFile(this.file, 'utf8')) as Saved
      if (value.version !== 1 || !text(value.hostId) || !uuid.test(value.hostId.replace(/^urn:uuid:/, '')) || !value.hostId.startsWith('urn:uuid:') || !Array.isArray(value.accounts) || value.accounts.length > 64) throw new Error()
      const ids = new Set<string>(), clients = new Set<string>()
      for (const account of value.accounts) {
        if (!account || !uuid.test(account.id) || !text(account.subject) || !text(account.clientId) || account.clientId === 'dynamic_agent_client' || !text(account.label) || typeof account.email !== 'string' || typeof account.model !== 'string' || ids.has(account.id) || clients.has(account.clientId)) throw new Error()
        ids.add(account.id); clients.add(account.clientId)
        const tokens = account.tokens
        if (tokens && (!text(tokens.accessToken) || !text(tokens.refreshToken) || !text(tokens.idToken) || !Number.isFinite(tokens.expiresAt) || !Array.isArray(tokens.scopes) || !tokens.scopes.every(scope => typeof scope === 'string'))) throw new Error()
      }
      if (value.activeAccountId !== null && !ids.has(value.activeAccountId)) throw new Error()
      return value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, hostId: 'urn:uuid:' + randomUUID(), accounts: [], activeAccountId: null }
      throw storageError()
    }
  }

  private async write(saved: Saved): Promise<void> {
    const tmp = this.file + '.' + randomUUID() + '.tmp'
    try {
      const serialized = JSON.stringify(saved)
      if (Buffer.byteLength(serialized) > MAX_JSON) throw storageError()
      const file = await fs.open(tmp, 'wx', 0o600)
      try { await file.writeFile(serialized, 'utf8'); await file.sync() } finally { await file.close() }
      await fs.rename(tmp, this.file)
    } catch { throw storageError() }
    finally { await fs.rm(tmp, { force: true }).catch(() => {}) }
  }

  /** The local service serializes writes and rotating refreshes, including shared connections. */
  private async locked<T>(action: (saved: Saved) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const abort = AbortSignal.any([AbortSignal.timeout(120000), ...(signal ? [signal] : [])])
    const run = (credentialWrites.get(this.file) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      if (abort.aborted) throw aborted(abort)
      try { await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 }) } catch { throw storageError() }
      return action(await this.read())
    })
    credentialWrites.set(this.file, run)
    try { return await run }
    finally { if (credentialWrites.get(this.file) === run) credentialWrites.delete(this.file) }
  }

  async publicConfig(): Promise<PublicChatGPTConfig> {
    try {
      const saved = await this.read()
      const active = saved.accounts.find(account => account.id === saved.activeAccountId)
      return {
        configured: Boolean(active?.model && hasPlan(active.tokens)),
        accounts: saved.accounts.map(account => ({ id: account.id, label: account.label, signedIn: Boolean(account.tokens) })),
        activeAccountId: saved.activeAccountId, model: active?.model ?? '', loginStatus: this.loginStatus,
        ...(this.error ? { error: this.error } : {}),
      }
    } catch { return { configured: false, accounts: [], activeAccountId: null, model: '', loginStatus: 'error', unavailable: true, error: storageError().message } }
  }

  private async json(url: string, init: RequestInit = {}, signal?: AbortSignal, refresh = false): Promise<unknown> {
    const abort = AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])])
    try {
      if (abort.aborted) throw aborted(abort)
      const response = await interruptible(this.transport(url, { ...init, redirect: 'error', signal: abort }), abort)
      let data: unknown
      try { data = await jsonBody(response, abort) }
      catch (error) { if (response.ok || abort.aborted) throw error }
      if (!response.ok) throw safeRemoteError(response.status, data, refresh)
      return data
    } catch (error) {
      if (abort.aborted) throw aborted(abort)
      if (error instanceof ChatGPTError) throw error
      throw new ChatGPTError('无法连接 ChatGPT 服务，请检查网络后重试。')
    }
  }

  private endpoint(value: unknown): string {
    if (!text(value)) throw authError()
    const url = new URL(value)
    if (url.origin !== ISSUER || url.username || url.password || url.search || url.hash) throw authError()
    return url.toString()
  }
  private async openid(signal?: AbortSignal) {
    if (this.discovery) return this.discovery
    const document = await this.json(ISSUER + '/.well-known/openid-configuration', {}, signal) as Record<string, unknown>
    if (!document || document.issuer !== ISSUER) throw authError()
    const jwks = createRemoteJWKSet(new URL(this.endpoint(document.jwks_uri)), {
      timeoutDuration: 15000, cooldownDuration: 0, cacheMaxAge: 600000,
      [customFetch]: (url, init) => this.transport(url, { ...init, redirect: 'error' }),
    })
    this.discovery = { jwks, revocation: document.revocation_endpoint ? this.endpoint(document.revocation_endpoint) : undefined }
    return this.discovery
  }

  private tokens(value: unknown, previous?: Tokens): Tokens {
    const data = value as Record<string, unknown> | null
    if (!data || !text(data.access_token) || data.token_type?.toString().toLowerCase() !== 'bearer' || typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in) || data.expires_in <= 0 || data.expires_in > 366 * 86400) throw authError()
    // OAuth may omit scope and refresh_token during renewal; retain the explicit original grant.
    const scopes = typeof data.scope === 'string' ? data.scope.split(/\s+/).filter(Boolean) : previous?.scopes ?? []
    const refreshToken = text(data.refresh_token) ? data.refresh_token : previous?.refreshToken
    const idToken = text(data.id_token) ? data.id_token : previous?.idToken
    if (!refreshToken || !idToken) throw authError()
    return { accessToken: data.access_token, refreshToken, idToken, scopes, expiresAt: Date.now() + data.expires_in * 1000 }
  }

  async startLogin(accountId?: string): Promise<{ authorizationUrl: string }> {
    if (this.starting || this.pending) throw new ChatGPTError('已有 ChatGPT 登录正在进行，请完成或取消后重试。')
    this.starting = true
    const generation = this.generation
    let server: Server | undefined
    try {
      const saved = await this.locked(async saved => { await this.write(saved); return saved })
      const account = accountId === undefined ? undefined : saved.accounts.find(account => account.id === accountId)
      if (accountId !== undefined && !account) throw new ChatGPTError('找不到所选 ChatGPT 账号，请重新选择。')
      if (!account && saved.accounts.length >= 64) throw new ChatGPTError('已达到本机 ChatGPT 注册数量上限。')
      const state = randomBytes(32).toString('base64url'), nonce = randomBytes(32).toString('base64url'), verifier = randomBytes(64).toString('base64url')
      server = createServer((request, response) => { void this.callback(request.method, request.url, response) })
      server.requestTimeout = 10000; server.headersTimeout = 10000
      await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve) })
      if (generation !== this.generation) throw new ChatGPTError('ChatGPT 登录已取消。')
      const address = server.address()
      if (!address || typeof address === 'string') throw authError()
      const redirectUri = `http://127.0.0.1:${address.port}/auth/callback`
      const controller = new AbortController()
      const timer = setTimeout(() => {
        if (this.pending?.controller !== controller) return
        this.loginStatus = 'error'; this.error = 'ChatGPT 登录已过期，请重新连接。'
        void this.clearAttempt(true)
      }, 10 * 60 * 1000)
      timer.unref()
      this.pending = { server, redirectUri, state, nonce, verifier, account, controller, timer, consumed: false }
      const url = new URL(AUTHORIZE)
      url.search = new URLSearchParams({
        client_id: account?.clientId ?? 'dynamic_agent_client', ext_agent_host_id: saved.hostId,
        response_type: 'code', redirect_uri: redirectUri, scope: SCOPE, resource: RESOURCE, state, nonce,
        code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        ...(!account ? { agent_name_hint: 'Sidemind' } : {}),
        ...(account?.tokens ? { id_token_hint: account.tokens.idToken } : {}),
        ...(account?.email ? { login_hint: account.email } : {}),
        ...(account && !hasPlan(account.tokens) ? { prompt: 'consent' } : {}),
      }).toString()
      this.loginStatus = 'waiting'; this.error = undefined
      return { authorizationUrl: url.toString() }
    } catch (error) {
      if (server) await this.close(server, true)
      if (error instanceof ChatGPTError) throw error
      throw new ChatGPTError('无法启动本机 ChatGPT 登录回调，请检查本机网络后重试。')
    } finally { this.starting = false }
  }

  private async close(server: Server, force: boolean): Promise<void> {
    await new Promise<void>(resolve => {
      server.close(() => resolve())
      server.closeIdleConnections()
      if (force) server.closeAllConnections()
    })
  }
  private async clearAttempt(force: boolean): Promise<void> {
    const attempt = this.pending
    this.pending = undefined
    if (!attempt) return
    clearTimeout(attempt.timer); attempt.controller.abort()
    await this.close(attempt.server, force)
  }
  async cancelLogin(): Promise<void> {
    this.generation++
    this.loginStatus = 'idle'; this.error = undefined
    await this.clearAttempt(true)
  }

  private async callback(method: string | undefined, rawUrl: string | undefined, response: ServerResponse): Promise<void> {
    response.setHeader('content-type', 'text/plain; charset=utf-8')
    response.setHeader('cache-control', 'no-store')
    response.setHeader('referrer-policy', 'no-referrer')
    response.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'")
    const attempt = this.pending
    let url: URL
    try { url = new URL(rawUrl ?? '/', 'http://127.0.0.1') }
    catch { response.writeHead(400); response.end('登录回调格式无效。'); return }
    if (!attempt || method !== 'GET' || url.pathname !== '/auth/callback' || attempt.consumed) {
      response.writeHead(404); response.end('找不到登录回调。'); return
    }
    attempt.consumed = true
    const signal = attempt.controller.signal
    try {
      const state = url.searchParams.get('state') ?? ''
      if (url.searchParams.getAll('state').length !== 1 || state.length !== attempt.state.length || !timingSafeEqual(Buffer.from(state), Buffer.from(attempt.state))) throw authError()
      if (url.searchParams.has('error')) throw new ChatGPTError('ChatGPT 登录或方案授权未完成，请重新连接并允许方案使用。')
      const code = url.searchParams.get('code'), issued = url.searchParams.get('client_id')
      if (!text(code) || url.searchParams.getAll('code').length !== 1 || url.searchParams.getAll('client_id').length > 1) throw authError()
      const clientId = attempt.account?.clientId ?? issued
      if (!text(clientId) || clientId === 'dynamic_agent_client' || (issued !== null && issued !== clientId)) throw authError()
      const raw = await this.json(TOKEN, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: attempt.verifier, redirect_uri: attempt.redirectUri, resource: RESOURCE }),
      }, signal)
      const tokens = this.tokens(raw)
      const { jwks } = await this.openid(signal)
      let identity
      try {
        identity = (await interruptible(jwtVerify(tokens.idToken, jwks, {
          issuer: ISSUER, audience: clientId, requiredClaims: ['sub', 'exp', 'iat', 'nonce'],
          algorithms: ['RS256', 'PS256', 'ES256', 'EdDSA'], clockTolerance: 5,
        }), signal)).payload
      } catch { throw authError() }
      if (!text(identity.sub) || identity.nonce !== attempt.nonce || (attempt.account && identity.sub !== attempt.account.subject)) throw authError()
      let catalog: Model[] = [], catalogError: ChatGPTError | undefined
      if (hasPlan(tokens)) {
        try { catalog = await this.catalog(tokens, signal) }
        catch (error) { catalogError = error instanceof ChatGPTError ? error : authError() }
      }
      await this.locked(async saved => {
        if (signal.aborted || this.pending !== attempt) throw aborted(signal)
        const existing = saved.accounts.find(account => account.clientId === clientId)
        if (existing && existing.subject !== identity.sub) throw authError()
        if (attempt.account && (!existing || existing.id !== attempt.account.id)) throw authError()
        if (!existing && saved.accounts.length >= 64) throw new ChatGPTError('已达到本机 ChatGPT 注册数量上限。')
        const account: Account = {
          id: existing?.id ?? randomUUID(), clientId, subject: identity.sub!,
          email: typeof identity.email === 'string' ? identity.email : existing?.email ?? '',
          label: existing?.label ?? `${typeof identity.email === 'string' ? identity.email : 'ChatGPT 账号'} · 注册 ${saved.accounts.length + 1}`,
          model: catalog[0]?.slug ?? '', tokens,
        }
        if (existing) saved.accounts[saved.accounts.indexOf(existing)] = account
        else saved.accounts.push(account)
        if (hasPlan(tokens) && catalog.length && !catalogError) saved.activeAccountId = account.id
        await this.write(saved)
      }, signal)
      if (!hasPlan(tokens)) throw permissionError()
      if (catalogError) throw catalogError
      if (!catalog.length) throw new ChatGPTError('当前 ChatGPT 账号没有可用模型，请检查方案及工作区设置。')
      if (this.pending !== attempt) return
      this.loginStatus = 'success'; this.error = undefined
      response.end('ChatGPT 已连接，可以关闭此页面并返回 Sidemind。')
    } catch (error) {
      if (this.pending !== attempt) return
      this.loginStatus = 'error'
      this.error = error instanceof ChatGPTError ? error.message : authError().message
      response.writeHead(400); response.end(this.error)
    } finally {
      if (this.pending === attempt) await this.clearAttempt(false)
    }
  }

  private async authorized(accountId: string, signal?: AbortSignal): Promise<Account> {
    return this.locked(async saved => {
      const account = saved.accounts.find(account => account.id === accountId)
      if (!account?.tokens) throw new ChatGPTError('ChatGPT 账号尚未连接，请先登录。')
      if (!hasPlan(account.tokens)) throw permissionError()
      if (account.tokens.expiresAt > Date.now() + 60000) return account
      try {
        const raw = await this.json(TOKEN, {
          method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'refresh_token', client_id: account.clientId, refresh_token: account.tokens.refreshToken, resource: RESOURCE }),
        }, signal, true)
        const replacement = this.tokens(raw, account.tokens)
        // Keep the validated ID token as the hint. A refresh is not a new login transaction.
        replacement.idToken = account.tokens.idToken
        account.tokens = replacement
        await this.write(saved)
        if (!hasPlan(replacement)) throw permissionError()
        return account
      } catch (error) {
        if (error instanceof ChatGPTError && error.unusableTokens) {
          delete account.tokens
          await this.write(saved)
        }
        throw error
      }
    }, signal)
  }

  private async catalog(tokens: Tokens, signal?: AbortSignal): Promise<Model[]> {
    const data = await this.json(RESOURCE + '/models', { headers: { authorization: 'Bearer ' + tokens.accessToken } }, signal) as { models?: unknown }
    if (!data || !Array.isArray(data.models)) throw new ChatGPTError('ChatGPT 模型列表无法读取，请稍后重试。')
    const result: Model[] = [], slugs = new Set<string>()
    for (const model of data.models as { slug?: unknown; display_name?: unknown; visibility?: unknown }[]) {
      if (model && model.visibility === 'list' && text(model.slug) && text(model.display_name) && !slugs.has(model.slug)) {
        result.push({ slug: model.slug, displayName: model.display_name }); slugs.add(model.slug)
      }
    }
    return result
  }
  async models(): Promise<Model[]> {
    const saved = await this.read()
    if (!saved.activeAccountId) throw new ChatGPTError('尚未选择 ChatGPT 账号，请先连接。')
    const account = await this.authorized(saved.activeAccountId)
    return this.catalog(account.tokens!)
  }

  async select(accountId: string | null, model?: string): Promise<PublicChatGPTConfig> {
    if (accountId === null) {
      await this.locked(async saved => { saved.activeAccountId = null; await this.write(saved) })
    } else {
      const account = await this.authorized(accountId)
      const models = await this.catalog(account.tokens!)
      const chosen = model ?? (models.some(model => model.slug === account.model) ? account.model : models[0]?.slug)
      if (!chosen || !models.some(model => model.slug === chosen)) throw new ChatGPTError('所选 ChatGPT 模型不可用，请从当前账号的模型列表重新选择。')
      await this.locked(async saved => {
        const current = saved.accounts.find(account => account.id === accountId)
        if (!current?.tokens || !hasPlan(current.tokens)) throw permissionError()
        current.model = chosen; saved.activeAccountId = accountId; await this.write(saved)
      })
    }
    this.error = undefined
    return this.publicConfig()
  }

  async signOut(accountId: string): Promise<PublicChatGPTConfig> {
    if (this.pending?.account?.id === accountId) await this.cancelLogin()
    for (const controller of this.requests.get(accountId) ?? []) controller.abort()
    let confirmed = true
    await this.locked(async saved => {
      const account = saved.accounts.find(account => account.id === accountId)
      if (!account) throw new ChatGPTError('找不到所选 ChatGPT 账号。')
      const tokens = account.tokens
      if (tokens) {
        confirmed = false
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const { revocation } = await this.openid()
            if (!revocation) break
            const signal = AbortSignal.timeout(15000)
            const response = await interruptible(this.transport(revocation, {
              method: 'POST', redirect: 'error', signal, headers: { 'content-type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({ token: tokens.refreshToken, token_type_hint: 'refresh_token', client_id: account.clientId }),
            }), signal)
            void response.body?.cancel().catch(() => {})
            if (response.status === 200) { confirmed = true; break }
            if (response.status < 500) break
          } catch { /* Never propagate a token-bearing transport error. */ }
          if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 250))
        }
      }
      delete account.tokens
      if (saved.activeAccountId === account.id) saved.activeAccountId = null
      await this.write(saved)
    })
    this.loginStatus = confirmed ? 'idle' : 'error'
    this.error = confirmed ? undefined : '已在本机退出，但无法确认远程会话已撤销。请在 ChatGPT 设置中断开此应用。'
    return this.publicConfig()
  }

  async propose(source: string, instruction: string, signal?: AbortSignal): Promise<string> {
    if (typeof source !== 'string' || typeof instruction !== 'string' || source.length > MAX_JSON || instruction.length > 16384) throw new ChatGPTError('所选内容或修改指令过长，请缩小范围后重试。')
    return (await this.respond(INSTRUCTIONS, [{ role: 'user', content: JSON.stringify({ instruction, source }) }], [], signal)).text
  }

  async chat(messages: AIMessage[], tools: AITool[], signal: AbortSignal, onDelta?: (text: string) => void): Promise<AITurn> {
    const input = messages.filter(message => message.role !== 'system').flatMap<unknown>(message => {
      if (message.role === 'tool') return [{ type: 'function_call_output', call_id: message.tool_call_id, output: message.content }]
      if (message.responseOutput) return message.responseOutput
      return [...(message.content ? [{ role: message.role, content: message.content }] : []), ...(message.tool_calls ?? []).map(call => ({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments }))]
    })
    return this.respond(messages.find(message => message.role === 'system')?.content ?? '', input, tools, signal, onDelta)
  }

  private async respond(instructions: string, input: unknown[], tools: AITool[], signal?: AbortSignal, onDelta?: (text: string) => void): Promise<AITurn> {
    const saved = await this.read()
    const id = saved.activeAccountId
    if (!id) throw new ChatGPTError('尚未选择 ChatGPT 账号，请先连接。')
    const controller = new AbortController()
    const abort = AbortSignal.any([AbortSignal.timeout(120000), controller.signal, ...(signal ? [signal] : [])])
    const requests = this.requests.get(id) ?? new Set<AbortController>()
    requests.add(controller); this.requests.set(id, requests)
    try {
      if (abort.aborted) throw aborted(abort)
      const account = await this.authorized(id, abort)
      const models = await this.catalog(account.tokens!, abort)
      if (!account.model || !models.some(model => model.slug === account.model)) throw new ChatGPTError('所选 ChatGPT 模型不可用，请重新选择模型。')
      if (abort.aborted) throw aborted(abort)
      const response = await interruptible(this.transport(RESOURCE + '/responses', {
        method: 'POST', redirect: 'error', signal: abort,
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + account.tokens!.accessToken },
        body: JSON.stringify({ model: account.model, instructions, input, store: false, stream: true, include: ['reasoning.encrypted_content'], ...(tools.length ? { tools: tools.map(tool => ({ type: 'function', ...tool.function })) } : {}) }),
      }), abort)
      if (!response.ok) {
        let data: unknown
        try { data = await jsonBody(response, abort) } catch { /* Safe status-only fallback. */ }
        throw safeRemoteError(response.status, data)
      }
      return await this.stream(response, abort, onDelta)
    } catch (error) {
      if (abort.aborted) throw aborted(abort)
      if (error instanceof ChatGPTError) throw error
      throw new ChatGPTError('ChatGPT 连接中断，未采用任何部分修改，请稍后重试。')
    } finally { requests.delete(controller); if (!requests.size) this.requests.delete(id) }
  }

  private async stream(response: Response, signal: AbortSignal, onDelta?: (text: string) => void): Promise<AITurn> {
    if (!response.body) throw new ChatGPTError('ChatGPT 未返回修改内容。')
    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let buffer = '', output = '', size = 0, event = '', data: string[] = []
    let completed: AITurn | null = null
    type OutputItem = { type: string; call_id?: string; name?: string; arguments?: string; content?: { type: string; text?: string }[] }
    // Some live Responses streams send complete items only in output_item.done,
    // with an empty terminal output array. Retain them, but never execute before completed.
    const finishedItems = new Map<number, OutputItem>()
    const consume = (): boolean => {
      if (!data.length) { event = ''; return false }
      const raw = data.join('\n'); data = []
      if (raw === '[DONE]') throw new ChatGPTError('ChatGPT 响应未完成，未采用任何部分修改，请重试。')
      let record: { type?: string; delta?: unknown; output_index?: number; item?: OutputItem; response?: { error?: unknown; status?: string; output?: OutputItem[] }; error?: unknown; code?: unknown }
      try { record = JSON.parse(raw) } catch { throw new ChatGPTError('ChatGPT 响应格式无效，未采用任何部分修改。') }
      const type = record.type ?? event; event = ''
      if (type === 'response.output_item.done') {
        if (!Number.isSafeInteger(record.output_index) || record.output_index! < 0 || !record.item || typeof record.item.type !== 'string') throw new ChatGPTError('ChatGPT 输出条目不完整，未执行操作。')
        finishedItems.set(record.output_index!, record.item)
      } else if (type === 'response.output_text.delta') {
        if (typeof record.delta !== 'string') throw new ChatGPTError('ChatGPT 响应格式无效。')
        output += record.delta
        onDelta?.(record.delta)
      } else if (type === 'response.failed' || type === 'error' || type === 'response.error') {
        throw safeRemoteError(0, { error: record.response?.error ?? record.error ?? { code: record.code } })
      } else if (type === 'response.incomplete') throw new ChatGPTError('ChatGPT 修改结果不完整，未采用任何部分修改，请缩短选区后重试。')
      else if (type === 'response.completed') {
        if (record.response?.status && record.response.status !== 'completed') throw new ChatGPTError('ChatGPT 修改结果不完整，未采用任何部分修改。')
        const items = record.response?.output?.length ? record.response.output : [...finishedItems.entries()].sort(([a], [b]) => a - b).map(([, item]) => item)
        const calls: AICall[] = (items ?? []).filter(item => item.type === 'function_call').map(item => {
          if (typeof item.call_id !== 'string' || typeof item.name !== 'string' || typeof item.arguments !== 'string') throw new ChatGPTError('ChatGPT 工具调用不完整，未执行操作。')
          return { id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } }
        })
        if (calls.length > 16) throw new ChatGPTError('ChatGPT 本轮操作过多，未执行操作。')
        if (!output) output = (items ?? []).flatMap(item => item.content ?? []).filter(part => part.type === 'output_text').map(part => part.text ?? '').join('')
        if (!output.trim() && !calls.length) throw new ChatGPTError('ChatGPT 未返回有效修改内容。')
        completed = { text: output, calls, ...(items ? { responseOutput: items } : {}) }
        return true
      }
      return false
    }
    const line = (value: string): boolean => {
      if (value === '') return consume()
      if (value.startsWith(':')) return false
      const colon = value.indexOf(':')
      const field = colon < 0 ? value : value.slice(0, colon)
      let valuePart = colon < 0 ? '' : value.slice(colon + 1)
      if (valuePart.startsWith(' ')) valuePart = valuePart.slice(1)
      if (field === 'data') data.push(valuePart)
      if (field === 'event') event = valuePart
      return false
    }
    const drain = (eof: boolean): boolean => {
      for (;;) {
        const match = /[\r\n]/.exec(buffer)
        if (!match) break
        const index = match.index
        if (!eof && buffer[index] === '\r' && index === buffer.length - 1) break
        const length = buffer[index] === '\r' && buffer[index + 1] === '\n' ? 2 : 1
        const value = buffer.slice(0, index); buffer = buffer.slice(index + length)
        if (line(value)) return true
      }
      if (eof) { if (buffer) { const value = buffer; buffer = ''; if (line(value)) return true } return consume() }
      return false
    }
    try {
      for (;;) {
        const { done, value } = await interruptible(reader.read(), signal)
        if (done) { buffer += decoder.decode(); if (drain(true)) return completed!; break }
        size += value.byteLength
        if (size > MAX_OUTPUT) throw new ChatGPTError('ChatGPT 修改结果过长，未采用任何部分修改，请缩短选区。')
        buffer += decoder.decode(value, { stream: true })
        if (drain(false)) return completed!
      }
      throw new ChatGPTError('ChatGPT 响应中断或未完成，未采用任何部分修改，请重试。')
    } finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
  }
}
