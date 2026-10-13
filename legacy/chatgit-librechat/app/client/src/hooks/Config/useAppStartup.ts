import { useEffect, useRef } from 'react';
import TagManager from 'react-gtm-module';
import { useRecoilState, useRecoilValue } from 'recoil';
import { installCloudFrontImageRetry } from '@librechat/client';
import { useGetModelsQuery } from 'librechat-data-provider/react-query';
import {
  getTokenHeader,
  LocalStorageKeys,
  PermissionTypes,
  Permissions,
  resolveModelSpecEndpoint,
} from 'librechat-data-provider';
import type { TStartupConfig, TUser } from 'librechat-data-provider';
import { useMCPServersQuery, useGetPresetsQuery } from '~/data-provider';
import { cleanupTimestampedStorage } from '~/utils/timestamps';
import useSpeechSettingsInit from './useSpeechSettingsInit';
import { useHasAccess, useCatalogReady } from '~/hooks';
import useNewConvo from '~/hooks/useNewConvo';
import { setDocumentTitle } from '~/utils';
import store from '~/store';

export default function useAppStartup({
  startupConfig,
  user,
}: {
  startupConfig?: TStartupConfig;
  user?: TUser;
}) {
  const [defaultPreset, setDefaultPreset] = useRecoilState(store.defaultPreset);
  const hasLoadedPreset = useRef(false);
  const conversationId = useRecoilValue(store.conversationIdByIndex(0));
  const { data: modelsData } = useGetModelsQuery();
  const { data: presets, refetch: refetchPresets } = useGetPresetsQuery({ enabled: !!user });
  const { newConversation } = useNewConvo();
  const canUseMcp = useHasAccess({
    permissionType: PermissionTypes.MCP_SERVERS,
    permission: Permissions.USE,
  });

  useSpeechSettingsInit(!!user);
  /** Server metadata may warm after first paint because it powers lightweight
   * navigation affordances. Tool discovery stays owned by visible MCP consumers. */
  const mcpServersReady = useCatalogReady('mcpServers');
  useMCPServersQuery({ enabled: canUseMcp && mcpServersReady });

  /** Clean up old localStorage entries on startup */
  useEffect(() => {
    cleanupTimestampedStorage();
  }, []);

  /** Loading the saved default must not depend on displaying the presets menu. */
  useEffect(() => {
    // The former header entry mounted only after the chat was initialized.
    // Do not apply a saved default before that initialization can overwrite it.
    if (
      !user ||
      !conversationId ||
      !modelsData ||
      modelsData.initial ||
      defaultPreset ||
      !presets ||
      hasLoadedPreset.current
    ) {
      return;
    }
    if (presets.length > 0 && presets[0].user !== user.id) {
      void refetchPresets();
      return;
    }
    const savedDefault = presets.find((preset) => preset.defaultPreset);
    if (savedDefault) {
      setDefaultPreset(savedDefault);
      if (conversationId === 'new') {
        newConversation({ preset: savedDefault, modelsData, disableParams: true });
      }
    }
    hasLoadedPreset.current = true;
  }, [
    user,
    modelsData,
    defaultPreset,
    presets,
    conversationId,
    refetchPresets,
    setDefaultPreset,
    newConversation,
  ]);

  /** Set the app title */
  useEffect(() => {
    const appTitle = startupConfig?.appTitle ?? '';
    if (!appTitle) {
      return;
    }
    setDocumentTitle(appTitle, true);
    localStorage.setItem(LocalStorageKeys.APP_TITLE, appTitle);
  }, [startupConfig]);

  /** Set the default spec's preset as default */
  useEffect(() => {
    if (defaultPreset && defaultPreset.spec != null) {
      return;
    }

    const modelSpecs = startupConfig?.modelSpecs?.list;

    if (!modelSpecs || !modelSpecs.length) {
      return;
    }

    const defaultSpec = modelSpecs.find((spec) => spec.default);

    if (!defaultSpec) {
      return;
    }

    setDefaultPreset({
      ...defaultSpec.preset,
      endpoint: resolveModelSpecEndpoint(defaultSpec) ?? null,
      iconURL: defaultSpec.iconURL,
      spec: defaultSpec.name,
    });
  }, [defaultPreset, setDefaultPreset, startupConfig?.modelSpecs?.list]);

  useEffect(() => {
    return installCloudFrontImageRetry(startupConfig, { getAuthorizationHeader: getTokenHeader });
  }, [startupConfig]);

  useEffect(() => {
    if (startupConfig?.analyticsGtmId != null && typeof window.google_tag_manager === 'undefined') {
      const tagManagerArgs = {
        gtmId: startupConfig.analyticsGtmId,
      };
      TagManager.initialize(tagManagerArgs);
    }
  }, [startupConfig?.analyticsGtmId]);
}
