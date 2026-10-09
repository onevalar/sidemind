/**
 * Fixed values from OpenAI's Sign in with ChatGPT open-source flow. Nothing here is
 * configurable on purpose: the authorization, token, JWKS and inference hosts are the
 * official production endpoints, and this flow must never point at another host.
 */
export const CHATGPT_ISSUER = 'https://auth.openai.com';
export const CHATGPT_AUTHORIZE_URL = 'https://auth.openai.com/api/accounts/authorize';
export const CHATGPT_TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token';
export const CHATGPT_REVOKE_URL = 'https://auth.openai.com/api/accounts/oauth/revoke';
export const CHATGPT_JWKS_URL = 'https://auth.openai.com/.well-known/jwks.json';

export const CHATGPT_RESOURCE = 'https://api.openai.com/v1';
export const CHATGPT_API_BASE_URL = 'https://api.openai.com/v1';
export const CHATGPT_RESPONSES_URL: string = `${CHATGPT_API_BASE_URL}/responses`;
export const CHATGPT_MODELS_URL: string = `${CHATGPT_API_BASE_URL}/models`;
export const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage';

/** First-time registration entrypoint. Never persisted or used for token exchange. */
export const DYNAMIC_CLIENT_ID = 'dynamic_agent_client';
export const AGENT_NAME_HINT = 'ChatGit';

export const PLAN_USAGE_SCOPE = 'chatgpt.tokens.use.direct';
export const REQUESTED_SCOPES: readonly string[] = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'resource.invoke',
  PLAN_USAGE_SCOPE,
] as const;

/** Fixed callback path; only the loopback port may vary between attempts. */
export const CHATGPT_CALLBACK_PATH = '/api/chatgpt/callback';
export const CHATGPT_CALLBACK_HOST = '127.0.0.1';

/** Responses fields the preview rejects for ChatGPT plan usage. */
export const UNSUPPORTED_RESPONSES_FIELDS = [
  'background',
  'conversation',
  'max_output_tokens',
  'max_tool_calls',
  'metadata',
  'moderation',
  'multi_agent',
  'prompt',
  'prompt_cache_retention',
  'safety_identifier',
  'temperature',
  'top_logprobs',
  'top_p',
  'truncation',
  'user',
  'previous_response_id',
] as const;

/** Refresh codes after which the stored refresh token can never be used again. */
export const UNUSABLE_REFRESH_CODES: ReadonlySet<string> = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
]);
