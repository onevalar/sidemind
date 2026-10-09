import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import type { JwtPayload } from 'jsonwebtoken';
import {
  CHATGPT_ISSUER,
  CHATGPT_RESOURCE,
  AGENT_NAME_HINT,
  CHATGPT_JWKS_URL,
  CHATGPT_TOKEN_URL,
  DYNAMIC_CLIENT_ID,
  REQUESTED_SCOPES,
  CHATGPT_REVOKE_URL,
  CHATGPT_AUTHORIZE_URL,
} from './constants';
import { ChatGPTError } from './errors';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const NETWORK_TIMEOUT_MS = 15000;
const CLOCK_TOLERANCE_SECONDS = 5;
const ISSUED_CLIENT_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,200}$/;

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function pkceChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

/** Constant-time comparison for opaque values such as `state`. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function isIssuedClientId(value: unknown): value is string {
  return (
    typeof value === 'string' && value !== DYNAMIC_CLIENT_ID && ISSUED_CLIENT_ID_PATTERN.test(value)
  );
}

export interface AuthorizeParams {
  clientId: string;
  hostId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
  loginHint?: string;
}

/**
 * Builds the authorization URL; `agent_name_hint` only accompanies first-time registration.
 * `id_token_hint` is deliberately never sent: the URL travels through the user's browser
 * and history, so returning sign-in uses the issued client and `login_hint` only.
 */
export function buildAuthorizeUrl(params: AuthorizeParams): string {
  const url = new URL(CHATGPT_AUTHORIZE_URL);
  const query = url.searchParams;
  query.set('client_id', params.clientId);
  if (params.clientId === DYNAMIC_CLIENT_ID) {
    query.set('agent_name_hint', AGENT_NAME_HINT);
  }
  query.set('ext_agent_host_id', params.hostId);
  if (params.clientId !== DYNAMIC_CLIENT_ID && params.loginHint) {
    query.set('login_hint', params.loginHint);
  }
  query.set('response_type', 'code');
  query.set('redirect_uri', params.redirectUri);
  query.set('scope', REQUESTED_SCOPES.join(' '));
  query.set('resource', CHATGPT_RESOURCE);
  query.set('state', params.state);
  query.set('nonce', params.nonce);
  query.set('code_challenge_method', 'S256');
  query.set('code_challenge', params.codeChallenge);
  return url.toString();
}

export interface TokenResponse {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  tokenType: string;
  expiresIn: number;
  scopes?: string[];
  earliestRefreshAt?: number;
}

export type TokenEndpointResult =
  | { ok: true; value: TokenResponse }
  | { ok: false; status: number; code?: string };

function parseScopes(value: unknown): string[] | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  return value.split(/\s+/).filter(Boolean);
}

function parseTokenBody(body: Record<string, unknown>): TokenResponse | null {
  const { access_token, refresh_token, id_token, token_type, expires_in } = body;
  if (typeof access_token !== 'string' || access_token === '') {
    return null;
  }
  const expiresIn = typeof expires_in === 'number' && expires_in > 0 ? expires_in : 3600;
  const earliest = body.earliest_refresh_at;
  return {
    accessToken: access_token,
    refreshToken: typeof refresh_token === 'string' && refresh_token ? refresh_token : undefined,
    idToken: typeof id_token === 'string' && id_token ? id_token : undefined,
    tokenType: typeof token_type === 'string' ? token_type : 'Bearer',
    expiresIn,
    scopes: parseScopes(body.scope),
    earliestRefreshAt: typeof earliest === 'number' ? earliest * 1000 : undefined,
  };
}

async function postForm(
  fetchFn: FetchLike,
  url: string,
  form: Record<string, string>,
): Promise<Response> {
  try {
    return await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
    });
  } catch {
    throw new ChatGPTError('network_error', 503);
  }
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const body = (await response.json()) as unknown;
    return body != null && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** POSTs a token grant. Throws only for network failures; HTTP failures return a code. */
export async function requestToken(
  fetchFn: FetchLike,
  form: Record<string, string>,
): Promise<TokenEndpointResult> {
  const response = await postForm(fetchFn, CHATGPT_TOKEN_URL, {
    ...form,
    resource: CHATGPT_RESOURCE,
  });
  const body = await readJson(response);
  if (!response.ok) {
    const code = typeof body?.error === 'string' ? body.error : undefined;
    return { ok: false, status: response.status, code };
  }
  const parsed = body ? parseTokenBody(body) : null;
  if (!parsed) {
    return { ok: false, status: 502 };
  }
  return { ok: true, value: parsed };
}

/** Revokes a refresh token; `true` only for the documented HTTP 200 success response. */
export async function revokeRefreshToken(
  fetchFn: FetchLike,
  clientId: string,
  refreshToken: string,
): Promise<boolean> {
  try {
    const response = await postForm(fetchFn, CHATGPT_REVOKE_URL, {
      token: refreshToken,
      token_type_hint: 'refresh_token',
      client_id: clientId,
    });
    return response.status === 200;
  } catch {
    return false;
  }
}

interface Jwk {
  kid?: string;
  kty?: string;
  use?: string;
  alg?: string;
  n?: string;
  e?: string;
}

const JWKS_TTL_MS = 10 * 60 * 1000;
const JWKS_MIN_REFETCH_MS = 30 * 1000;

/** JWKS cache that refetches at most every 30s when an unfamiliar `kid` appears. */
export function createJwksResolver(fetchFn: FetchLike, now: () => number) {
  let keys: Jwk[] = [];
  let fetchedAt = 0;

  async function load(): Promise<void> {
    let response: Response;
    try {
      response = await fetchFn(CHATGPT_JWKS_URL, {
        headers: { Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
      });
    } catch {
      throw new ChatGPTError('network_error', 503);
    }
    const body = response.ok ? await readJson(response) : null;
    if (!body || !Array.isArray(body.keys)) {
      throw new ChatGPTError('id_token_invalid', 502);
    }
    keys = body.keys as Jwk[];
    fetchedAt = now();
  }

  return async function resolveKey(kid: string): Promise<crypto.KeyObject> {
    const stale = now() - fetchedAt > JWKS_TTL_MS;
    let jwk = stale ? undefined : keys.find((key) => key.kid === kid);
    if (!jwk && (stale || now() - fetchedAt > JWKS_MIN_REFETCH_MS)) {
      await load();
      jwk = keys.find((key) => key.kid === kid);
    }
    if (!jwk || jwk.kty !== 'RSA' || (jwk.use != null && jwk.use !== 'sig')) {
      throw new ChatGPTError('id_token_invalid');
    }
    try {
      return crypto.createPublicKey({ key: jwk as crypto.JsonWebKey, format: 'jwk' });
    } catch {
      throw new ChatGPTError('id_token_invalid');
    }
  };
}

export interface VerifiedIdentity {
  subject: string;
  email?: string;
}

/**
 * Verifies an ID token's RS256 signature against OpenAI's JWKS, then its issuer, audience
 * (the issued client ID), expiry and, when given, the nonce saved for this attempt.
 */
export async function verifyIdToken(
  idToken: string,
  options: {
    clientId: string;
    nonce?: string;
    resolveKey: (kid: string) => Promise<crypto.KeyObject>;
    now: () => number;
  },
): Promise<VerifiedIdentity> {
  const decoded = jwt.decode(idToken, { complete: true });
  const kid = decoded?.header?.kid;
  if (!decoded || decoded.header.alg !== 'RS256' || typeof kid !== 'string') {
    throw new ChatGPTError('id_token_invalid');
  }
  const key = await options.resolveKey(kid);
  let payload: JwtPayload;
  try {
    const verified = jwt.verify(idToken, key, {
      algorithms: ['RS256'],
      issuer: CHATGPT_ISSUER,
      audience: options.clientId,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      clockTimestamp: Math.floor(options.now() / 1000),
    });
    if (typeof verified === 'string') {
      throw new Error('Unexpected string payload');
    }
    payload = verified;
  } catch {
    throw new ChatGPTError('id_token_invalid');
  }
  if (typeof payload.exp !== 'number' || typeof payload.sub !== 'string' || !payload.sub) {
    throw new ChatGPTError('id_token_invalid');
  }
  if (options.nonce !== undefined) {
    const nonce = typeof payload.nonce === 'string' ? payload.nonce : '';
    if (!safeEqual(nonce, options.nonce)) {
      throw new ChatGPTError('id_token_invalid');
    }
  }
  return {
    subject: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : undefined,
  };
}
