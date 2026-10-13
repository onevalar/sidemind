/* eslint jest/expect-expect: ["warn", { "assertFunctionNames": ["expect", "expectNoSession"] }] */
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { promises as fs } from 'fs';
import { SystemRoles } from 'librechat-data-provider';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMethods, createModels } from '@librechat/data-schemas';
import type { NewUserData, ISession } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { LocalAccessConfig } from './config';
import { createLocalRefreshHandler } from '~/auth/localRefresh';
import { createPortalAccessMiddleware } from './portal';
import { createLaunchTicketStore } from './tickets';
import { resolveLocalAccessConfig } from './config';
import { createLocalAccessRouter } from './router';

const ORIGIN = 'http://127.0.0.1:3080';
const HOST = '127.0.0.1:3080';
const LAUNCH_KEY = 'k'.repeat(43);
const REFRESH_PROJECTION = '-password -__v -totpSecret -backupCodes -federatedTokens';
const PORTAL_ORIGIN = 'https://chatgit-preview.onamp.dev';
const PORTAL_HEADERS = {
  Host: 'chatgit-preview.onamp.dev',
  'X-Forwarded-Proto': 'https',
  'X-Amp-Authenticated': 'amp-user=yes, workspace-member=no, collaborator=yes',
  'X-Amp-User-ID': 'user_previewOwner',
};

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createMethods>;
let stateDir: string;
let config: Extract<LocalAccessConfig, { ok: true }>;
let now: number;

beforeAll(async () => {
  process.env.JWT_SECRET = 'local-access-test-jwt-secret';
  process.env.JWT_REFRESH_SECRET = 'local-access-test-refresh-secret';
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  methods = createMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chatgit-local-'));
  const launchKeyFile = path.join(stateDir, 'launch.key');
  await fs.writeFile(launchKeyFile, `${LAUNCH_KEY}\n`, { mode: 0o600 });
  config = {
    enabled: true,
    ok: true,
    origin: ORIGIN,
    host: HOST,
    launchKeyFile,
    ownerFile: path.join(stateDir, 'local-owner.json'),
  };
  now = Date.now();
});

afterEach(async () => {
  await fs.rm(stateDir, { recursive: true, force: true });
});

/** The session issuance the app wires in (AuthService.setAuthTokens), on the real session store. */
async function setAuthTokens(
  userId: string,
  res: Response,
  session: Pick<ISession, 'expiration'> | null,
): Promise<string> {
  let refreshToken: string;
  let expiration: Date;
  if (session?.expiration && '_id' in session) {
    refreshToken = await methods.generateRefreshToken(session as ISession);
    expiration = session.expiration;
  } else {
    const created = await methods.createSession(userId, { expiresIn: 60 * 60 * 1000 });
    refreshToken = created.refreshToken;
    expiration = created.session.expiration ?? new Date(Date.now() + 60 * 60 * 1000);
  }
  const user = await methods.getUserById(userId);
  const token = await methods.generateToken(user!, 15 * 60 * 1000);
  res.cookie('refreshToken', refreshToken, {
    expires: expiration,
    httpOnly: true,
    sameSite: 'strict',
  });
  return token;
}

/** Mirrors the data-schemas method, which this package's built copy may predate. */
async function createUserWithIdIfAbsent(userId: string, data: NewUserData) {
  try {
    await mongoose.models.User.create({ ...data, _id: new mongoose.Types.ObjectId(userId) });
    return { ok: true as const };
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      return { ok: false as const, error: { code: 'user_exists' } };
    }
    throw error;
  }
}

function buildApp(overrides: { config?: LocalAccessConfig; peer?: string } = {}): express.Express {
  const app = express();
  if (overrides.peer) {
    const peer = overrides.peer;
    app.use((req, _res, next) => {
      Object.defineProperty(req, 'socket', { value: { remoteAddress: peer } });
      next();
    });
  }
  app.use(createPortalAccessMiddleware(overrides.config ?? config));
  const tickets = createLaunchTicketStore({ now: () => now });
  app.use(
    '/api/local',
    createLocalAccessRouter({
      config: overrides.config ?? config,
      getUserById: (userId: string) => methods.getUserById(userId),
      countUsers: () => methods.countUsers(),
      createUserWithIdIfAbsent,
      setAuthTokens: (userId: string, res: Response) => setAuthTokens(userId, res, null),
      tickets,
    }),
  );
  const refresh = createLocalRefreshHandler({
    userProjection: REFRESH_PROJECTION,
    getUserById: (userId, projection) => methods.getUserById(userId, projection),
    findSession: (query, options) => methods.findSession(query, options),
    setAuthTokens: (userId, res, session) => setAuthTokens(userId, res, session),
    deleteSession: (query) => methods.deleteSession(query),
    deleteAllUserSessions: (query) => methods.deleteAllUserSessions(query),
    clearCloudFrontCookies: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  });
  app.post('/api/auth/refresh', async (req: Request, res: Response) => {
    const match = /(?:^|;\s*)refreshToken=([^;]+)/.exec(req.headers.cookie ?? '');
    await refresh(req, res, match ? decodeURIComponent(match[1]) : undefined);
  });
  return app;
}

const launch = (app: express.Express, key = LAUNCH_KEY) =>
  request(app).post('/api/local/launch').set('Host', HOST).set('Authorization', `Bearer ${key}`);

const exchange = (app: express.Express, ticket: string) =>
  request(app)
    .post('/api/local/session')
    .set('Host', HOST)
    .set('Origin', ORIGIN)
    .set('Sec-Fetch-Site', 'same-origin')
    .set('Content-Type', 'application/json')
    .send(JSON.stringify({ ticket }));

async function issueTicket(app: express.Express): Promise<string> {
  const res = await launch(app);
  expect(res.status).toBe(200);
  return res.body.ticket as string;
}

const refreshCookie = (res: request.Response): string | undefined => {
  const header = res.headers['set-cookie'] as unknown as string[] | undefined;
  return header?.find((cookie) => cookie.startsWith('refreshToken='))?.split(';')[0];
};

describe('orb portal access', () => {
  const portalConfig = (): LocalAccessConfig => ({
    ...config,
    portal: {
      origin: PORTAL_ORIGIN,
      host: 'chatgit-preview.onamp.dev',
      userId: 'user_previewOwner',
      frameOrigin: 'https://ampcode.com',
    },
  });

  it('enters the same passwordless workspace and refreshes with iframe-safe cookies', async () => {
    const app = buildApp({ config: portalConfig() });
    await issueTicket(app);
    const ownerId = JSON.parse(await fs.readFile(config.ownerFile, 'utf8')).userId;
    const entered = await request(app).get('/api/local/portal').set(PORTAL_HEADERS);
    expect(entered.status).toBe(302);
    expect(entered.headers.location).toBe('/canvas/');
    expect(entered.headers['cache-control']).toBe('no-store');
    expect(entered.headers['content-security-policy']).toBe(
      "frame-ancestors 'self' https://ampcode.com",
    );
    const cookie = refreshCookie(entered)!;
    const refreshed = await request(app)
      .post('/api/auth/refresh')
      .set(PORTAL_HEADERS)
      .set('Origin', PORTAL_ORIGIN)
      .set('Cookie', cookie);
    expect(refreshed.status).toBe(200);
    expect(String(refreshed.body.user._id)).toBe(ownerId);
    for (const response of [entered, refreshed]) {
      const header = response.headers['set-cookie'][0];
      for (const attribute of ['HttpOnly', 'Secure', 'SameSite=None', 'Partitioned']) {
        expect(header).toContain(attribute);
      }
    }
    expect(await methods.countUsers()).toBe(1);
  });

  it.each([
    ['missing Amp authentication', { 'X-Amp-Authenticated': '' }],
    ['an unauthenticated visitor', { 'X-Amp-Authenticated': 'amp-user=no, collaborator=no' }],
    ['a viewer, not a collaborator', { 'X-Amp-Authenticated': 'amp-user=yes, collaborator=no' }],
    ['another collaborator', { 'X-Amp-User-ID': 'user_someoneElse' }],
    ['a missing identity', { 'X-Amp-User-ID': '' }],
    ['another portal Host', { Host: 'other-preview.onamp.dev' }],
    ['plain HTTP', { 'X-Forwarded-Proto': 'http' }],
    ['a foreign browser Origin', { Origin: 'https://evil.example' }],
  ])('refuses %s without creating a user or session', async (_label, headers) => {
    const app = buildApp({ config: portalConfig() });
    const res = await request(app).get('/api/local/portal').set(PORTAL_HEADERS).set(headers);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ code: 'PORTAL_ACCESS_DENIED' });
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(await methods.countUsers()).toBe(0);
    expect(await mongoose.models.Session.countDocuments()).toBe(0);
  });

  it('refuses forged portal identity from a non-loopback peer', async () => {
    const app = buildApp({ config: portalConfig(), peer: '203.0.113.18' });
    const res = await request(app).get('/api/local/portal').set(PORTAL_HEADERS);
    expect(res.status).toBe(403);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('checks portal identity even when the request already carries a valid session', async () => {
    const app = buildApp({ config: portalConfig() });
    const entered = await request(app).get('/api/local/portal').set(PORTAL_HEADERS);
    const denied = await request(app)
      .post('/api/auth/refresh')
      .set(PORTAL_HEADERS)
      .set('X-Amp-User-ID', 'user_someoneElse')
      .set('Cookie', refreshCookie(entered)!);
    expect(denied.status).toBe(403);
    expect(denied.headers['set-cookie']).toBeUndefined();
  });

  it('keeps launcher endpoints private and leaves the portal entry off outside preview', async () => {
    const app = buildApp({ config: portalConfig() });
    const launched = await launch(app).set(PORTAL_HEADERS);
    expect(launched.status).toBe(403);
    expect(launched.body).toEqual({ code: 'LOCAL_ACCESS_DENIED' });
    const ordinary = await request(buildApp()).get('/api/local/portal').set(PORTAL_HEADERS);
    expect(ordinary.status).toBe(404);
  });

  it('deletes portal cookies in the same partition without changing local cookies', async () => {
    const app = buildApp({ config: portalConfig() });
    app.get('/close', (_req, res) => {
      res.clearCookie('refreshToken');
      res.clearCookie('token_provider');
      res.sendStatus(204);
    });
    const portal = await request(app).get('/close').set(PORTAL_HEADERS);
    expect(portal.status).toBe(204);
    for (const header of portal.headers['set-cookie']) {
      expect(header).toContain('Partitioned');
      expect(header).toContain('Secure');
      expect(header).toContain('SameSite=None');
      expect(header).toContain('Expires=Thu, 01 Jan 1970');
    }
    const local = await request(app).get('/close').set('Host', HOST);
    for (const header of local.headers['set-cookie']) {
      expect(header).not.toContain('Partitioned');
      expect(header).not.toContain('SameSite=None');
    }
  });
});

describe('local access: launcher to session', () => {
  it('creates one passwordless USER owner, persists its id, and issues a refreshable session', async () => {
    const app = buildApp();
    const launched = await launch(app);
    expect(launched.status).toBe(200);
    expect(launched.headers['cache-control']).toBe('no-store');
    expect(launched.body).toEqual({
      ticket: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      expiresIn: 60,
    });

    const binding = JSON.parse(await fs.readFile(config.ownerFile, 'utf8'));
    const stat = await fs.stat(config.ownerFile);
    expect(stat.mode & 0o077).toBe(0);
    const owner = await mongoose.models.User.findById(binding.userId).select('+password').lean<{
      role: string;
      password?: string;
      email: string;
    }>();
    expect(owner).toEqual(
      expect.objectContaining({ role: SystemRoles.USER, email: 'owner@chatgit.local' }),
    );
    expect(owner?.password).toBeUndefined();

    const exchanged = await exchange(app, launched.body.ticket);
    expect(exchanged.status).toBe(200);
    expect(exchanged.body.token).toEqual(expect.any(String));
    expect(exchanged.body.user).toEqual(expect.objectContaining({ id: binding.userId }));
    expect(exchanged.body.user.password).toBeUndefined();
    const cookie = refreshCookie(exchanged);
    expect(cookie).toBeDefined();
    expect(exchanged.headers['set-cookie']?.[0]).toMatch(/HttpOnly/);

    const refreshed = await request(app).post('/api/auth/refresh').set('Cookie', cookie!);
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.token).toEqual(expect.any(String));
    expect(String(refreshed.body.user._id)).toBe(binding.userId);
  });

  it('reuses the bound owner on later launches instead of creating another', async () => {
    const app = buildApp();
    await issueTicket(app);
    const first = JSON.parse(await fs.readFile(config.ownerFile, 'utf8')).userId;
    const later = buildApp();
    await issueTicket(later);
    expect(JSON.parse(await fs.readFile(config.ownerFile, 'utf8')).userId).toBe(first);
    expect(await methods.countUsers()).toBe(1);
  });

  it('serializes concurrent first launches into one owner', async () => {
    const app = buildApp();
    const results = await Promise.all([launch(app), launch(app), launch(app)]);
    expect(results.map((res) => res.status)).toEqual([200, 200, 200]);
    expect(await methods.countUsers()).toBe(1);
  });

  it('never mints a session from refresh without a cookie', async () => {
    const app = buildApp();
    await issueTicket(app);
    const res = await request(app).post('/api/auth/refresh');
    expect(res.status).toBe(200);
    expect(res.text).toBe('Refresh token not provided');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(await mongoose.models.Session.countDocuments()).toBe(0);
  });
});

describe('local access: launch endpoint refusals', () => {
  it.each([
    ['no key', undefined],
    ['a wrong key', 'w'.repeat(43)],
  ])('refuses %s without creating an owner or a ticket', async (_label, key) => {
    const app = buildApp();
    const req = request(app).post('/api/local/launch').set('Host', HOST);
    const res = key ? await req.set('Authorization', `Bearer ${key}`) : await req;
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ code: 'LOCAL_LAUNCH_KEY_INVALID' });
    await expect(fs.stat(config.ownerFile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await methods.countUsers()).toBe(0);
  });

  it('treats a key file readable by other accounts as unavailable', async () => {
    await fs.chmod(config.launchKeyFile, 0o644);
    const res = await launch(buildApp());
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ code: 'LOCAL_LAUNCH_KEY_UNAVAILABLE' });
  });

  it.each([
    ['a rebinding Host', { Host: 'evil.example:3080' }],
    ['a localhost Host', { Host: 'localhost:3080' }],
    ['X-Forwarded-For', { 'X-Forwarded-For': '127.0.0.1' }],
    ['X-Forwarded-Host', { 'X-Forwarded-Host': HOST }],
    ['Forwarded', { Forwarded: 'for=127.0.0.1' }],
    ['X-Real-IP', { 'X-Real-IP': '127.0.0.1' }],
    ['a browser Origin', { Origin: ORIGIN }],
    ['browser fetch metadata', { 'Sec-Fetch-Site': 'same-origin' }],
    ['a cookie', { Cookie: 'refreshToken=x' }],
  ])('refuses %s even with the right key', async (_label, headers) => {
    const res = await launch(buildApp()).set(headers);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ code: 'LOCAL_ACCESS_DENIED' });
    expect(await methods.countUsers()).toBe(0);
  });

  it('refuses a peer that is not on loopback', async () => {
    const res = await launch(buildApp({ peer: '203.0.113.7' }));
    expect(res.status).toBe(403);
    expect(await methods.countUsers()).toBe(0);
  });

  it('refuses a database that already has an unbound account and leaves it untouched', async () => {
    const existing = await mongoose.models.User.create({
      email: 'admin@example.com',
      provider: 'local',
      role: SystemRoles.ADMIN,
    });
    const res = await launch(buildApp());
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ code: 'LOCAL_DATABASE_HAS_ACCOUNTS' });
    await expect(fs.stat(config.ownerFile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await methods.countUsers()).toBe(1);
    expect((await mongoose.models.User.findById(existing._id).lean<{ role: string }>())?.role).toBe(
      SystemRoles.ADMIN,
    );
  });

  it('refuses a multi-account database the same way', async () => {
    await mongoose.models.User.create([
      { email: 'a@example.com', provider: 'local' },
      { email: 'b@example.com', provider: 'local' },
    ]);
    const res = await launch(buildApp());
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ code: 'LOCAL_DATABASE_HAS_ACCOUNTS' });
    expect(await methods.countUsers()).toBe(2);
  });

  it('refuses when the bound owner is gone but other accounts exist', async () => {
    const app = buildApp();
    await issueTicket(app);
    const { userId } = JSON.parse(await fs.readFile(config.ownerFile, 'utf8'));
    await mongoose.models.User.deleteOne({ _id: userId });
    await mongoose.models.User.create({ email: 'other@example.com', provider: 'local' });
    const res = await launch(app);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ code: 'LOCAL_OWNER_MISSING' });
    expect(await methods.countUsers()).toBe(1);
  });

  it('resumes an interrupted creation under the persisted id', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    await fs.writeFile(config.ownerFile, JSON.stringify({ version: 1, userId }), { mode: 0o600 });
    await issueTicket(buildApp());
    expect(await mongoose.models.User.exists({ _id: userId })).toBeTruthy();
    expect(await methods.countUsers()).toBe(1);
  });

  it('refuses a malformed binding file', async () => {
    await fs.writeFile(config.ownerFile, '{"userId":"nope"}', { mode: 0o600 });
    const res = await launch(buildApp());
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ code: 'LOCAL_OWNER_BINDING_INVALID' });
    expect(await methods.countUsers()).toBe(0);
  });
});

describe('local access: ticket exchange refusals', () => {
  const expectNoSession = async (res: request.Response, status: number, code: string) => {
    expect(res.status).toBe(status);
    expect(res.body).toEqual({ code });
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(await mongoose.models.Session.countDocuments()).toBe(0);
  };

  it('refuses a missing or unknown ticket', async () => {
    const app = buildApp();
    await issueTicket(app);
    const missing = await request(app)
      .post('/api/local/session')
      .set('Host', HOST)
      .set('Origin', ORIGIN)
      .set('Content-Type', 'application/json')
      .send('{}');
    await expectNoSession(missing, 401, 'LOCAL_TICKET_INVALID');
    await expectNoSession(await exchange(app, 'x'.repeat(43)), 401, 'LOCAL_TICKET_INVALID');
  });

  it('refuses an expired ticket', async () => {
    const app = buildApp();
    const ticket = await issueTicket(app);
    now += 60_001;
    await expectNoSession(await exchange(app, ticket), 401, 'LOCAL_TICKET_INVALID');
  });

  it('accepts a ticket once and refuses its replay', async () => {
    const app = buildApp();
    const ticket = await issueTicket(app);
    expect((await exchange(app, ticket)).status).toBe(200);
    const replay = await exchange(app, ticket);
    expect(replay.status).toBe(401);
    expect(replay.headers['set-cookie']).toBeUndefined();
    expect(await mongoose.models.Session.countDocuments()).toBe(1);
  });

  it('lets exactly one of several concurrent exchanges of a ticket through', async () => {
    const app = buildApp();
    const ticket = await issueTicket(app);
    const results = await Promise.all([1, 2, 3, 4].map(() => exchange(app, ticket)));
    expect(results.map((res) => res.status).sort()).toEqual([200, 401, 401, 401]);
    expect(await mongoose.models.Session.countDocuments()).toBe(1);
  });

  it.each([
    ['a foreign Origin', { Origin: 'http://evil.example:3080' }],
    ['a localhost Origin', { Origin: 'http://localhost:3080' }],
    ['a rebinding Host', { Host: 'evil.example:3080', Origin: 'http://evil.example:3080' }],
    ['cross-site fetch metadata', { 'Sec-Fetch-Site': 'cross-site' }],
    ['X-Forwarded-For', { 'X-Forwarded-For': '127.0.0.1' }],
    ['X-Forwarded-Proto', { 'X-Forwarded-Proto': 'https' }],
    ['Forwarded', { Forwarded: 'for=127.0.0.1' }],
    ['Via', { Via: '1.1 proxy' }],
  ])('refuses %s and leaves the ticket unspent', async (_label, headers) => {
    const app = buildApp();
    const ticket = await issueTicket(app);
    await expectNoSession(await exchange(app, ticket).set(headers), 403, 'LOCAL_ACCESS_DENIED');
    expect((await exchange(app, ticket)).status).toBe(200);
  });

  it('refuses a request without an Origin header', async () => {
    const app = buildApp();
    const ticket = await issueTicket(app);
    const res = await request(app)
      .post('/api/local/session')
      .set('Host', HOST)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ ticket }));
    await expectNoSession(res, 403, 'LOCAL_ACCESS_DENIED');
  });

  it('refuses a form post', async () => {
    const app = buildApp();
    const ticket = await issueTicket(app);
    const res = await request(app)
      .post('/api/local/session')
      .set('Host', HOST)
      .set('Origin', ORIGIN)
      .type('form')
      .send({ ticket });
    await expectNoSession(res, 403, 'LOCAL_ACCESS_DENIED');
  });

  it('refuses a non-loopback peer', async () => {
    const app = buildApp({ peer: '10.0.0.8' });
    const res = await exchange(app, 'x'.repeat(43));
    await expectNoSession(res, 403, 'LOCAL_ACCESS_DENIED');
  });

  it('burns the ticket but mints nothing when the owner is not bound', async () => {
    const app = buildApp();
    const ticket = await issueTicket(app);
    await fs.rm(config.ownerFile);
    await expectNoSession(await exchange(app, ticket), 409, 'LOCAL_OWNER_UNBOUND');
    expect(await methods.countUsers()).toBe(1);
  });
});

describe('local access: bootstrap page and status', () => {
  it('serves a self-contained page that strips the fragment before anything else', async () => {
    const res = await request(buildApp()).get('/api/local/open').set('Host', HOST);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    const csp = res.headers['content-security-policy'];
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(csp).toContain("default-src 'none'");
    expect(res.text).toContain(`<script nonce="${nonce}">`);
    expect(res.text).not.toMatch(/<script[^>]+src=/);
    expect(res.text.indexOf('history.replaceState')).toBeLessThan(res.text.indexOf('fetch('));
  });

  it.each([
    ['a rebinding Host', { Host: 'evil.example:3080' }],
    ['a forwarded request', { Host: HOST, 'X-Forwarded-For': '198.51.100.2' }],
  ])('refuses the page for %s', async (_label, headers) => {
    const res = await request(buildApp()).get('/api/local/open').set(headers);
    expect(res.status).toBe(403);
  });

  it('reports local mode and closes every other route when it is off', async () => {
    const off = buildApp({ config: resolveLocalAccessConfig({}) });
    expect((await request(off).get('/api/local/status')).body).toEqual({ localMode: false });
    expect((await launch(off)).status).toBe(404);
    expect((await request(off).get('/api/local/open').set('Host', HOST)).status).toBe(404);
    expect((await request(buildApp()).get('/api/local/status')).body).toEqual({ localMode: true });
  });

  it('stays closed when local mode is misconfigured', async () => {
    const broken = buildApp({
      config: resolveLocalAccessConfig({ CHATGIT_LOCAL_MODE: 'true', HOST: '0.0.0.0' }),
    });
    expect((await launch(broken)).status).toBe(503);
    expect(await methods.countUsers()).toBe(0);
  });
});

describe('resolveLocalAccessConfig', () => {
  const valid = {
    CHATGIT_LOCAL_MODE: 'true',
    CHATGIT_LOCAL_ORIGIN: ORIGIN,
    HOST: '127.0.0.1',
    PORT: '3080',
    MONGO_URI: 'mongodb://127.0.0.1:27017/ChatGit',
    CHATGIT_LAUNCH_KEY_FILE: '/state/launch.key',
    CHATGIT_LOCAL_OWNER_FILE: '/state/local-owner.json',
  };

  it('accepts the runtime contract', () => {
    expect(resolveLocalAccessConfig(valid)).toEqual({
      enabled: true,
      ok: true,
      origin: ORIGIN,
      host: HOST,
      launchKeyFile: '/state/launch.key',
      ownerFile: '/state/local-owner.json',
    });
  });

  const portalEnv = {
    ...valid,
    CHATGIT_PORTAL_MODE: 'true',
    AMP_ORB: '1',
    AMP_THREAD_ID: 'T-preview',
    AMP_USER_ID: 'user_previewOwner',
    AMP_URL: 'https://ampcode.com',
    PUBLIC_URL: PORTAL_ORIGIN,
  };

  it('accepts an explicitly enabled HTTPS orb portal without changing the local origin', () => {
    expect(resolveLocalAccessConfig(portalEnv)).toMatchObject({
      enabled: true,
      ok: true,
      origin: ORIGIN,
      host: HOST,
      portal: {
        origin: PORTAL_ORIGIN,
        host: 'chatgit-preview.onamp.dev',
        userId: 'user_previewOwner',
        frameOrigin: 'https://ampcode.com',
      },
    });
  });

  it.each([
    { AMP_ORB: '' },
    { AMP_THREAD_ID: '' },
    { AMP_USER_ID: '' },
    { AMP_URL: '' },
    { AMP_URL: 'http://ampcode.com' },
    { PUBLIC_URL: '' },
    { PUBLIC_URL: 'http://chatgit-preview.onamp.dev' },
    { PUBLIC_URL: 'https://user:password@chatgit-preview.onamp.dev' },
    { PUBLIC_URL: 'https://chatgit-preview.onamp.dev/other' },
  ])('refuses an incomplete or unsafe portal configuration %o', (override) => {
    expect(resolveLocalAccessConfig({ ...portalEnv, ...override })).toMatchObject({
      enabled: true,
      ok: false,
    });
  });

  it('is off unless explicitly true', () => {
    expect(resolveLocalAccessConfig({ ...valid, CHATGIT_LOCAL_MODE: 'false' })).toEqual({
      enabled: false,
    });
    expect(resolveLocalAccessConfig({ ...valid, CHATGIT_LOCAL_MODE: '1' })).toEqual({
      enabled: false,
    });
  });

  it.each([
    { CHATGIT_LOCAL_ORIGIN: 'http://localhost:3080' },
    { CHATGIT_LOCAL_ORIGIN: 'https://127.0.0.1:3080' },
    { CHATGIT_LOCAL_ORIGIN: 'http://127.0.0.1:3080/sub' },
    { HOST: '0.0.0.0' },
    { PORT: '3081' },
    { MONGO_URI: 'mongodb://db.example:27017/ChatGit' },
    { MONGO_URI: 'mongodb+srv://cluster.example/ChatGit' },
    { CHATGIT_LAUNCH_KEY_FILE: 'relative.key' },
  ])('fails closed for %o', (override) => {
    expect(resolveLocalAccessConfig({ ...valid, ...override })).toMatchObject({
      enabled: true,
      ok: false,
    });
  });
});
