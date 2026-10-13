import type { TChatGPTConnectionErrorCode } from 'librechat-data-provider';
import type { ChatGPTInferenceError } from './connection';
import {
  CHATGPT_RESPONSES_URL,
  CHATGPT_USAGE_URL,
  UNSUPPORTED_RESPONSES_FIELDS,
} from './constants';
import { isChatGPTError, statusForCode } from './errors';
import { mapResponsesErrorCode } from './connection';

type FetchInput = string | URL | Request;
type Fetch = (input: FetchInput, init?: RequestInit) => Promise<Response>;

export interface ChatGPTFetchDeps {
  /** Returns a valid access token, refreshing when needed; throws `ChatGPTError`. */
  getAccessToken: () => Promise<string>;
  reportError: (error: ChatGPTInferenceError) => void;
  fetch?: Fetch;
}

/** Headers that would tie the OAuth token to API-platform billing context. */
const STRIPPED_HEADERS = ['openai-organization', 'openai-project'];
const MAX_ERROR_BODY_BYTES = 64 * 1024;

const SAFE_MESSAGES: Partial<Record<TChatGPTConnectionErrorCode, string>> = {
  not_connected: 'ChatGPT is not connected. Continue with ChatGPT in Settings.',
  reauth_required: 'Your ChatGPT sign-in expired or was revoked. Continue with ChatGPT again.',
  plan_usage_not_granted: 'ChatGPT plan usage was not authorized for ChatGit.',
  usage_limit_exceeded: `ChatGPT plan usage limit reached for ChatGit. Review usage at ${CHATGPT_USAGE_URL}.`,
  usage_unavailable: 'ChatGPT plan usage is temporarily unavailable. Try again later.',
  user_not_eligible: 'ChatGPT plan usage is unavailable for this account or workspace.',
  unsupported_capability: 'This request uses a capability ChatGPT plan usage does not support.',
  route_not_supported: 'This request type is not supported with ChatGPT plan usage.',
  refresh_unavailable: 'ChatGPT sign-in could not be renewed right now. Try again later.',
  network_error: 'ChatGPT could not be reached. Try again later.',
  forbidden: 'ChatGPT plan usage is not available to this ChatGit user.',
  disabled: 'ChatGPT plan usage is not enabled on this ChatGit host.',
};

function safeMessage(code: TChatGPTConnectionErrorCode, requestId?: string | null): string {
  const base = SAFE_MESSAGES[code] ?? 'The ChatGPT request failed.';
  return requestId ? `${base} (request ${requestId})` : base;
}

function errorPayload(
  code: TChatGPTConnectionErrorCode,
  upstreamCode?: string,
  _param?: unknown,
  requestId?: string | null,
) {
  return {
    error: {
      type: 'chatgpt_plan_error',
      // Only documented provider codes may cross this boundary; arbitrary error fields
      // can echo submitted content or credentials, even when `message` is sanitized.
      code:
        upstreamCode && mapResponsesErrorCode(200, upstreamCode) !== 'request_failed'
          ? upstreamCode
          : code,
      message: safeMessage(code, requestId),
    },
  };
}

function safeRequestId(response: Response): string | null {
  const id = response.headers.get('x-request-id');
  return id && /^req_[A-Za-z0-9_-]{1,128}$/.test(id) ? id : null;
}

function errorResponse(
  status: number,
  code: TChatGPTConnectionErrorCode,
  upstreamCode?: string,
  param?: unknown,
  requestId?: string | null,
): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (requestId) {
    headers['x-request-id'] = requestId;
  }
  return new Response(JSON.stringify(errorPayload(code, upstreamCode, param, requestId)), {
    status,
    headers,
  });
}

function toHref(input: FetchInput): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

/**
 * Applies the preview's Responses requirements without changing conversation context:
 * forces `store: false` and `stream: true`, drops unsupported top-level fields and
 * `previous_response_id`, wraps string input as one user item, and renames explicit
 * `system` message items to `developer` in place. Item order, ids and content are kept.
 */
export function sanitizeResponsesBody(body: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...body };
  for (const field of UNSUPPORTED_RESPONSES_FIELDS) {
    delete next[field];
  }
  next.store = false;
  next.stream = true;
  if (typeof next.input === 'string') {
    next.input = [{ role: 'user', content: next.input }];
  } else if (Array.isArray(next.input)) {
    next.input = next.input.map((item: unknown) => {
      if (
        item != null &&
        typeof item === 'object' &&
        (item as { role?: unknown }).role === 'system' &&
        ((item as { type?: unknown }).type == null ||
          (item as { type?: unknown }).type === 'message')
      ) {
        return { ...(item as Record<string, unknown>), role: 'developer' };
      }
      return item;
    });
  }
  return next;
}

interface SSEEvent {
  raw: string;
  data?: Record<string, unknown>;
}

function parseBlock(raw: string): SSEEvent {
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(line.startsWith('data: ') ? 6 : 5));
    }
  }
  if (dataLines.length === 0) {
    return { raw };
  }
  try {
    const data = JSON.parse(dataLines.join('\n')) as unknown;
    return {
      raw,
      data:
        data != null && typeof data === 'object' ? (data as Record<string, unknown>) : undefined,
    };
  } catch {
    return { raw };
  }
}

interface StreamFailure {
  upstreamCode?: string;
  param?: unknown;
}

/** Reads `response.failed` / `error` events into a code without retaining upstream text. */
function readFailure(data: Record<string, unknown>): StreamFailure | null {
  if (data.type === 'response.incomplete') {
    return {};
  }
  if (data.type === 'response.failed') {
    const response = data.response as { error?: { code?: unknown; param?: unknown } } | undefined;
    const code = response?.error?.code;
    return {
      upstreamCode: typeof code === 'string' ? code : undefined,
      param: response?.error?.param,
    };
  }
  if (data.type === 'error') {
    const nested = data.error as { code?: unknown; param?: unknown } | undefined;
    const code = nested?.code ?? data.code;
    return {
      upstreamCode: typeof code === 'string' ? code : undefined,
      param: nested?.param ?? data.param,
    };
  }
  return null;
}

const TERMINAL_TYPES = new Set(['response.completed']);

function sseError(code: TChatGPTConnectionErrorCode, failure?: StreamFailure): string {
  /** A top-level `error` makes the OpenAI SDK raise instead of ending with partial text. */
  return `event: error\ndata: ${JSON.stringify(
    errorPayload(code, failure?.upstreamCode, failure?.param),
  )}\n\n`;
}

/**
 * Passes Responses SSE through unchanged, except that `response.failed`/`error` events
 * become sanitized SDK-visible errors and a stream that ends without a terminal event
 * raises instead of looking complete.
 */
function guardStream(
  body: ReadableStream<Uint8Array>,
  reportError: ChatGPTFetchDeps['reportError'],
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  let finished = false;

  const handleBlock = (
    raw: string,
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void => {
    if (finished) {
      return;
    }
    const event = parseBlock(raw);
    const failure = event.data ? readFailure(event.data) : null;
    if (failure) {
      finished = true;
      const code = mapResponsesErrorCode(200, failure.upstreamCode);
      reportError({ status: 200, code: failure.upstreamCode });
      controller.enqueue(encoder.encode(sseError(code, failure)));
      return;
    }
    if (typeof event.data?.type === 'string' && TERMINAL_TYPES.has(event.data.type)) {
      finished = true;
    }
    controller.enqueue(encoder.encode(`${raw}\n\n`));
  };

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        // Normalize the accumulated buffer: CR and LF can arrive in separate chunks.
        buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, '\n');
        let index = buffer.indexOf('\n\n');
        while (index !== -1) {
          const raw = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          if (raw.trim() !== '') {
            handleBlock(raw, controller);
          }
          index = buffer.indexOf('\n\n');
        }
      },
      flush(controller) {
        buffer = (buffer + decoder.decode()).replace(/\r\n/g, '\n');
        if (buffer.trim() !== '') {
          handleBlock(buffer, controller);
        }
        if (!finished) {
          reportError({ status: 502 });
          controller.enqueue(encoder.encode(sseError('request_failed')));
        }
      },
    }),
  );
}

/**
 * Serves a caller that asked for a non-streaming response from the mandatory stream:
 * the terminal event carries the complete Response object.
 */
async function collectStream(
  response: Response,
  reportError: ChatGPTFetchDeps['reportError'],
): Promise<Response> {
  const text = (await response.text()).replace(/\r\n/g, '\n');
  const requestId = safeRequestId(response);
  for (const raw of text.split('\n\n')) {
    if (raw.trim() === '') {
      continue;
    }
    const { data } = parseBlock(raw);
    if (!data) {
      continue;
    }
    const failure = readFailure(data);
    if (failure) {
      const code = mapResponsesErrorCode(200, failure.upstreamCode);
      reportError({ status: 200, code: failure.upstreamCode });
      return errorResponse(
        statusForCode(code, 502),
        code,
        failure.upstreamCode,
        failure.param,
        requestId,
      );
    }
    if (typeof data.type === 'string' && TERMINAL_TYPES.has(data.type) && data.response) {
      return new Response(JSON.stringify(data.response), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          ...(requestId ? { 'x-request-id': requestId } : {}),
        },
      });
    }
  }
  reportError({ status: 502 });
  return errorResponse(502, 'request_failed', undefined, undefined, requestId);
}

async function readErrorCode(response: Response): Promise<{ code?: string; param?: unknown }> {
  try {
    const text = await response.text();
    if (text.length > MAX_ERROR_BODY_BYTES) {
      return {};
    }
    const body = JSON.parse(text) as { error?: { code?: unknown; param?: unknown } };
    const code = body?.error?.code;
    return { code: typeof code === 'string' ? code : undefined, param: body?.error?.param };
  } catch {
    return {};
  }
}

/**
 * Final request boundary for ChatGPT plan usage. Every SDK request passes here, so no
 * upstream layer can add an unsupported field, an API-key credential, or another route:
 * only `POST https://api.openai.com/v1/responses` is forwarded, with a fresh OAuth token.
 * Failures are reported, never retried with another billing path.
 */
export function createChatGPTFetch(deps: ChatGPTFetchDeps): Fetch {
  const baseFetch: Fetch = deps.fetch ?? ((input, init) => fetch(input, init));
  return async function chatgptFetch(input, init = {}) {
    const href = toHref(input).split('?')[0];
    const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (href !== CHATGPT_RESPONSES_URL || method !== 'POST') {
      return errorResponse(403, 'route_not_supported');
    }
    if (typeof init.body !== 'string') {
      return errorResponse(400, 'unsupported_capability');
    }
    let parsed: Record<string, unknown>;
    try {
      const body = JSON.parse(init.body) as unknown;
      if (body == null || typeof body !== 'object' || Array.isArray(body)) {
        throw new Error('Invalid body');
      }
      parsed = body as Record<string, unknown>;
    } catch {
      return errorResponse(400, 'unsupported_capability');
    }
    const callerWantsStream = parsed.stream === true;
    const body = sanitizeResponsesBody(parsed);

    let accessToken: string;
    try {
      accessToken = await deps.getAccessToken();
    } catch (error) {
      const code = isChatGPTError(error) ? error.code : 'request_failed';
      return errorResponse(statusForCode(code, 500), code);
    }

    const headers = new Headers(init.headers);
    for (const name of STRIPPED_HEADERS) {
      headers.delete(name);
    }
    headers.delete('api-key');
    headers.set('authorization', `Bearer ${accessToken}`);
    headers.set('content-type', 'application/json');
    headers.set('accept', 'text/event-stream');

    const response = await baseFetch(CHATGPT_RESPONSES_URL, {
      ...init,
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      redirect: 'error',
    });

    const requestId = safeRequestId(response);
    if (!response.ok) {
      const { code: upstreamCode, param } = await readErrorCode(response);
      deps.reportError({ status: response.status, code: upstreamCode });
      const code = mapResponsesErrorCode(response.status, upstreamCode);
      return errorResponse(response.status, code, upstreamCode, param, requestId);
    }
    if (!callerWantsStream) {
      return collectStream(response, deps.reportError);
    }
    if (!response.body) {
      deps.reportError({ status: 502 });
      return errorResponse(502, 'request_failed', undefined, undefined, requestId);
    }
    const streamHeaders = new Headers(response.headers);
    streamHeaders.delete('content-length');
    streamHeaders.delete('content-encoding');
    return new Response(guardStream(response.body, deps.reportError), {
      status: response.status,
      headers: streamHeaders,
    });
  };
}
