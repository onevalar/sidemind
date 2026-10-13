import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatGPTConnection } from '../server/chatgpt'
import { createApp } from '../server/app'
import { AISettings } from '../server/ai-settings'
import { NoteStore } from '../server/store'
import { EventBus } from '../server/events'

const ISSUER = 'https://auth.openai.com'
const API = 'https://api.openai.com/v1'
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
let keys: Awaited<ReturnType<typeof generateKeyPair>>
let wrongKeys: Awaited<ReturnType<typeof generateKeyPair>>
let jwk: Awaited<ReturnType<typeof exportJWK>>
let dir: string, file: string, connection: ChatGPTConnection, fake: OpenAI
const connections: ChatGPTConnection[] = []
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
const event = (type: string, fields: object = {}) => `event: ${type}\r\ndata: ${JSON.stringify({ type, ...fields })}\r\n\r\n`

function streamed(raw: string, fragment = 7): Response {
  const bytes = new TextEncoder().encode(raw)
  let offset = 0
  return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset >= bytes.length) { controller.close(); return }
    controller.enqueue(bytes.slice(offset, offset + fragment)); offset += fragment
  } }), { headers: { 'content-type': 'text/event-stream' } })
}

/** A fake official service, but with real asymmetric JWTs and real loopback HTTP callbacks. */
class OpenAI {
  authorization?: URL
  client = 'oaiapp_one'
  claims: JWTPayload = {}
  invalidSignature = false
  tokenOverrides: Record<string, unknown> = {}
  refreshOverrides: Record<string, unknown> = {}
  refreshStatus = 200
  revokeStatus = 200
  catalog = [
    { slug: 'hidden-model', display_name: 'Hidden', visibility: 'hidden' },
    { slug: 'available-first', display_name: 'Available First', visibility: 'list' },
    { slug: 'available-second', display_name: 'Available Second', visibility: 'list' },
  ]
  tokenCalls: { form: URLSearchParams; init: RequestInit }[] = []
  modelCalls: RequestInit[] = []
  revocations: URLSearchParams[] = []
  responses: RequestInit[] = []
  idTokens: string[] = []
  refreshDelay = 0
  codeResponse: (response: Response) => Response | Promise<Response> = response => response
  inference: (init: RequestInit) => Response | Promise<Response> = () => streamed(event('response.output_text.delta', { delta: '改写结果 🌱' }) + event('response.completed', { response: { status: 'completed' } }))

  transport: typeof fetch = async (input, init = {}) => {
    const url = String(input)
    if (url === ISSUER + '/.well-known/openid-configuration') return json({ issuer: ISSUER, jwks_uri: ISSUER + '/.well-known/jwks.json', revocation_endpoint: ISSUER + '/oauth/revoke' })
    if (url === ISSUER + '/.well-known/jwks.json') return json({ keys: [{ ...jwk, kid: 'test-key', alg: 'RS256', use: 'sig' }] })
    if (url === ISSUER + '/api/accounts/oauth/token') {
      const form = new URLSearchParams(String(init.body)); this.tokenCalls.push({ form, init })
      expect(init.redirect).toBe('error')
      expect(form.get('resource')).toBe(API)
      if (form.get('grant_type') === 'refresh_token') {
        if (this.refreshDelay) await new Promise(resolve => setTimeout(resolve, this.refreshDelay))
        return json({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', token_type: 'Bearer', expires_in: 3600, ...this.refreshOverrides }, this.refreshStatus)
      }
      const authorization = this.authorization!
      expect(form.get('redirect_uri')).toBe(authorization.searchParams.get('redirect_uri'))
      expect(createHash('sha256').update(form.get('code_verifier')!).digest('base64url')).toBe(authorization.searchParams.get('code_challenge'))
      const now = Math.floor(Date.now() / 1000)
      const payload: JWTPayload = {
        iss: ISSUER, aud: form.get('client_id')!, sub: 'verified-subject', email: 'same@example.test',
        iat: now, exp: now + 3600, nonce: authorization.searchParams.get('nonce'), ...this.claims,
      }
      const idToken = await new SignJWT(payload).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).sign((this.invalidSignature ? wrongKeys : keys).privateKey)
      this.idTokens.push(idToken)
      return this.codeResponse(json({ access_token: 'secret-access-' + form.get('client_id'), refresh_token: 'secret-refresh-' + form.get('client_id'), id_token: idToken, token_type: 'Bearer', expires_in: 3600, scope: SCOPES, ...this.tokenOverrides }))
    }
    if (url === API + '/models') { this.modelCalls.push(init); return json({ models: this.catalog }) }
    if (url === ISSUER + '/oauth/revoke') { this.revocations.push(new URLSearchParams(String(init.body))); return new Response(null, { status: this.revokeStatus }) }
    if (url === API + '/responses') { this.responses.push(init); return this.inference(init) }
    throw new Error('Unexpected transport endpoint')
  }

  async start(accountId?: string, target = connection): Promise<URL> {
    this.authorization = new URL((await target.startLogin(accountId)).authorizationUrl)
    return this.authorization
  }
  callbackURL(overrides: Record<string, string | null> = {}): URL {
    const url = new URL(this.authorization!.searchParams.get('redirect_uri')!)
    url.search = new URLSearchParams({ state: this.authorization!.searchParams.get('state')!, code: 'private-code', client_id: this.client }).toString()
    for (const [key, value] of Object.entries(overrides)) {
      if (value === null) url.searchParams.delete(key)
      else url.searchParams.set(key, value)
    }
    return url
  }
  async callback(overrides: Record<string, string | null> = {}): Promise<{ status: number; body: string }> {
    const response = await fetch(this.callbackURL(overrides), { signal: AbortSignal.timeout(5000) })
    return { status: response.status, body: await response.text() }
  }
  async login(accountId?: string): Promise<string> {
    await this.start(accountId)
    expect((await this.callback()).status).toBe(200)
    const config = await connection.publicConfig()
    expect(config).toMatchObject({ configured: true, loginStatus: 'success' })
    return config.activeAccountId!
  }
}

beforeAll(async () => {
  keys = await generateKeyPair('RS256'); wrongKeys = await generateKeyPair('RS256')
  jwk = await exportJWK(keys.publicKey)
})
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-chatgpt-'))
  file = path.join(dir, 'private', 'connections.chatgpt.json')
  fake = new OpenAI(); connection = new ChatGPTConnection(file, { transport: fake.transport }); connections.push(connection)
})
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await Promise.all(connections.splice(0).map(connection => connection.cancelLogin()))
  await fs.rm(dir, { force: true, recursive: true })
})

describe('official ChatGPT connection', () => {
  it('persists the host before OAuth and uses fresh state, nonce, PKCE and a real exact loopback callback', async () => {
    expect(await connection.publicConfig()).toEqual({ configured: false, accounts: [], activeAccountId: null, model: '', loginStatus: 'idle' })
    const first = await fake.start()
    expect(first.origin + first.pathname).toBe(ISSUER + '/api/accounts/authorize')
    expect(first.searchParams.get('client_id')).toBe('dynamic_agent_client')
    expect(first.searchParams.get('agent_name_hint')).toBe('Sidemind')
    expect(first.searchParams.get('scope')).toBe(SCOPES)
    expect(first.searchParams.get('resource')).toBe(API)
    expect(first.searchParams.get('code_challenge_method')).toBe('S256')
    expect(first.searchParams.get('ext_agent_host_id')).toMatch(/^urn:uuid:[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/)
    expect(JSON.parse(await fs.readFile(file, 'utf8')).hostId).toBe(first.searchParams.get('ext_agent_host_id'))
    const redirect = new URL(first.searchParams.get('redirect_uri')!)
    expect(redirect.hostname).toBe('127.0.0.1'); expect(redirect.pathname).toBe('/auth/callback')
    expect((await fetch(new URL('/callback', redirect))).status).toBe(404)
    expect(await connection.publicConfig()).toMatchObject({ loginStatus: 'waiting', configured: false })
    await expect(connection.startLogin()).rejects.toThrow('正在进行')
    await connection.cancelLogin()
    await expect(fetch(redirect)).rejects.toThrow()
    const second = await fake.start()
    for (const field of ['state', 'nonce', 'code_challenge']) expect(second.searchParams.get(field)).not.toBe(first.searchParams.get(field))
    expect(second.searchParams.get('ext_agent_host_id')).toBe(first.searchParams.get('ext_agent_host_id'))
    expect((await fake.callback()).status).toBe(200)
    expect(await connection.publicConfig()).toMatchObject({ configured: true, model: 'available-first', loginStatus: 'success' })
    expect(fake.tokenCalls[0]!.form.get('client_id')).toBe('oaiapp_one')
  })

  it('stores private credentials atomically outside notes, resumes, and public status never leaks credentials or transient state', async () => {
    const id = await fake.login()
    const config = await connection.publicConfig()
    const publicJSON = JSON.stringify(config)
    for (const secret of ['secret-access', 'secret-refresh', 'private-code', fake.idTokens[0]!, fake.authorization!.searchParams.get('nonce')!, fake.authorization!.searchParams.get('state')!, fake.tokenCalls[0]!.form.get('code_verifier')!]) expect(publicJSON).not.toContain(secret)
    expect(config.accounts).toEqual([{ id, signedIn: true, label: 'same@example.test · 注册 1' }])
    const saved = await fs.readFile(file, 'utf8')
    expect(saved).toContain('secret-access-oaiapp_one'); expect(saved).toContain('secret-refresh-oaiapp_one')
    expect(saved).not.toContain('private-code'); expect(saved).not.toContain(fake.tokenCalls[0]!.form.get('code_verifier')!)
    if (process.platform !== 'win32') {
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
      expect((await fs.stat(path.dirname(file))).mode & 0o777).toBe(0o700)
    }
    expect(await fs.readdir(path.dirname(file))).toEqual([path.basename(file)])
    const reopened = new ChatGPTConnection(file, { transport: fake.transport }); connections.push(reopened)
    expect(await reopened.publicConfig()).toMatchObject({ configured: true, activeAccountId: id, model: 'available-first' })
    expect(await reopened.models()).toEqual([{ slug: 'available-first', displayName: 'Available First' }, { slug: 'available-second', displayName: 'Available Second' }])
    expect(fake.responses).toHaveLength(0)
  })

  it.each([
    ['missing state', { state: null }, '验证失败'],
    ['wrong state before OAuth error', { state: 'tampered', error: 'access_denied' }, '验证失败'],
    ['declined consent with valid state', { error: 'access_denied' }, '授权未完成'],
    ['missing issued client', { client_id: null }, '验证失败'],
    ['registration entrypoint is not an issued client', { client_id: 'dynamic_agent_client' }, '验证失败'],
  ] as const)('rejects %s before exchanging any code', async (_, overrides, message) => {
    await fake.start()
    const result = await fake.callback(overrides)
    expect(result.status).toBe(400); expect(result.body).toContain(message)
    expect(fake.tokenCalls).toHaveLength(0)
    expect(await connection.publicConfig()).toMatchObject({ configured: false, accounts: [], loginStatus: 'error' })
  })

  it.each([
    ['nonce', { nonce: 'wrong-nonce' }], ['issuer', { iss: 'https://attacker.example' }],
    ['audience', { aud: 'oaiapp_someone_else' }], ['expired', { exp: 1 }],
    ['missing expiry', { exp: undefined }], ['empty subject', { sub: '' }], ['missing nonce', { nonce: undefined }],
  ])('validates a signed JWT and rejects a tampered %s claim', async (_, claims) => {
    fake.claims = claims
    await fake.start()
    expect((await fake.callback()).status).toBe(400)
    expect(await connection.publicConfig()).toMatchObject({ configured: false, accounts: [], loginStatus: 'error', error: expect.stringContaining('验证失败') })
    expect(fake.modelCalls).toHaveLength(0)
  })

  it('rejects a JWT signed by an untrusted asymmetric key', async () => {
    fake.invalidSignature = true
    await fake.start()
    const result = await fake.callback()
    expect(result.status).toBe(400); expect(result.body).not.toContain(fake.idTokens[0]!)
    expect((await connection.publicConfig()).accounts).toEqual([])
  })

  it('reauthorizes only the saved issued client and verified subject, with optional returning callback client', async () => {
    const id = await fake.login()
    const before = await connection.publicConfig()
    const returning = await fake.start(id)
    expect(returning.searchParams.get('client_id')).toBe('oaiapp_one')
    expect(returning.searchParams.has('agent_name_hint')).toBe(false)
    expect(returning.searchParams.get('id_token_hint')).toBe(fake.idTokens[0])
    expect(returning.searchParams.get('login_hint')).toBe('same@example.test')
    expect(returning.toString()).not.toContain('secret-access')
    expect(returning.toString()).not.toContain('secret-refresh')
    const count = fake.tokenCalls.length
    expect((await fake.callback({ client_id: 'oaiapp_replacement' })).status).toBe(400)
    expect(fake.tokenCalls).toHaveLength(count)
    expect(await connection.publicConfig()).toMatchObject({ activeAccountId: id, configured: true, accounts: before.accounts })
    fake.claims = { sub: 'different-subject' }
    await fake.start(id)
    expect((await fake.callback({ client_id: null })).status).toBe(400)
    expect((await connection.publicConfig()).accounts).toEqual(before.accounts)
    fake.claims = {}
    await fake.start(id)
    expect((await fake.callback({ client_id: null })).status).toBe(200)
    expect((await connection.publicConfig()).activeAccountId).toBe(id)
    expect((await connection.publicConfig()).accounts).toHaveLength(1)
  })

  it.each([undefined, 'openid profile email offline_access resource.invoke', 'openid profile email chatgpt.tokens.use.direct'])('requires explicit token-response plan scopes (%s), retaining identity without inference', async scope => {
    fake.tokenOverrides = { scope }
    await fake.start()
    // A callback scope claim is not an authorization grant.
    expect((await fake.callback({ scope: SCOPES })).status).toBe(400)
    const config = await connection.publicConfig()
    expect(config).toMatchObject({ configured: false, activeAccountId: null, loginStatus: 'error', error: expect.stringContaining('尚未授权') })
    expect(config.accounts[0]?.signedIn).toBe(true)
    await expect(connection.select(config.accounts[0]!.id)).rejects.toThrow('尚未授权')
    await expect(connection.propose('private source', 'rewrite')).rejects.toThrow()
    expect(fake.modelCalls).toHaveLength(0); expect(fake.responses).toHaveLength(0)
    const returning = await fake.start(config.accounts[0]!.id)
    expect(returning.searchParams.get('client_id')).toBe('oaiapp_one')
    expect(returning.searchParams.get('scope')).toBe(SCOPES)
    expect(returning.searchParams.get('prompt')).toBe('consent')
  })

  it('keeps duplicate-email registrations distinct, supports selection/disable, and reuses registration after local signout', async () => {
    const one = await fake.login()
    fake.client = 'oaiapp_two'
    fake.claims = { sub: 'subject-two' }
    const two = await fake.login()
    const config = await connection.publicConfig()
    expect(config.accounts.map(account => account.label)).toEqual(['same@example.test · 注册 1', 'same@example.test · 注册 2'])
    expect(one).not.toBe(two)
    expect(config.activeAccountId).toBe(two)
    await expect(connection.select(one, 'hidden-model')).rejects.toThrow('不可用')
    expect(await connection.select(one, 'available-second')).toMatchObject({ activeAccountId: one, model: 'available-second' })
    expect(await connection.select(null)).toMatchObject({ configured: false, activeAccountId: null, model: '', accounts: config.accounts })
    await expect(connection.propose('source', 'rewrite')).rejects.toThrow('尚未选择')
    await connection.select(one)
    const signedOut = await connection.signOut(one)
    expect(signedOut).toMatchObject({ configured: false, activeAccountId: null })
    expect(signedOut.accounts.find(account => account.id === two)?.signedIn).toBe(true)
    expect(fake.revocations[0]!.get('token')).toBe('secret-refresh-oaiapp_one')
    expect(fake.revocations[0]!.get('client_id')).toBe('oaiapp_one')
    expect(fake.revocations[0]!.get('token_type_hint')).toBe('refresh_token')
    const saved = await fs.readFile(file, 'utf8')
    expect(saved).not.toContain('secret-access-oaiapp_one'); expect(saved).not.toContain('secret-refresh-oaiapp_one')
    const next = await fake.start(one)
    expect(next.searchParams.get('client_id')).toBe('oaiapp_one')
    expect(next.searchParams.has('id_token_hint')).toBe(false)
    expect(next.searchParams.get('ext_agent_host_id')).toBe(JSON.parse(saved).hostId)
    fake.client = 'oaiapp_one'; fake.claims = {}
    expect((await fake.callback({ client_id: null })).status).toBe(200)
    expect((await connection.publicConfig()).activeAccountId).toBe(one)
    expect((await connection.publicConfig()).accounts).toHaveLength(2)
  })

  it('does not report configured/success until an actual display model is available', async () => {
    fake.catalog = [{ slug: 'hidden-only', display_name: 'Hidden', visibility: 'hidden' }]
    await fake.start()
    expect((await fake.callback()).status).toBe(400)
    expect(await connection.publicConfig()).toMatchObject({ configured: false, model: '', activeAccountId: null, loginStatus: 'error', error: expect.stringContaining('没有可用模型') })
    expect((await connection.publicConfig()).accounts[0]?.signedIn).toBe(true)
  })

  it('clears local tokens even when remote revocation cannot be confirmed, without returning a remote body', async () => {
    const id = await fake.login()
    fake.revokeStatus = 503
    const result = await connection.signOut(id)
    expect(result).toMatchObject({ configured: false, accounts: [{ id, signedIn: false }], error: expect.stringContaining('无法确认远程') })
    expect(fake.revocations).toHaveLength(2)
    expect(await fs.readFile(file, 'utf8')).not.toContain('secret-access')
  })

  it('serializes rotating refresh across separate instances and persists/reuses the correct issued client and replacement', async () => {
    fake.tokenOverrides = { expires_in: 30 }
    const id = await fake.login()
    fake.refreshDelay = 40
    const other = new ChatGPTConnection(file, { transport: fake.transport }); connections.push(other)
    const [first, second] = await Promise.all([connection.models(), other.models()])
    expect(first).toEqual(second)
    const refreshes = fake.tokenCalls.filter(call => call.form.get('grant_type') === 'refresh_token')
    expect(refreshes).toHaveLength(1)
    expect(Object.fromEntries(refreshes[0]!.form)).toEqual({ grant_type: 'refresh_token', client_id: 'oaiapp_one', refresh_token: 'secret-refresh-oaiapp_one', resource: API })
    expect(fake.modelCalls.slice(-2).map(init => new Headers(init.headers).get('authorization'))).toEqual(['Bearer rotated-access', 'Bearer rotated-access'])
    const saved = await fs.readFile(file, 'utf8')
    expect(saved).toContain('rotated-refresh'); expect(saved).not.toContain('secret-refresh-oaiapp_one')
    expect(await other.publicConfig()).toMatchObject({ activeAccountId: id, configured: true })
    await other.signOut(id)
    expect(fake.revocations[0]!.get('token')).toBe('rotated-refresh')
  })

  it.each([['invalid_grant', false], ['server_error', true]])('handles refresh %s without dropping a valid registration or leaking server errors', async (code, retained) => {
    fake.tokenOverrides = { expires_in: 30 }
    const id = await fake.login()
    fake.refreshStatus = retained ? 503 : 400
    fake.refreshOverrides = { error: code, error_description: 'secret-refresh-oaiapp_one private server error' }
    await expect(connection.models()).rejects.toThrow(retained ? '暂不可用' : '会话已失效')
    const config = await connection.publicConfig()
    expect(config.accounts).toMatchObject([{ id, signedIn: retained }])
    expect(config.configured).toBe(retained)
    expect(config.activeAccountId).toBe(id)
    const returning = await fake.start(id)
    expect(returning.searchParams.get('client_id')).toBe('oaiapp_one')
    expect(JSON.stringify(config)).not.toContain('private server error')
  })

  it('cancels an in-flight exchange without allowing late credentials to become active', async () => {
    let ready!: () => void, release!: () => void
    const begun = new Promise<void>(resolve => { ready = resolve })
    const blocked = new Promise<void>(resolve => { release = resolve })
    fake.codeResponse = async response => { ready(); await blocked; return response }
    await fake.start()
    const callback = fake.callback().catch(() => undefined)
    await begun
    await connection.cancelLogin()
    release(); await callback
    expect(await connection.publicConfig()).toMatchObject({ configured: false, accounts: [], loginStatus: 'idle' })
    expect(fake.modelCalls).toHaveLength(0)
  })

  it('expires an abandoned login in ten minutes and closes its loopback listener', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const authorization = await fake.start()
    await vi.advanceTimersByTimeAsync(600000)
    vi.useRealTimers()
    expect(await connection.publicConfig()).toMatchObject({ configured: false, loginStatus: 'error', error: expect.stringContaining('已过期') })
    await expect(fetch(authorization.searchParams.get('redirect_uri')!)).rejects.toThrow()
  })

  it('fails closed on malformed or symlinked local credential files instead of replacing them', async () => {
    await fake.login()
    await fs.writeFile(file, '{malformed')
    expect(await connection.publicConfig()).toMatchObject({ configured: false, loginStatus: 'error' })
    await expect(connection.startLogin()).rejects.toThrow('私有配置')
    expect(await fs.readFile(file, 'utf8')).toBe('{malformed')
    if (process.platform !== 'win32') {
      const target = path.join(dir, 'target')
      await fs.writeFile(target, '{}'); await fs.rm(file); await fs.symlink(target, file)
      await expect(connection.startLogin()).rejects.toThrow('私有配置')
      expect(await fs.readFile(target, 'utf8')).toBe('{}')
    }
  })

  it('never silently switches a selected or unreadable ChatGPT connection into API-key billing', async () => {
    fake.tokenOverrides = { expires_in: 30 }
    const id = await fake.login()
    const store = new NoteStore(path.join(dir, 'notes'))
    await store.init()
    const ai = new AISettings(store.root, path.join(dir, 'private'), {})
    await ai.save({ model: 'paid-model', baseUrl: 'https://alternate.example/v1', key: 'test-key' })
    let alternateRequests = 0
    const transport: typeof fetch = async () => {
      alternateRequests++
      return json({ choices: [{ message: { content: 'Explicitly chosen alternate.' }, finish_reason: 'stop' }] })
    }
    const app = createApp(store, new EventBus(), { aiSettings: ai, chatgpt: connection, aiTransport: transport })
    const headers = { host: 'localhost:3001', 'content-type': 'application/json' }
    const propose = () => app.request('/api/ai/propose', { method: 'POST', headers, body: JSON.stringify({ source: 'Private selected text.', instruction: 'Rewrite.' }) })
    fake.refreshStatus = 400; fake.refreshOverrides = { error: 'invalid_grant' }
    expect((await propose()).status).toBe(502)
    expect((await propose()).status).toBe(502)
    expect((await connection.publicConfig()).activeAccountId).toBe(id)
    expect(alternateRequests).toBe(0)
    expect(fake.responses).toHaveLength(0)

    expect((await app.request('/api/ai/chatgpt/account', { method: 'PUT', headers, body: '{"accountId":null}' })).status).toBe(200)
    expect(await (await propose()).json()).toEqual({ replacement: 'Explicitly chosen alternate.' })
    expect(alternateRequests).toBe(1)
    await fs.writeFile(file, '{unreadable')
    expect((await propose()).status).toBe(502)
    expect(alternateRequests).toBe(1)
  })
})

describe('ChatGPT Responses inference', () => {
  beforeEach(async () => { await fake.login() })

  it('sends only the requested source through public Responses and waits for completed UTF-8/CRLF SSE', async () => {
    fake.inference = () => streamed(': comment\r\n\r\n' + event('response.created') +
      'event: response.output_text.delta\r\ndata: {\r\ndata: "delta":"# 中文 🌱\\n"}\r\n\r\n' +
      event('response.output_text.delta', { delta: '**改写**' }) + event('response.completed', { response: { status: 'completed' } }), 1)
    expect(fake.responses).toHaveLength(0)
    expect(await connection.propose('only supplied source', 'rewrite clearly')).toBe('# 中文 🌱\n**改写**')
    const request = fake.responses[0]!
    expect(request.redirect).toBe('error')
    expect(new Headers(request.headers).get('authorization')).toBe('Bearer secret-access-oaiapp_one')
    expect(JSON.parse(String(request.body))).toEqual({
      model: 'available-first',
      instructions: 'Rewrite the supplied Markdown according to the instruction. Return ONLY the replacement Markdown, without an explanation or an outer code fence. Never modify content outside the supplied source.',
      input: [{ role: 'user', content: JSON.stringify({ instruction: 'rewrite clearly', source: 'only supplied source' }) }],
      store: false, stream: true, include: ['reasoning.encrypted_content'],
    })
  })

  it('completes Responses function calls and sends their results and reasoning back for a natural reply', async () => {
    const output = [{ type: 'reasoning', id: 'r1', summary: [], encrypted_content: 'encrypted-test-reasoning' }, { type: 'function_call', id: 'fc1', call_id: 'read1', name: 'read_note', arguments: '{"name":"Note.md"}' }]
    fake.inference = () => streamed(event('response.completed', { response: { status: 'completed', output } }))
    const tools = [{ type: 'function' as const, function: { name: 'read_note', description: 'Read Markdown', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } }]
    const signal = new AbortController().signal
    const initial = [{ role: 'system' as const, content: 'Chat naturally and read on demand.' }, { role: 'user' as const, content: 'Explain this note.' }]
    const turn = await connection.chat(initial, tools, signal)
    expect(turn.calls).toEqual([{ id: 'read1', type: 'function', function: { name: 'read_note', arguments: '{"name":"Note.md"}' } }])
    expect(turn.text).toBe('')
    fake.inference = () => streamed(event('response.output_text.delta', { delta: '这篇文章讨论光的反射。' }) + event('response.completed', { response: { status: 'completed' } }))
    const answer = await connection.chat([...initial, { role: 'assistant', content: null, tool_calls: turn.calls, responseOutput: turn.responseOutput }, { role: 'tool', tool_call_id: 'read1', content: '{"content":"# 光\\n反射"}' }], tools, signal)
    expect(answer.text).toBe('这篇文章讨论光的反射。')
    const body = JSON.parse(String(fake.responses[1]!.body))
    expect(body.input).toEqual([{ role: 'user', content: 'Explain this note.' }, ...output, { type: 'function_call_output', call_id: 'read1', output: '{"content":"# 光\\n反射"}' }])
    expect(body.tools[0]).toMatchObject({ type: 'function', name: 'read_note' })
    expect(body.instructions).not.toContain('Rewrite')
  })

  it.each([
    ['quota failure', event('response.failed', { response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'secret-access-oaiapp_one' } } }), 'settings/usage'],
    ['usage unavailable', event('response.failed', { response: { error: { code: 'subscription_sharing_usage_unavailable' } } }), '暂不可用'],
    ['incomplete', event('response.incomplete'), '不完整'],
    ['explicit error', event('error', { code: 'unknown', message: 'secret-access-oaiapp_one' }), '请求失败'],
    ['interrupted', '', '未完成'],
    ['DONE without completion', 'data: [DONE]\n\n', '未完成'],
    ['malformed', 'data: broken-json\n\n', '格式无效'],
  ])('rejects all partial output on %s, even if a completion follows', async (_, terminal, message) => {
    fake.inference = () => streamed(event('response.output_text.delta', { delta: 'partial private replacement' }) + terminal + (terminal ? event('response.completed') : ''))
    const failed = connection.propose('source', 'rewrite')
    await expect(failed).rejects.toThrow(message)
    await expect(failed).rejects.not.toThrow('partial private replacement')
    await expect(failed).rejects.not.toThrow('secret-access')
    expect(fake.responses).toHaveLength(1)
  })

  it('rejects an empty completed response', async () => {
    fake.inference = () => streamed(event('response.completed'))
    await expect(connection.propose('source', 'rewrite')).rejects.toThrow('有效修改')
  })

  it.each([401, 403, 429, 503])('returns safe actionable errors on direct admission HTTP %s without another billing request', async status => {
    fake.inference = () => json({ detail: 'private diagnostics secret-access-oaiapp_one' }, status)
    const proposal = connection.propose('source', 'rewrite')
    await expect(proposal).rejects.toThrow(status === 429 ? 'settings/usage' : status === 503 ? '暂不可用' : status === 401 ? '重新连接' : '限制')
    await expect(proposal).rejects.not.toThrow('private diagnostics')
    expect(fake.responses).toHaveLength(1)
    expect((await connection.publicConfig()).configured).toBe(true)
  })

  it('cancels a hanging stream, cancels its reader, and never returns accumulated deltas', async () => {
    let ready!: () => void, cancelled = false, requestSignal: AbortSignal | null | undefined
    const begun = new Promise<void>(resolve => { ready = resolve })
    fake.inference = init => {
      requestSignal = init.signal
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode(event('response.output_text.delta', { delta: 'partial' }))); ready() },
        cancel() { cancelled = true },
      }))
    }
    const controller = new AbortController()
    const pending = connection.propose('source', 'rewrite', controller.signal)
    const rejection = expect(pending).rejects.toThrow('已取消')
    await begun; controller.abort(); await rejection
    expect(requestSignal?.aborted).toBe(true)
    expect(cancelled).toBe(true)
    expect(fake.responses).toHaveLength(1)
  })

  it('times out a hanging Responses stream using the 120-second budget, without accepting partial output', async () => {
    const timeout = AbortSignal.timeout.bind(AbortSignal)
    // Shorten the real platform timer without changing the provider's public contract.
    const timers = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => timeout(ms === 120000 ? 100 : ms))
    fake.inference = () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(event('response.output_text.delta', { delta: 'partial' }))) },
    }))
    await expect(connection.propose('source', 'rewrite')).rejects.toThrow('超时')
    expect(timers).toHaveBeenCalledWith(120000)
    expect(fake.responses).toHaveLength(1)
  })

  it('does not send user data when cancellation happened before the request', async () => {
    const controller = new AbortController(); controller.abort()
    await expect(connection.propose('private source', 'rewrite', controller.signal)).rejects.toThrow('已取消')
    expect(fake.responses).toHaveLength(0)
  })

  it('stops in-flight inference on signout and cannot restart using the removed tokens', async () => {
    let ready!: () => void
    const begun = new Promise<void>(resolve => { ready = resolve })
    fake.inference = () => { ready(); return new Response(new ReadableStream<Uint8Array>()) }
    const pending = connection.propose('source', 'rewrite')
    const rejected = expect(pending).rejects.toThrow('已取消')
    await begun
    await connection.signOut((await connection.publicConfig()).activeAccountId!)
    await rejected
    await expect(connection.propose('source', 'rewrite')).rejects.toThrow('尚未选择')
  })
})
