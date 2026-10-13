import { useRecoilValue } from 'recoil';
import { useQuery } from '@tanstack/react-query';
import { QueryKeys, apiBaseUrl, dataService, request } from 'librechat-data-provider';
import type { QueryObserverResult, UseQueryOptions } from '@tanstack/react-query';
import type t from 'librechat-data-provider';
import store from '~/store';

export const useGetUserQuery = (
  config?: UseQueryOptions<t.TUser>,
): QueryObserverResult<t.TUser> => {
  const queriesEnabled = useRecoilValue<boolean>(store.queriesEnabled);
  return useQuery<t.TUser>([QueryKeys.user], () => dataService.getUser(), {
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
    retry: false,
    ...config,
    enabled: (config?.enabled ?? true) === true && queriesEnabled,
  });
};

export interface UseGraphTokenQueryOptions {
  scopes?: string;
  enabled?: boolean;
}

export const useGraphTokenQuery = (
  options: UseGraphTokenQueryOptions = {},
  config?: UseQueryOptions<any>,
): QueryObserverResult<any> => {
  const { scopes, enabled = false } = options;

  return useQuery({
    queryKey: [QueryKeys.graphToken, scopes],
    queryFn: () => dataService.getGraphApiToken({ scopes: scopes ?? '' }),
    enabled,
    staleTime: 50 * 60 * 1000, // 50 minutes (tokens expire in 60 minutes)
    retry: 1,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
    ...config,
  });
};

export const usePasskeysQuery = (
  config?: UseQueryOptions<t.TPasskeysResponse>,
): QueryObserverResult<t.TPasskeysResponse> => {
  const queriesEnabled = useRecoilValue<boolean>(store.queriesEnabled);
  return useQuery<t.TPasskeysResponse>([QueryKeys.passkeys], () => dataService.getPasskeys(), {
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
    ...config,
    enabled: (config?.enabled ?? true) === true && queriesEnabled,
  });
};

/** `GET /api/local/status`: whether this ChatGit runs in account-free local mode. */
export type TLocalModeStatus = { localMode: boolean };

/** Client-owned key: the endpoint is ChatGit-specific, not part of the shared data-provider. */
export const localModeQueryKey = ['chatgitLocalMode'] as const;

/**
 * Unauthenticated and stable for the life of the server process, so it is fetched once. A failed
 * lookup reads as "not local": the server still refuses every sign-in method local mode disables.
 */
export const useLocalModeQuery = (): QueryObserverResult<TLocalModeStatus> =>
  useQuery<TLocalModeStatus>(
    localModeQueryKey,
    () => request.get<TLocalModeStatus>(`${apiBaseUrl()}/api/local/status`),
    {
      staleTime: Infinity,
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
    },
  );
