import { useEffect, useRef } from 'react';
import { Button, Spinner } from '@librechat/client';
import { alternateName } from 'librechat-data-provider';
import type {
  TChatGPTConnectionStatus,
  TChatGPTConnectionErrorCode,
} from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import {
  useGetChatGPTModelsQuery,
  useRefreshChatGPTModels,
  useDisconnectChatGPTMutation,
  useGetChatGPTConnectionQuery,
  useStartChatGPTLoginMutation,
  useCancelChatGPTLoginMutation,
} from '~/data-provider';
import { useLocalize } from '~/hooks';

const USAGE_URL = 'https://chatgpt.com/settings/usage';

const ERROR_KEYS: Partial<Record<TChatGPTConnectionErrorCode, TranslationKeys>> = {
  access_denied: 'com_ui_chatgpt_error_access_denied',
  plan_usage_not_granted: 'com_ui_chatgpt_error_plan_usage',
  subject_mismatch: 'com_ui_chatgpt_error_account_mismatch',
  client_mismatch: 'com_ui_chatgpt_error_account_mismatch',
  state_expired: 'com_ui_chatgpt_error_expired',
  invalid_grant: 'com_ui_chatgpt_error_expired',
  reauth_required: 'com_ui_chatgpt_error_reauth',
  usage_limit_exceeded: 'com_ui_chatgpt_error_usage_limit',
  usage_unavailable: 'com_ui_chatgpt_error_unavailable',
  refresh_unavailable: 'com_ui_chatgpt_error_unavailable',
  network_error: 'com_ui_chatgpt_error_unavailable',
  user_not_eligible: 'com_ui_chatgpt_error_not_eligible',
};

function errorKey(code?: TChatGPTConnectionErrorCode): TranslationKeys | undefined {
  if (!code || code === 'cancelled') {
    return undefined;
  }
  return ERROR_KEYS[code] ?? 'com_ui_chatgpt_error_generic';
}

function httpStatusOf(error: unknown): number | undefined {
  return (error as { response?: { status?: number } } | null)?.response?.status;
}

/**
 * Owner-only Sign in with ChatGPT connection for a `authMode: chatgpt` custom endpoint.
 * Messages on that endpoint route through the same connection, so the button below is the
 * only credential step; models listed here come from the signed-in account.
 */
export default function ChatGPTConnection({ endpoint }: { endpoint: string }) {
  const localize = useLocalize();
  const statusQuery = useGetChatGPTConnectionQuery();
  const status: TChatGPTConnectionStatus | undefined = statusQuery.data;
  const connected = status?.state === 'connected';
  const modelsQuery = useGetChatGPTModelsQuery(connected);
  const refreshModels = useRefreshChatGPTModels();
  const startLogin = useStartChatGPTLoginMutation();
  const cancelLogin = useCancelChatGPTLoginMutation();
  const disconnect = useDisconnectChatGPTMutation();
  const previousState = useRef(status?.state);

  useEffect(() => {
    if (previousState.current === 'pending' && status?.state === 'connected') {
      refreshModels();
    }
    previousState.current = status?.state;
  }, [status?.state, refreshModels]);

  const label = alternateName[endpoint] || endpoint;
  const busy = startLogin.isLoading || cancelLogin.isLoading || disconnect.isLoading;

  const handleContinue = () => {
    /** Open synchronously so the browser keeps the user gesture, then navigate it. */
    const authWindow = window.open('about:blank', '_blank');
    if (authWindow) {
      authWindow.opener = null;
    }
    startLogin.mutate(undefined, {
      onSuccess: ({ authorizationUrl }) => {
        if (authWindow) {
          authWindow.location.href = authorizationUrl;
        } else {
          window.location.assign(authorizationUrl);
        }
      },
      onError: () => authWindow?.close(),
    });
  };

  if (statusQuery.isLoading) {
    return (
      <div className="text-text-secondary flex items-center gap-2 py-2 text-sm" role="status">
        <Spinner className="size-4" aria-hidden="true" />
        {localize('com_ui_loading')}
      </div>
    );
  }

  if (statusQuery.isError || !status) {
    const code = httpStatusOf(statusQuery.error);
    let key: TranslationKeys = 'com_ui_chatgpt_error_generic';
    if (code === 403) {
      key = 'com_ui_chatgpt_owner_only';
    } else if (code === 404) {
      key = 'com_ui_chatgpt_unavailable';
    }
    return (
      <div className="py-2">
        <div className="text-text-primary truncate font-medium">{label}</div>
        <p className="text-text-secondary text-xs" role="status">
          {localize(key)}
        </p>
      </div>
    );
  }

  const lastErrorKey = errorKey(status.lastError);
  const startError = startLogin.isError || disconnect.isError || cancelLogin.isError;
  const models = modelsQuery.data?.models ?? [];

  return (
    <div className="flex flex-col gap-2 py-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-text-primary truncate font-medium">{label}</div>
          <div className="text-text-secondary text-xs" role="status" aria-live="polite">
            {status.state === 'connected' &&
              (status.email
                ? localize('com_ui_chatgpt_connected_as', { 0: status.email })
                : localize('com_ui_chatgpt_connected'))}
            {status.state === 'pending' && localize('com_ui_chatgpt_pending')}
            {status.state === 'reauth_required' && localize('com_ui_chatgpt_error_reauth')}
            {(status.state === 'disconnected' || status.state === 'disabled') &&
              localize('com_ui_chatgpt_not_connected')}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {status.state === 'pending' && (
            <Button variant="outline" disabled={busy} onClick={() => cancelLogin.mutate()}>
              {localize('com_ui_cancel')}
            </Button>
          )}
          {connected && (
            <Button variant="outline" disabled={busy} onClick={() => disconnect.mutate()}>
              {disconnect.isLoading ? (
                <Spinner className="size-4" aria-hidden="true" />
              ) : (
                localize('com_ui_chatgpt_disconnect')
              )}
            </Button>
          )}
          {(status.state === 'disconnected' || status.state === 'reauth_required') && (
            <Button variant="outline" disabled={busy} onClick={handleContinue}>
              {startLogin.isLoading ? (
                <Spinner className="size-4" aria-hidden="true" />
              ) : (
                localize('com_ui_chatgpt_continue')
              )}
            </Button>
          )}
        </div>
      </div>
      <p className="text-text-secondary text-xs">{localize('com_ui_chatgpt_description')}</p>
      {(lastErrorKey || startError) && (
        <p className="text-text-destructive text-xs" role="alert">
          {localize(lastErrorKey ?? 'com_ui_chatgpt_error_generic')}
        </p>
      )}
      {status.revocation === 'unconfirmed' && (
        <p className="text-text-secondary text-xs" role="status">
          {localize('com_ui_chatgpt_revocation_unconfirmed')}
        </p>
      )}
      {connected && modelsQuery.isLoading && (
        <p className="text-text-secondary text-xs">{localize('com_ui_loading')}</p>
      )}
      {connected && modelsQuery.isError && (
        <p className="text-text-destructive text-xs" role="alert">
          {localize('com_ui_chatgpt_models_error')}
        </p>
      )}
      {connected && modelsQuery.isSuccess && (
        <p className="text-text-secondary text-xs">
          {models.length > 0
            ? localize('com_ui_chatgpt_models', {
                0: models.map((model) => model.displayName).join(', '),
              })
            : localize('com_ui_chatgpt_models_empty')}
        </p>
      )}
      {(connected || status.lastError === 'usage_limit_exceeded') && (
        <a
          href={USAGE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-text-secondary hover:text-text-primary text-xs underline underline-offset-2"
        >
          {localize('com_ui_chatgpt_usage_link')}
        </a>
      )}
    </div>
  );
}
