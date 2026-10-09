import os from 'os';
import path from 'path';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { promises as fs } from 'fs';
import type { FetchLike } from '../oauth';

export const OWNER_ID = 'owner-1';
export const ISSUED_CLIENT_ID = 'oaiapp_test123';
export const SUBJECT = 'user-sub-1';
export const FULL_SCOPE =
  'chatgpt.tokens.use.direct email offline_access openid profile resource.invoke';

const signingKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const foreignKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'test-kid';

export function signIdToken(
  claims: Record<string, unknown>,
  options: { key?: crypto.KeyObject; kid?: string } = {},
): string {
  return jwt.sign(
    {
      iss: 'https://auth.openai.com',
      aud: ISSUED_CLIENT_ID,
      sub: SUBJECT,
      email: 'user@example.com',
      ...claims,
    },
    options.key ?? signingKey.privateKey,
    {
      algorithm: 'RS256',
      keyid: options.kid ?? KID,
      ...('exp' in claims ? {} : { expiresIn: 3600 }),
    },
  );
}

export const foreignPrivateKey = foreignKey.privateKey;

export interface RecordedCall {
  url: string;
  form?: Record<string, string>;
  headers?: Record<string, string>;
}

export type TokenHandler = (form: Record<string, string>) => {
  status: number;
  body: Record<string, unknown>;
};

/**
 * In-memory stand-in for auth.openai.com and api.openai.com/v1/models. Only external HTTP
 * is faked; the connection, store, PKCE and JWT verification run for real.
 */
export function createFakeOpenAI() {
  const calls: RecordedCall[] = [];
  let tokenHandler: TokenHandler = () => ({ status: 500, body: {} });
  let revokeStatus = 200;
  let modelsBody: unknown = { models: [] };
  const jwk = signingKey.publicKey.export({ format: 'jwk' });

  const fetch: FetchLike = async (input, init) => {
    const url = String(input);
    const form =
      typeof init?.body === 'string' && url.startsWith('https://auth.openai.com/api/')
        ? Object.fromEntries(new URLSearchParams(init.body))
        : undefined;
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    calls.push({ url, form, headers });
    if (url === 'https://auth.openai.com/.well-known/jwks.json') {
      return Response.json({ keys: [{ ...jwk, kid: KID, use: 'sig', alg: 'RS256' }] });
    }
    if (url === 'https://auth.openai.com/api/accounts/oauth/token') {
      const result = tokenHandler(form ?? {});
      return Response.json(result.body, { status: result.status });
    }
    if (url === 'https://auth.openai.com/api/accounts/oauth/revoke') {
      return new Response(null, { status: revokeStatus });
    }
    if (url === 'https://api.openai.com/v1/models') {
      return Response.json(modelsBody);
    }
    return new Response('not found', { status: 404 });
  };

  return {
    fetch,
    calls,
    setTokenHandler(handler: TokenHandler) {
      tokenHandler = handler;
    },
    setRevokeStatus(status: number) {
      revokeStatus = status;
    },
    setModels(body: unknown) {
      modelsBody = body;
    },
    tokenCalls: () => calls.filter((c) => c.url.endsWith('/oauth/token')),
    revokeCalls: () => calls.filter((c) => c.url.endsWith('/oauth/revoke')),
  };
}

export function codeExchangeResponse(
  nonce: string,
  overrides: Record<string, unknown> = {},
  idTokenClaims: Record<string, unknown> = {},
) {
  return (form: Record<string, string>) => ({
    status: 200,
    body: {
      access_token: `access-${form.code}`,
      refresh_token: `refresh-${form.code}`,
      id_token: signIdToken({ nonce, ...idTokenClaims }),
      token_type: 'Bearer',
      expires_in: 3600,
      scope: FULL_SCOPE,
      ...overrides,
    },
  });
}

export async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'chatgpt-conn-'));
}
