import express from 'express';
import request from 'supertest';
import { promises as fs } from 'fs';
import type { Request, Response, NextFunction } from 'express';
import {
  OWNER_ID,
  makeTempDir,
  ISSUED_CLIENT_ID,
  createFakeOpenAI,
  codeExchangeResponse,
} from './fakeAuth.helper';
import { createChatGPTConnection } from '../connection';
import { isChatGPTConnectionAllowed } from '../index';
import { createFileCredentialStore } from '../store';
import { createChatGPTRouter } from '../router';

let stateDir: string;

/** Stands in for the app's JWT middleware: `x-test-user` plays the verified token subject. */
function fakeJwt(req: Request, res: Response, next: NextFunction) {
  const id = req.header('x-test-user');
  if (!id) {
    res.status(401).end();
    return;
  }
  (req as Request & { user?: { id: string } }).user = { id };
  next();
}

function buildApp(flags: { localMode?: string; previewMode?: string }) {
  const fake = createFakeOpenAI();
  const connection = createChatGPTConnection({
    store: createFileCredentialStore(stateDir),
    port: 3080,
    isEnabled: () => isChatGPTConnectionAllowed(flags),
    getLocalOwnerId: () => OWNER_ID,
    fetch: fake.fetch,
  });
  const app = express();
  app.use('/api/chatgpt', createChatGPTRouter({ connection, requireJwtAuth: fakeJwt }));
  return { app, fake };
}

beforeEach(async () => {
  stateDir = await makeTempDir();
});

afterEach(async () => {
  await fs.rm(stateDir, { recursive: true, force: true });
});

describe('isChatGPTConnectionAllowed', () => {
  it('requires CHATGIT_LOCAL_MODE exactly true and never allows preview mode', () => {
    expect(isChatGPTConnectionAllowed({ localMode: 'true' })).toBe(true);
    expect(isChatGPTConnectionAllowed({ localMode: 'TRUE' })).toBe(false);
    expect(isChatGPTConnectionAllowed({ localMode: '1' })).toBe(false);
    expect(isChatGPTConnectionAllowed({})).toBe(false);
    expect(isChatGPTConnectionAllowed({ localMode: 'true', previewMode: 'true' })).toBe(false);
  });
});

describe('ChatGPT routes', () => {
  it.each([
    ['local mode unset', {}],
    ['preview mode', { localMode: 'true', previewMode: 'true' }],
  ])('404s every route with %s, including the callback', async (_label, flags) => {
    const { app, fake } = buildApp(flags);
    for (const [method, path] of [
      ['get', '/api/chatgpt/status'],
      ['post', '/api/chatgpt/login'],
      ['post', '/api/chatgpt/disconnect'],
      ['get', '/api/chatgpt/models'],
      ['get', '/api/chatgpt/callback?state=s&code=c'],
    ] as const) {
      const res = await request(app)[method](path).set('x-test-user', OWNER_ID);
      expect(res.status).toBe(404);
    }
    expect(fake.calls).toHaveLength(0);
  });

  it('requires the JWT and the exact local owner for management routes', async () => {
    const { app } = buildApp({ localMode: 'true' });
    expect((await request(app).post('/api/chatgpt/login')).status).toBe(401);
    const intruder = await request(app).post('/api/chatgpt/login').set('x-test-user', 'other');
    expect(intruder.status).toBe(403);
    expect(intruder.body).toEqual({ error: { code: 'forbidden' } });
    expect((await request(app).get('/api/chatgpt/status').set('x-test-user', 'other')).status).toBe(
      403,
    );
  });

  it('completes the flow through the unauthenticated callback with token-free responses', async () => {
    const { app, fake } = buildApp({ localMode: 'true' });
    const login = await request(app).post('/api/chatgpt/login').set('x-test-user', OWNER_ID);
    expect(login.status).toBe(200);
    expect(login.headers['cache-control']).toBe('no-store');
    const url = new URL(login.body.authorizationUrl);
    const state = url.searchParams.get('state') ?? '';
    fake.setTokenHandler(codeExchangeResponse(url.searchParams.get('nonce') ?? ''));

    const forged = await request(app).get(
      `/api/chatgpt/callback?state=forged&code=c&client_id=${ISSUED_CLIENT_ID}`,
    );
    expect(forged.status).toBe(400);
    expect(forged.text).not.toContain('forged');
    expect(fake.tokenCalls()).toHaveLength(0);

    const callback = await request(app).get(
      `/api/chatgpt/callback?state=${encodeURIComponent(state)}&code=c&client_id=${ISSUED_CLIENT_ID}`,
    );
    expect(callback.status).toBe(200);
    expect(callback.headers['content-security-policy']).toContain("default-src 'none'");
    expect(callback.text).not.toMatch(/access-|refresh-|eyJ/);

    const status = await request(app).get('/api/chatgpt/status').set('x-test-user', OWNER_ID);
    expect(status.body).toMatchObject({ state: 'connected', planUsage: true });
    expect(JSON.stringify(status.body)).not.toMatch(/access-|refresh-|eyJ/);

    const disconnected = await request(app)
      .post('/api/chatgpt/disconnect')
      .set('x-test-user', OWNER_ID);
    expect(disconnected.body).toMatchObject({ state: 'disconnected', revocation: 'confirmed' });
  });
});
