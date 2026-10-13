import type {
  TChatGPTModel,
  TChatGPTConnectionStatus,
  TChatGPTLoginStartResponse,
  TChatGPTConnectionErrorCode,
} from 'librechat-data-provider';
import type { ChatGPTCredentialRecord, ChatGPTCredentialStore, ChatGPTTokenSet } from './store';
import type { FetchLike, TokenResponse, VerifiedIdentity } from './oauth';
import {
  CHATGPT_ISSUER,
  PLAN_USAGE_SCOPE,
  CHATGPT_MODELS_URL,
  DYNAMIC_CLIENT_ID,
  CHATGPT_CALLBACK_HOST,
  CHATGPT_CALLBACK_PATH,
  UNUSABLE_REFRESH_CODES,
} from './constants';
import {
  safeEqual,
  randomToken,
  requestToken,
  pkceChallenge,
  verifyIdToken,
  isIssuedClientId,
  buildAuthorizeUrl,
  createJwksResolver,
  revokeRefreshToken,
} from './oauth';
import { ChatGPTError, isChatGPTError } from './errors';

export interface ChatGPTLogger {
  warn: (message: string, meta?: Record<string, unknown>) => void;
}

export interface ChatGPTConnectionDeps {
  store: ChatGPTCredentialStore;
  /** Port the running ChatGit server listens on; the loopback callback reuses it. */
  port: number;
  /**
   * Gate evaluated on every call. Hosts return `true` only for explicit local mode
   * (`CHATGIT_LOCAL_MODE=true`) and never in preview mode.
   */
  isEnabled: () => boolean;
  /** Resolves the internal local owner's user id; only that exact user may connect or use it. */
  getLocalOwnerId: () => Promise<string | null | undefined> | string | null | undefined;
  fetch?: FetchLike;
  now?: () => number;
  logger?: ChatGPTLogger;
  /** Lifetime of a pending authorization attempt. */
  pendingTtlMs?: number;
  /** Refresh when the access token has less than this much life left. */
  refreshSkewMs?: number;
  /** Pause after `subscription_sharing_usage_limit_exceeded` before plan requests resume. */
  usageLimitPauseMs?: number;
  modelsCacheTtlMs?: number;
  /** Base delay between revocation retries after network or 5xx failures. */
  revokeRetryDelayMs?: number;
}

export interface ChatGPTCallbackQuery {
  state?: unknown;
  code?: unknown;
  error?: unknown;
  client_id?: unknown;
}

export type ChatGPTCallbackResult =
  | { ok: true }
  | { ok: false; error: { code: TChatGPTConnectionErrorCode } };

export interface ChatGPTInferenceError {
  status: number;
  code?: string;
}

/** Surface consumed by the custom endpoint integration (initialization and model listing). */
export interface ChatGPTInferenceAuth {
  getAccessToken(userId: string): Promise<string>;
  listModels(userId: string): Promise<TChatGPTModel[]>;
  reportInferenceError(error: ChatGPTInferenceError): void;
}

export interface ChatGPTConnection extends ChatGPTInferenceAuth {
  isEnabled(): boolean;
  isOwner(userId: string | undefined): Promise<boolean>;
  getStatus(): Promise<TChatGPTConnectionStatus>;
  startLogin(userId: string): Promise<TChatGPTLoginStartResponse>;
  cancelLogin(): void;
  handleCallback(query: ChatGPTCallbackQuery): Promise<ChatGPTCallbackResult>;
  disconnect(): Promise<TChatGPTConnectionStatus>;
}

interface PendingAttempt {
  id: string;
  state: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
  clientId: string;
  isNewRegistration: boolean;
  expectedSubject?: string;
  createdAt: number;
  epoch: number;
}

const DEFAULT_PENDING_TTL_MS = 10 * 60 * 1000;
const DEFAULT_REFRESH_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_USAGE_LIMIT_PAUSE_MS = 60 * 1000;
const DEFAULT_MODELS_CACHE_TTL_MS = 5 * 60 * 1000;
const REVOKE_ATTEMPTS = 3;
const DEFAULT_REVOKE_RETRY_DELAY_MS = 400;

/** Documented Responses codes mapped to the connection's safe codes. */
const RESPONSES_ERROR_CODES: Record<string, TChatGPTConnectionErrorCode> = {
  subscription_sharing_usage_limit_exceeded: 'usage_limit_exceeded',
  subscription_sharing_usage_unavailable: 'usage_unavailable',
  subscription_sharing_user_unavailable: 'usage_unavailable',
  subscription_sharing_user_not_eligible: 'user_not_eligible',
  subscription_sharing_unsupported_capability: 'unsupported_capability',
  subscription_sharing_route_not_supported: 'route_not_supported',
  subscription_sharing_invalid_user: 'reauth_required',
  chatpass_v2_scope_not_authorized: 'plan_usage_not_granted',
  chatpass_v2_invalid_authorization_context: 'plan_usage_not_granted',
};

export function mapResponsesErrorCode(
  status: number,
  code: string | undefined,
): TChatGPTConnectionErrorCode {
  if (code && RESPONSES_ERROR_CODES[code]) {
    return RESPONSES_ERROR_CODES[code];
  }
  if (status === 401) {
    return 'reauth_required';
  }
  if (status === 403) {
    return 'forbidden';
  }
  if (status === 503) {
    return 'usage_unavailable';
  }
  return 'request_failed';
}

function hasPlanScope(scopes: string[] | undefined): boolean {
  return Array.isArray(scopes) && scopes.includes(PLAN_USAGE_SCOPE);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One owner-only Sign in with ChatGPT connection for a local ChatGit host.
 *
 * Invariants:
 * - Credentials are written only after state, client, ID token (signature, issuer,
 *   audience, expiry, nonce), subject binding and the plan-usage scope all validate.
 * - All credential writes run through one queue; refresh is single-flight and re-reads
 *   the record inside the queue so a rotated refresh token is never reused.
 * - `disconnect` bumps an epoch before queuing its write, so an in-flight callback or
 *   refresh observes the bump and discards (and revokes) what it obtained.
 */
export function createChatGPTConnection(deps: ChatGPTConnectionDeps): ChatGPTConnection {
  const fetchFn: FetchLike = deps.fetch ?? ((input, init) => fetch(input, init));
  const now = deps.now ?? Date.now;
  const pendingTtlMs = deps.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS;
  const refreshSkewMs = deps.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
  const usageLimitPauseMs = deps.usageLimitPauseMs ?? DEFAULT_USAGE_LIMIT_PAUSE_MS;
  const modelsCacheTtlMs = deps.modelsCacheTtlMs ?? DEFAULT_MODELS_CACHE_TTL_MS;
  const revokeRetryDelayMs = deps.revokeRetryDelayMs ?? DEFAULT_REVOKE_RETRY_DELAY_MS;
  const resolveKey = createJwksResolver(fetchFn, now);
  const { store } = deps;

  let epoch = 0;
  let pending: PendingAttempt | null = null;
  let activeAttemptId: string | null = null;
  let lastError: TChatGPTConnectionErrorCode | undefined;
  let revocation: TChatGPTConnectionStatus['revocation'];
  let usagePausedUntil = 0;
  let queue: Promise<unknown> = Promise.resolve();
  let refreshing: Promise<string> | null = null;
  let modelsCache: { epoch: number; at: number; models: TChatGPTModel[] } | null = null;

  /** Serializes every credential read-modify-write. */
  function serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  }

  async function readRecord(): Promise<ChatGPTCredentialRecord> {
    try {
      return await store.read();
    } catch {
      deps.logger?.warn('[chatgpt] Credential record could not be read');
      throw new ChatGPTError('storage_error', 500);
    }
  }

  async function writeRecord(record: ChatGPTCredentialRecord): Promise<void> {
    try {
      await store.write(record);
    } catch {
      deps.logger?.warn('[chatgpt] Credential record could not be written');
      throw new ChatGPTError('storage_error', 500);
    }
  }

  function assertEnabled(): void {
    if (!deps.isEnabled()) {
      throw new ChatGPTError('disabled', 404);
    }
  }

  async function isOwner(userId: string | undefined): Promise<boolean> {
    if (!userId) {
      return false;
    }
    const ownerId = await deps.getLocalOwnerId();
    return typeof ownerId === 'string' && ownerId !== '' && ownerId === String(userId);
  }

  async function assertOwner(userId: string): Promise<void> {
    assertEnabled();
    if (!(await isOwner(userId))) {
      throw new ChatGPTError('forbidden', 403);
    }
  }

  function currentPending(): PendingAttempt | null {
    if (pending && now() - pending.createdAt > pendingTtlMs) {
      pending = null;
    }
    return pending;
  }

  function revokeQuietly(clientId: string, refreshToken: string | undefined): void {
    if (!refreshToken) {
      return;
    }
    void revokeRefreshToken(fetchFn, clientId, refreshToken);
  }

  function toTokenSet(response: TokenResponse, idToken: string, scopes: string[]): ChatGPTTokenSet {
    const savedAt = now();
    return {
      idToken,
      accessToken: response.accessToken,
      refreshToken: response.refreshToken ?? '',
      tokenType: response.tokenType,
      scopes,
      expiresAt: savedAt + response.expiresIn * 1000,
      earliestRefreshAt: response.earliestRefreshAt,
      savedAt: new Date(savedAt).toISOString(),
    };
  }

  async function getStatus(): Promise<TChatGPTConnectionStatus> {
    if (!deps.isEnabled()) {
      return { enabled: false, state: 'disabled', planUsage: false };
    }
    const record = await readRecord();
    const tokens = record.tokens;
    const planUsage = tokens != null && hasPlanScope(tokens.scopes);
    let state: TChatGPTConnectionStatus['state'] = 'disconnected';
    if (currentPending()) {
      state = 'pending';
    } else if (tokens && planUsage) {
      state = 'connected';
    } else if (record.registration && lastError === 'reauth_required') {
      state = 'reauth_required';
    }
    const status: TChatGPTConnectionStatus = { enabled: true, state, planUsage };
    if (record.registration?.email && (tokens || state === 'reauth_required')) {
      status.email = record.registration.email;
    }
    if (lastError) {
      status.lastError = lastError;
    }
    if (revocation && !tokens) {
      status.revocation = revocation;
    }
    return status;
  }

  async function startLogin(userId: string): Promise<TChatGPTLoginStartResponse> {
    await assertOwner(userId);
    if (!Number.isInteger(deps.port) || deps.port <= 0 || deps.port > 65535) {
      throw new ChatGPTError('disabled', 404);
    }
    const [record, hostId] = await Promise.all([readRecord(), store.getHostId()]);
    const registration = record.registration;
    const clientId = registration?.clientId ?? DYNAMIC_CLIENT_ID;
    const verifier = randomToken(48);
    const attempt: PendingAttempt = {
      id: randomToken(16),
      state: randomToken(32),
      nonce: randomToken(32),
      verifier,
      redirectUri: `http://${CHATGPT_CALLBACK_HOST}:${deps.port}${CHATGPT_CALLBACK_PATH}`,
      clientId,
      isNewRegistration: registration == null,
      expectedSubject: registration?.subject,
      createdAt: now(),
      epoch,
    };
    /** A new attempt supersedes any earlier one; its state can no longer complete. */
    pending = attempt;
    activeAttemptId = attempt.id;
    lastError = undefined;
    revocation = undefined;
    const authorizationUrl = buildAuthorizeUrl({
      clientId,
      hostId,
      redirectUri: attempt.redirectUri,
      state: attempt.state,
      nonce: attempt.nonce,
      codeChallenge: pkceChallenge(verifier),
      loginHint: registration?.email,
    });
    return {
      authorizationUrl,
      expiresAt: new Date(attempt.createdAt + pendingTtlMs).toISOString(),
    };
  }

  function cancelLogin(): void {
    pending = null;
    activeAttemptId = null;
  }

  function fail(
    code: TChatGPTConnectionErrorCode,
    attempt?: PendingAttempt,
  ): ChatGPTCallbackResult {
    if (!attempt || activeAttemptId === attempt.id) {
      lastError = code;
    }
    if (attempt && activeAttemptId === attempt.id) {
      activeAttemptId = null;
    }
    return { ok: false, error: { code } };
  }

  async function completeAttempt(
    attempt: PendingAttempt,
    query: ChatGPTCallbackQuery,
  ): Promise<ChatGPTCallbackResult> {
    if (typeof query.error === 'string' && query.error !== '') {
      return fail(query.error === 'access_denied' ? 'access_denied' : 'oauth_error', attempt);
    }
    if (typeof query.code !== 'string' || query.code === '') {
      return fail('oauth_error', attempt);
    }

    const callbackClientId = query.client_id;
    let clientId = attempt.clientId;
    if (attempt.isNewRegistration) {
      if (!isIssuedClientId(callbackClientId)) {
        return fail('registration_incomplete', attempt);
      }
      clientId = callbackClientId;
    } else if (callbackClientId != null && callbackClientId !== attempt.clientId) {
      return fail('client_mismatch', attempt);
    }

    const exchange = await requestToken(fetchFn, {
      grant_type: 'authorization_code',
      client_id: clientId,
      code: query.code,
      code_verifier: attempt.verifier,
      redirect_uri: attempt.redirectUri,
    });
    if (!exchange.ok) {
      if (exchange.code === 'invalid_grant') {
        return fail('invalid_grant', attempt);
      }
      if (exchange.code === 'invalid_client') {
        return fail('invalid_client', attempt);
      }
      return fail('token_exchange_failed', attempt);
    }
    const tokens = exchange.value;
    if (!tokens.idToken || !tokens.refreshToken) {
      revokeQuietly(clientId, tokens.refreshToken);
      return fail('token_exchange_failed', attempt);
    }

    let identity: VerifiedIdentity;
    try {
      identity = await verifyIdToken(tokens.idToken, {
        clientId,
        nonce: attempt.nonce,
        resolveKey,
        now,
      });
    } catch (error) {
      revokeQuietly(clientId, tokens.refreshToken);
      return fail(isChatGPTError(error) ? error.code : 'id_token_invalid', attempt);
    }
    if (attempt.expectedSubject && identity.subject !== attempt.expectedSubject) {
      revokeQuietly(clientId, tokens.refreshToken);
      return fail('subject_mismatch', attempt);
    }
    /** Granted scopes come from the token response, not the callback query. */
    const scopes = tokens.scopes ?? [];
    if (!hasPlanScope(scopes)) {
      revokeQuietly(clientId, tokens.refreshToken);
      return fail('plan_usage_not_granted', attempt);
    }

    return serialized(async () => {
      if (epoch !== attempt.epoch || activeAttemptId !== attempt.id) {
        revokeQuietly(clientId, tokens.refreshToken);
        return fail('cancelled', attempt);
      }
      const record = await readRecord();
      if (
        record.registration &&
        (record.registration.clientId !== clientId ||
          record.registration.subject !== identity.subject)
      ) {
        /** Another registration appeared while this attempt was open; never merge them. */
        revokeQuietly(clientId, tokens.refreshToken);
        return fail('client_mismatch', attempt);
      }
      await writeRecord({
        version: 1,
        registration: {
          issuer: CHATGPT_ISSUER,
          subject: identity.subject,
          clientId,
          email: identity.email,
        },
        tokens: toTokenSet(tokens, tokens.idToken ?? '', scopes),
      });
      activeAttemptId = null;
      lastError = undefined;
      revocation = undefined;
      usagePausedUntil = 0;
      modelsCache = null;
      return { ok: true } as const;
    });
  }

  async function handleCallback(query: ChatGPTCallbackQuery): Promise<ChatGPTCallbackResult> {
    if (!deps.isEnabled()) {
      return { ok: false, error: { code: 'disabled' } };
    }
    const state = typeof query.state === 'string' ? query.state : '';
    const attempt = pending;
    /** Forged or replayed state never touches the legitimate pending attempt or status. */
    if (!attempt || state === '' || !safeEqual(state, attempt.state)) {
      return { ok: false, error: { code: 'invalid_state' } };
    }
    /** One-time consumption happens before any await. */
    pending = null;
    if (now() - attempt.createdAt > pendingTtlMs) {
      return fail('state_expired', attempt);
    }
    try {
      return await completeAttempt(attempt, query);
    } catch (error) {
      return fail(isChatGPTError(error) ? error.code : 'token_exchange_failed', attempt);
    }
  }

  async function revokeWithRetry(clientId: string, refreshToken: string): Promise<boolean> {
    for (let attempt = 0; attempt < REVOKE_ATTEMPTS; attempt++) {
      if (await revokeRefreshToken(fetchFn, clientId, refreshToken)) {
        return true;
      }
      if (attempt < REVOKE_ATTEMPTS - 1) {
        await sleep(revokeRetryDelayMs * (attempt + 1));
      }
    }
    return false;
  }

  async function disconnect(): Promise<TChatGPTConnectionStatus> {
    assertEnabled();
    /** Synchronous bump: anything already in flight can no longer write. */
    epoch += 1;
    pending = null;
    activeAttemptId = null;
    modelsCache = null;
    await serialized(async () => {
      const record = await readRecord();
      const tokens = record.tokens;
      if (!tokens) {
        return;
      }
      const confirmed =
        record.registration != null && tokens.refreshToken
          ? await revokeWithRetry(record.registration.clientId, tokens.refreshToken)
          : false;
      /** Keep the account/client mapping for a later sign-in; clear every token. */
      await writeRecord({ version: 1, registration: record.registration, tokens: null });
      revocation = confirmed ? 'confirmed' : 'unconfirmed';
    });
    lastError = undefined;
    usagePausedUntil = 0;
    return getStatus();
  }

  function needsRefresh(tokens: ChatGPTTokenSet): boolean {
    const remaining = tokens.expiresAt - now();
    if (remaining <= 0) {
      return true;
    }
    if (tokens.earliestRefreshAt != null && now() < tokens.earliestRefreshAt) {
      return false;
    }
    return remaining <= refreshSkewMs;
  }

  async function refreshTokens(): Promise<string> {
    const startEpoch = epoch;
    return serialized(async () => {
      const record = await readRecord();
      const { registration, tokens } = record;
      if (!registration || !tokens) {
        throw new ChatGPTError('not_connected', 401);
      }
      /** Another caller already rotated the token while this one waited. */
      if (!needsRefresh(tokens)) {
        return tokens.accessToken;
      }
      if (epoch !== startEpoch) {
        throw new ChatGPTError('not_connected', 401);
      }
      const result = await requestToken(fetchFn, {
        grant_type: 'refresh_token',
        client_id: registration.clientId,
        refresh_token: tokens.refreshToken,
      });
      if (!result.ok) {
        if (result.code && UNUSABLE_REFRESH_CODES.has(result.code)) {
          if (epoch === startEpoch) {
            await writeRecord({ version: 1, registration, tokens: null });
            lastError = 'reauth_required';
            modelsCache = null;
          }
          throw new ChatGPTError('reauth_required', 401);
        }
        if (result.code === 'invalid_client') {
          lastError = 'invalid_client';
          throw new ChatGPTError('invalid_client', 401);
        }
        /** Temporary failure: keep the credentials for a later retry. */
        throw new ChatGPTError('refresh_unavailable', 503);
      }
      const next = result.value;
      if (!next.refreshToken) {
        throw new ChatGPTError('refresh_unavailable', 503);
      }
      if (epoch !== startEpoch) {
        revokeQuietly(registration.clientId, next.refreshToken);
        throw new ChatGPTError('not_connected', 401);
      }
      let idToken = tokens.idToken;
      if (next.idToken) {
        try {
          const identity = await verifyIdToken(next.idToken, {
            clientId: registration.clientId,
            resolveKey,
            now,
          });
          if (identity.subject === registration.subject) {
            idToken = next.idToken;
          }
        } catch {
          /** The hint is optional; an unverifiable replacement is simply not retained. */
        }
      }
      const scopes = next.scopes ?? tokens.scopes;
      await writeRecord({
        version: 1,
        registration,
        tokens: toTokenSet(next, idToken, scopes),
      });
      if (!hasPlanScope(scopes)) {
        lastError = 'plan_usage_not_granted';
        throw new ChatGPTError('plan_usage_not_granted', 403);
      }
      return next.accessToken;
    });
  }

  async function getAccessToken(userId: string): Promise<string> {
    await assertOwner(userId);
    if (usagePausedUntil > now()) {
      throw new ChatGPTError('usage_limit_exceeded', 429);
    }
    const record = await readRecord();
    const tokens = record.tokens;
    if (!record.registration || !tokens) {
      throw new ChatGPTError(
        lastError === 'reauth_required' ? 'reauth_required' : 'not_connected',
        401,
      );
    }
    if (!hasPlanScope(tokens.scopes)) {
      throw new ChatGPTError('plan_usage_not_granted', 403);
    }
    if (!needsRefresh(tokens)) {
      return tokens.accessToken;
    }
    refreshing ??= refreshTokens().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  async function listModels(userId: string): Promise<TChatGPTModel[]> {
    await assertOwner(userId);
    const cacheEpoch = epoch;
    if (
      modelsCache &&
      modelsCache.epoch === cacheEpoch &&
      now() - modelsCache.at < modelsCacheTtlMs
    ) {
      return modelsCache.models;
    }
    const accessToken = await getAccessToken(userId);
    let response: Response;
    try {
      response = await fetchFn(CHATGPT_MODELS_URL, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new ChatGPTError('network_error', 503);
    }
    if (!response.ok) {
      throw new ChatGPTError('models_unavailable', response.status === 401 ? 401 : 502);
    }
    let body: { models?: unknown };
    try {
      body = (await response.json()) as { models?: unknown };
    } catch {
      throw new ChatGPTError('models_unavailable', 502);
    }
    if (!Array.isArray(body?.models)) {
      throw new ChatGPTError('models_unavailable', 502);
    }
    const models: TChatGPTModel[] = [];
    for (const item of body.models as Array<Record<string, unknown>>) {
      if (item?.visibility !== 'list' || typeof item.slug !== 'string' || item.slug === '') {
        continue;
      }
      models.push({
        slug: item.slug,
        displayName: typeof item.display_name === 'string' ? item.display_name : item.slug,
      });
    }
    if (epoch === cacheEpoch) {
      modelsCache = { epoch: cacheEpoch, at: now(), models };
    }
    return models;
  }

  function reportInferenceError({ status, code }: ChatGPTInferenceError): void {
    const mapped = mapResponsesErrorCode(status, code);
    lastError = mapped;
    if (mapped === 'usage_limit_exceeded') {
      usagePausedUntil = now() + usageLimitPauseMs;
    }
  }

  return {
    isEnabled: () => deps.isEnabled(),
    isOwner,
    getStatus,
    startLogin,
    cancelLogin,
    handleCallback,
    disconnect,
    getAccessToken,
    listModels,
    reportInferenceError,
  };
}
