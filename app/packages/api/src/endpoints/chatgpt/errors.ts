import type { TChatGPTConnectionErrorCode } from 'librechat-data-provider';

/** Coded failure whose `code` is safe to show; `message` never contains tokens or payloads. */
export class ChatGPTError extends Error {
  readonly code: TChatGPTConnectionErrorCode;
  readonly status: number;

  constructor(code: TChatGPTConnectionErrorCode, status = 400) {
    super(`ChatGPT connection error: ${code}`);
    this.name = 'ChatGPTError';
    this.code = code;
    this.status = status;
  }
}

export function isChatGPTError(error: unknown): error is ChatGPTError {
  return error instanceof ChatGPTError;
}

/** HTTP status used when a coded failure crosses the HTTP or provider boundary. */
export const CHATGPT_ERROR_STATUS: Partial<Record<TChatGPTConnectionErrorCode, number>> = {
  disabled: 404,
  forbidden: 403,
  not_connected: 401,
  reauth_required: 401,
  plan_usage_not_granted: 403,
  invalid_client: 401,
  refresh_unavailable: 503,
  network_error: 503,
  storage_error: 500,
  models_unavailable: 502,
  usage_limit_exceeded: 429,
  usage_unavailable: 503,
  user_not_eligible: 403,
  unsupported_capability: 400,
  route_not_supported: 403,
  request_failed: 502,
};

export function statusForCode(code: TChatGPTConnectionErrorCode, fallback = 400): number {
  return CHATGPT_ERROR_STATUS[code] ?? fallback;
}
