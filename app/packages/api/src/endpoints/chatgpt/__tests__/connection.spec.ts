import path from 'path';
import crypto from 'crypto';
import { promises as fs } from 'fs';
import type { ChatGPTConnection, ChatGPTConnectionDeps } from '../connection';
import {
  SUBJECT,
  OWNER_ID,
  FULL_SCOPE,
  signIdToken,
  makeTempDir,
  ISSUED_CLIENT_ID,
  createFakeOpenAI,
  foreignPrivateKey,
  codeExchangeResponse,
} from './fakeAuth.helper';
import { createChatGPTConnection } from '../connection';
import { createFileCredentialStore } from '../store';

type Fake = ReturnType<typeof createFakeOpenAI>;

let stateDir: string;
let fake: Fake;
let clock: number;
let enabled: boolean;

function makeConnection(overrides: Partial<ChatGPTConnectionDeps> = {}): ChatGPTConnection {
  return createChatGPTConnection({
    store: createFileCredentialStore(stateDir),
    port: 3080,
    isEnabled: () => enabled,
    getLocalOwnerId: async () => OWNER_ID,
    fetch: fake.fetch,
    now: () => clock,
    ...overrides,
  });
}

async function begin(connection: ChatGPTConnection) {
  const { authorizationUrl } = await connection.startLogin(OWNER_ID);
  const url = new URL(authorizationUrl);
  return {
    url,
    state: url.searchParams.get('state') ?? '',
    nonce: url.searchParams.get('nonce') ?? '',
  };
}

async function connect(connection: ChatGPTConnection, code = 'code-1') {
  const { state, nonce } = await begin(connection);
  fake.setTokenHandler(codeExchangeResponse(nonce));
  const result = await connection.handleCallback({ state, code, client_id: ISSUED_CLIENT_ID });
  expect(result).toEqual({ ok: true });
}

async function readStored() {
  return JSON.parse(
    await fs.readFile(path.join(stateDir, 'chatgpt-credentials.json'), 'utf8'),
  ) as Record<string, { refreshToken?: string; accessToken?: string } | null>;
}

beforeEach(async () => {
  stateDir = await makeTempDir();
  fake = createFakeOpenAI();
  clock = Date.now();
  enabled = true;
});

afterEach(async () => {
  await fs.rm(stateDir, { recursive: true, force: true });
});

describe('ChatGPT connection: authorization request', () => {
  it('builds a first-time dynamic registration request with PKCE S256 and a stable host id', async () => {
    const connection = makeConnection();
    const { authorizationUrl } = await connection.startLogin(OWNER_ID);
    const url = new URL(authorizationUrl);
    const params = url.searchParams;

    expect(`${url.origin}${url.pathname}`).toBe('https://auth.openai.com/api/accounts/authorize');
    expect(params.get('client_id')).toBe('dynamic_agent_client');
    expect(params.get('agent_name_hint')).toBe('ChatGit');
    expect(params.get('redirect_uri')).toBe('http://127.0.0.1:3080/api/chatgpt/callback');
    expect(params.get('resource')).toBe('https://api.openai.com/v1');
    expect(params.get('response_type')).toBe('code');
    expect(params.get('scope')).toBe(
      'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
    );
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params.get('state')).not.toBe(params.get('nonce'));
    expect(params.has('id_token_hint')).toBe(false);

    const hostId = params.get('ext_agent_host_id');
    expect(hostId).toMatch(/^urn:uuid:/);
    const restarted = makeConnection();
    const again = new URL((await restarted.startLogin(OWNER_ID)).authorizationUrl);
    expect(again.searchParams.get('ext_agent_host_id')).toBe(hostId);
    expect(again.searchParams.get('state')).not.toBe(params.get('state'));
  });

  it('sends the PKCE verifier whose S256 digest matches the challenge', async () => {
    const connection = makeConnection();
    const { url, state, nonce } = await begin(connection);
    fake.setTokenHandler(codeExchangeResponse(nonce));
    await connection.handleCallback({ state, code: 'c', client_id: ISSUED_CLIENT_ID });

    const [exchange] = fake.tokenCalls();
    const digest = crypto
      .createHash('sha256')
      .update(exchange.form?.code_verifier ?? '')
      .digest('base64url');
    expect(digest).toBe(url.searchParams.get('code_challenge'));
    expect(exchange.form).toMatchObject({
      grant_type: 'authorization_code',
      client_id: ISSUED_CLIENT_ID,
      redirect_uri: 'http://127.0.0.1:3080/api/chatgpt/callback',
      resource: 'https://api.openai.com/v1',
    });
    expect(exchange.form).not.toHaveProperty('client_secret');
  });

  it('refuses login when disabled or for anyone but the local owner', async () => {
    enabled = false;
    await expect(makeConnection().startLogin(OWNER_ID)).rejects.toMatchObject({
      code: 'disabled',
    });
    enabled = true;
    await expect(makeConnection().startLogin('someone-else')).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(
      makeConnection({ getLocalOwnerId: async () => null }).startLogin(OWNER_ID),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('ChatGPT connection: callback validation', () => {
  it('stores validated credentials atomically with owner-only permissions and a token-free status', async () => {
    const connection = makeConnection();
    await connect(connection);

    const file = path.join(stateDir, 'chatgpt-credentials.json');
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(stateDir)).mode & 0o777).toBe(0o700);
    const stored = await readStored();
    expect(stored.registration).toMatchObject({ clientId: ISSUED_CLIENT_ID, subject: SUBJECT });
    expect(stored.tokens?.refreshToken).toBe('refresh-code-1');
    expect((await fs.readdir(stateDir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);

    const status = await connection.getStatus();
    expect(status).toEqual({
      enabled: true,
      state: 'connected',
      planUsage: true,
      email: 'user@example.com',
    });
    expect(JSON.stringify(status)).not.toMatch(/access-|refresh-|eyJ/);
    await expect(connection.getAccessToken(OWNER_ID)).resolves.toBe('access-code-1');
  });

  it('rejects forged state without disturbing the legitimate attempt, and rejects replay', async () => {
    const connection = makeConnection();
    const { state, nonce } = await begin(connection);
    fake.setTokenHandler(codeExchangeResponse(nonce));

    await expect(
      connection.handleCallback({ state: 'forged', code: 'x', client_id: ISSUED_CLIENT_ID }),
    ).resolves.toEqual({ ok: false, error: { code: 'invalid_state' } });
    expect(fake.tokenCalls()).toHaveLength(0);
    expect((await connection.getStatus()).state).toBe('pending');

    await expect(
      connection.handleCallback({ state, code: 'c', client_id: ISSUED_CLIENT_ID }),
    ).resolves.toEqual({ ok: true });
    await expect(
      connection.handleCallback({ state, code: 'c', client_id: ISSUED_CLIENT_ID }),
    ).resolves.toEqual({ ok: false, error: { code: 'invalid_state' } });
    expect(fake.tokenCalls()).toHaveLength(1);
  });

  it('expires pending attempts and stops on access_denied without exchanging a code', async () => {
    const connection = makeConnection();
    const first = await begin(connection);
    clock += 11 * 60 * 1000;
    await expect(
      connection.handleCallback({ state: first.state, code: 'c', client_id: ISSUED_CLIENT_ID }),
    ).resolves.toEqual({ ok: false, error: { code: 'state_expired' } });

    const second = await begin(connection);
    await expect(
      connection.handleCallback({ state: second.state, error: 'access_denied' }),
    ).resolves.toEqual({ ok: false, error: { code: 'access_denied' } });
    expect(fake.tokenCalls()).toHaveLength(0);
    expect((await connection.getStatus()).lastError).toBe('access_denied');
  });

  it.each([
    ['missing issued client id', undefined],
    ['dynamic client id echoed back', 'dynamic_agent_client'],
  ])('treats a new registration with %s as incomplete', async (_label, clientId) => {
    const connection = makeConnection();
    const { state } = await begin(connection);
    await expect(
      connection.handleCallback({ state, code: 'c', client_id: clientId }),
    ).resolves.toEqual({ ok: false, error: { code: 'registration_incomplete' } });
    expect(fake.tokenCalls()).toHaveLength(0);
  });

  it.each([
    ['nonce', { nonce: 'other-nonce' }],
    ['audience', { aud: 'oaiapp_someone_else' }],
    ['issuer', { iss: 'https://evil.example.com' }],
    [
      'expiry',
      { exp: Math.floor(Date.now() / 1000) - 600, iat: Math.floor(Date.now() / 1000) - 4200 },
    ],
  ])('rejects an ID token with the wrong %s and stores nothing', async (_label, claims) => {
    const connection = makeConnection();
    const { state, nonce } = await begin(connection);
    fake.setTokenHandler(
      codeExchangeResponse(nonce, { id_token: signIdToken({ nonce, ...claims }) }),
    );
    await expect(
      connection.handleCallback({ state, code: 'c', client_id: ISSUED_CLIENT_ID }),
    ).resolves.toEqual({ ok: false, error: { code: 'id_token_invalid' } });
    await expect(fs.readFile(path.join(stateDir, 'chatgpt-credentials.json'))).rejects.toThrow();
    expect(fake.revokeCalls()).toHaveLength(1);
  });

  it('rejects an ID token signed by a key outside OpenAI JWKS', async () => {
    const connection = makeConnection();
    const { state, nonce } = await begin(connection);
    fake.setTokenHandler(
      codeExchangeResponse(nonce, {
        id_token: signIdToken({ nonce }, { key: foreignPrivateKey }),
      }),
    );
    await expect(
      connection.handleCallback({ state, code: 'c', client_id: ISSUED_CLIENT_ID }),
    ).resolves.toEqual({ ok: false, error: { code: 'id_token_invalid' } });
  });

  it('does not persist a grant without chatgpt.tokens.use.direct', async () => {
    const connection = makeConnection();
    const { state, nonce } = await begin(connection);
    fake.setTokenHandler(
      codeExchangeResponse(nonce, { scope: 'email offline_access openid profile' }),
    );
    await expect(
      connection.handleCallback({
        state,
        code: 'c',
        client_id: ISSUED_CLIENT_ID,
      }),
    ).resolves.toEqual({ ok: false, error: { code: 'plan_usage_not_granted' } });
    await expect(fs.readFile(path.join(stateDir, 'chatgpt-credentials.json'))).rejects.toThrow();
    expect(fake.revokeCalls()[0].form).toMatchObject({
      token: 'refresh-c',
      token_type_hint: 'refresh_token',
      client_id: ISSUED_CLIENT_ID,
    });
    const status = await connection.getStatus();
    expect(status).toMatchObject({ state: 'disconnected', lastError: 'plan_usage_not_granted' });
  });

  it('reuses the issued client for returning sign-in and enforces client and subject binding', async () => {
    const connection = makeConnection();
    await connect(connection);

    const returning = await begin(connection);
    expect(returning.url.searchParams.get('client_id')).toBe(ISSUED_CLIENT_ID);
    expect(returning.url.searchParams.has('agent_name_hint')).toBe(false);
    expect(returning.url.searchParams.get('login_hint')).toBe('user@example.com');

    await expect(
      connection.handleCallback({ state: returning.state, code: 'c2', client_id: 'oaiapp_other' }),
    ).resolves.toEqual({ ok: false, error: { code: 'client_mismatch' } });

    const other = await begin(connection);
    fake.setTokenHandler(codeExchangeResponse(other.nonce, {}, { sub: 'different-subject' }));
    await expect(connection.handleCallback({ state: other.state, code: 'c3' })).resolves.toEqual({
      ok: false,
      error: { code: 'subject_mismatch' },
    });

    /** The active connection survives failed reauthorization attempts untouched. */
    expect((await readStored()).tokens?.refreshToken).toBe('refresh-code-1');
    await expect(connection.getAccessToken(OWNER_ID)).resolves.toBe('access-code-1');

    const ok = await begin(connection);
    fake.setTokenHandler(codeExchangeResponse(ok.nonce));
    await expect(connection.handleCallback({ state: ok.state, code: 'c4' })).resolves.toEqual({
      ok: true,
    });
    expect((await readStored()).tokens?.refreshToken).toBe('refresh-c4');
  });
});

describe('ChatGPT connection: refresh', () => {
  it('serializes simultaneous refreshes and rotates access, refresh and scopes together', async () => {
    const connection = makeConnection();
    await connect(connection);
    clock += 58 * 60 * 1000;
    const counter = { n: 0 };
    fake.setTokenHandler((form) => {
      expect(form).toMatchObject({
        grant_type: 'refresh_token',
        client_id: ISSUED_CLIENT_ID,
        refresh_token: 'refresh-code-1',
        resource: 'https://api.openai.com/v1',
      });
      expect(form).not.toHaveProperty('scope');
      counter.n += 1;
      return {
        status: 200,
        body: {
          access_token: 'access-r1',
          refresh_token: 'refresh-r1',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: FULL_SCOPE,
        },
      };
    });

    const tokens = await Promise.all([
      connection.getAccessToken(OWNER_ID),
      connection.getAccessToken(OWNER_ID),
      connection.getAccessToken(OWNER_ID),
    ]);
    expect(tokens).toEqual(['access-r1', 'access-r1', 'access-r1']);
    expect(counter.n).toBe(1);
    const stored = await readStored();
    expect(stored.tokens).toMatchObject({ accessToken: 'access-r1', refreshToken: 'refresh-r1' });

    /** A second instance sharing the file sees the rotated token rather than reusing the old one. */
    const sibling = makeConnection();
    await expect(sibling.getAccessToken(OWNER_ID)).resolves.toBe('access-r1');
    expect(counter.n).toBe(1);
  });

  it('clears unusable tokens on invalid_grant but keeps the registration', async () => {
    const connection = makeConnection();
    await connect(connection);
    clock += 61 * 60 * 1000;
    fake.setTokenHandler(() => ({ status: 400, body: { error: 'invalid_grant' } }));

    await expect(connection.getAccessToken(OWNER_ID)).rejects.toMatchObject({
      code: 'reauth_required',
    });
    const stored = await readStored();
    expect(stored.tokens).toBeNull();
    expect(stored.registration).toMatchObject({ clientId: ISSUED_CLIENT_ID });
    expect(await connection.getStatus()).toMatchObject({
      state: 'reauth_required',
      lastError: 'reauth_required',
    });
  });

  it('keeps credentials on temporary refresh failures', async () => {
    const connection = makeConnection();
    await connect(connection);
    clock += 61 * 60 * 1000;
    fake.setTokenHandler(() => ({ status: 503, body: {} }));

    await expect(connection.getAccessToken(OWNER_ID)).rejects.toMatchObject({
      code: 'refresh_unavailable',
    });
    expect((await readStored()).tokens?.refreshToken).toBe('refresh-code-1');
  });

  it('does not let an in-flight refresh resurrect credentials after disconnect', async () => {
    const connection = makeConnection();
    await connect(connection);
    clock += 61 * 60 * 1000;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const refreshSent = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const originalFetch = fake.fetch;
    const slowFetch: typeof fake.fetch = async (input, init) => {
      const body = typeof init?.body === 'string' ? init.body : '';
      if (String(input).endsWith('/oauth/token') && body.includes('grant_type=refresh_token')) {
        entered();
        await gate;
      }
      return originalFetch(input, init);
    };
    fake.setTokenHandler(() => ({
      status: 200,
      body: {
        access_token: 'access-late',
        refresh_token: 'refresh-late',
        expires_in: 3600,
        scope: FULL_SCOPE,
      },
    }));
    const slow = makeConnection({ fetch: slowFetch });

    const pendingToken = slow.getAccessToken(OWNER_ID);
    await refreshSent;
    const disconnecting = slow.disconnect();
    release();

    await expect(pendingToken).rejects.toMatchObject({ code: 'not_connected' });
    await disconnecting;
    expect((await readStored()).tokens).toBeNull();
    const revoked = fake.revokeCalls().map((call) => call.form?.token);
    expect(revoked).toContain('refresh-late');
    await expect(slow.getAccessToken(OWNER_ID)).rejects.toMatchObject({ code: 'not_connected' });
  });
});

describe('ChatGPT connection: disconnect and cancel', () => {
  it('revokes the refresh token, clears tokens, retains client mapping and host id', async () => {
    const connection = makeConnection();
    await connect(connection);
    const hostBefore = await fs.readFile(path.join(stateDir, 'chatgpt-host-id'), 'utf8');

    const status = await connection.disconnect();
    expect(status).toEqual({
      enabled: true,
      state: 'disconnected',
      planUsage: false,
      revocation: 'confirmed',
    });
    expect(fake.revokeCalls()[0].form).toMatchObject({
      token: 'refresh-code-1',
      token_type_hint: 'refresh_token',
      client_id: ISSUED_CLIENT_ID,
    });
    const stored = await readStored();
    expect(stored.tokens).toBeNull();
    expect(stored.registration).toMatchObject({ clientId: ISSUED_CLIENT_ID, subject: SUBJECT });
    expect(await fs.readFile(path.join(stateDir, 'chatgpt-host-id'), 'utf8')).toBe(hostBefore);
    await expect(connection.getAccessToken(OWNER_ID)).rejects.toMatchObject({
      code: 'not_connected',
    });
  });

  it('reports unconfirmed revocation when the revocation endpoint keeps failing', async () => {
    const connection = makeConnection({ revokeRetryDelayMs: 0 });
    await connect(connection);
    fake.setRevokeStatus(503);
    await expect(connection.disconnect()).resolves.toMatchObject({ revocation: 'unconfirmed' });
    expect(fake.revokeCalls()).toHaveLength(3);
    expect((await readStored()).tokens).toBeNull();
  });

  it('prevents an in-flight callback from saving after cancel or disconnect', async () => {
    for (const stop of ['cancel', 'disconnect'] as const) {
      await fs.rm(path.join(stateDir, 'chatgpt-credentials.json'), { force: true });
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const originalFetch = fake.fetch;
      const connection = makeConnection({
        fetch: async (input, init) => {
          if (String(input).endsWith('/oauth/token')) {
            await gate;
          }
          return originalFetch(input, init);
        },
      });
      const { state, nonce } = await begin(connection);
      fake.setTokenHandler(codeExchangeResponse(nonce));
      const callback = connection.handleCallback({ state, code: 'c', client_id: ISSUED_CLIENT_ID });
      await new Promise((resolve) => setImmediate(resolve));
      if (stop === 'cancel') {
        connection.cancelLogin();
      } else {
        await connection.disconnect();
      }
      release();
      await expect(callback).resolves.toEqual({ ok: false, error: { code: 'cancelled' } });
      await expect(
        fs.readFile(path.join(stateDir, 'chatgpt-credentials.json'), 'utf8'),
      ).rejects.toThrow();
    }
  });
});

describe('ChatGPT connection: inference access and models', () => {
  it('only serves tokens and models to the exact local owner while enabled', async () => {
    const connection = makeConnection();
    await connect(connection);
    await expect(connection.getAccessToken('intruder')).rejects.toMatchObject({
      code: 'forbidden',
    });
    enabled = false;
    await expect(connection.getAccessToken(OWNER_ID)).rejects.toMatchObject({ code: 'disabled' });
    expect(await connection.getStatus()).toEqual({
      enabled: false,
      state: 'disabled',
      planUsage: false,
    });
  });

  it('lists only visible account models from the official models endpoint, preserving order', async () => {
    const connection = makeConnection();
    await connect(connection);
    fake.setModels({
      models: [
        { slug: 'gpt-b', display_name: 'GPT B', visibility: 'list' },
        { slug: 'hidden', display_name: 'Hidden', visibility: 'hide' },
        { slug: 'gpt-a', display_name: 'GPT A', visibility: 'list' },
      ],
    });
    await expect(connection.listModels(OWNER_ID)).resolves.toEqual([
      { slug: 'gpt-b', displayName: 'GPT B' },
      { slug: 'gpt-a', displayName: 'GPT A' },
    ]);
    const modelsCall = fake.calls.find((c) => c.url === 'https://api.openai.com/v1/models');
    expect(modelsCall?.headers?.authorization).toBe('Bearer access-code-1');
    await expect(connection.listModels('intruder')).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('pauses plan requests after a usage-limit failure instead of retrying elsewhere', async () => {
    const connection = makeConnection();
    await connect(connection);
    connection.reportInferenceError({
      status: 429,
      code: 'subscription_sharing_usage_limit_exceeded',
    });
    await expect(connection.getAccessToken(OWNER_ID)).rejects.toMatchObject({
      code: 'usage_limit_exceeded',
    });
    expect((await connection.getStatus()).lastError).toBe('usage_limit_exceeded');
    clock += 61 * 1000;
    await expect(connection.getAccessToken(OWNER_ID)).resolves.toBe('access-code-1');
  });
});
