import { useContext, useCallback, useState } from 'react';
import { useAtom } from 'jotai';
import Cookies from 'js-cookie';
import { useRecoilState, useRecoilValue } from 'recoil';
import { ThemeContext, Dropdown, Button } from '@librechat/client';
import { getEndpointField, isParamEndpoint, isAgentsEndpoint } from 'librechat-data-provider';
import type { ComponentType, ReactNode } from 'react';
import type { TranslationKeys } from '~/hooks';
import { useGetEndpointsQuery, useGetStartupConfig } from '~/data-provider';
import { ThemeSelector, LangSelector } from '~/components/Appearance';
import Parameters from '~/components/SidePanel/Parameters/Panel';
import PresetsMenu from '~/components/Chat/Menus/PresetsMenu';
import { readerMode } from '~/components/Chat/Canvas/state';
import ToggleSwitch from '../SettingsTabs/ToggleSwitch';
import { ChatProvider } from '~/hooks/Chat/provider';
import { useLocalize } from '~/hooks';
import store from '~/store';

export function toggleControl(opts: {
  stateAtom: Parameters<typeof ToggleSwitch>[0]['stateAtom'];
  localizationKey: TranslationKeys;
  switchId: string;
  hoverCardText?: TranslationKeys;
  onCheckedChange?: (value: boolean) => void;
}): ComponentType {
  const Control = () => (
    <ToggleSwitch
      stateAtom={opts.stateAtom}
      localizationKey={opts.localizationKey}
      switchId={opts.switchId}
      hoverCardText={opts.hoverCardText}
      onCheckedChange={opts.onCheckedChange}
    />
  );
  Control.displayName = `Toggle(${opts.switchId})`;
  return Control;
}

export function ThemeSetting() {
  const { theme, setTheme } = useContext(ThemeContext);
  const onChange = useCallback((value: string) => setTheme(value), [setTheme]);
  return <ThemeSelector theme={theme} onChange={onChange} />;
}

export function LangSetting() {
  const [langcode, setLangcode] = useRecoilState(store.lang);
  const onChange = useCallback(
    (value: string) => {
      const userLang =
        value === 'auto' ? navigator.language || navigator.languages?.[0] || 'en-US' : value;
      requestAnimationFrame(() => {
        document.documentElement.lang = userLang;
      });
      setLangcode(userLang);
      Cookies.set('lang', userLang, { expires: 365 });
    },
    [setLangcode],
  );
  return <LangSelector langcode={langcode} onChange={onChange} />;
}

export function CanvasReadingSetting() {
  const localize = useLocalize();
  const [mode, setMode] = useAtom(readerMode);
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div id="canvas-reading-label">{localize('com_canvas_reading')}</div>
      <Dropdown
        value={mode}
        onChange={(value) => setMode(value as 'side' | 'dialog')}
        options={[
          { value: 'side', label: localize('com_canvas_side') },
          { value: 'dialog', label: localize('com_canvas_dialog') },
        ]}
        aria-labelledby="canvas-reading-label"
        sizeClasses="z-50 w-[min(12.5rem,90vw)]"
      />
    </div>
  );
}

export function ModelParametersSetting() {
  const localize = useLocalize();
  const [open, setOpen] = useState(false);
  const endpoint = useRecoilValue(store.conversationEndpointByIndex(0)) ?? '';
  const endpoints = useGetEndpointsQuery();
  const startup = useGetStartupConfig();
  const endpointType = getEndpointField(endpoints.data ?? {}, endpoint, 'type') ?? '';
  const supported =
    endpoints.data?.[endpoint] != null &&
    isParamEndpoint(endpoint, endpointType) &&
    !isAgentsEndpoint(endpoint);

  let content: ReactNode;
  if (endpoints.isError || startup.isError) {
    content = (
      <div role="alert" className="text-text-secondary text-sm">
        <p>{localize('com_ui_error_connection')}</p>
        <Button
          variant="outline"
          onClick={() => {
            void endpoints.refetch();
            void startup.refetch();
          }}
        >
          {localize('com_ui_retry')}
        </Button>
      </div>
    );
  } else if (endpoints.data == null || startup.data == null) {
    content = <p role="status">{localize('com_ui_loading')}</p>;
  } else if (!supported) {
    content = (
      <p className="text-text-secondary text-sm">
        {localize('com_ui_model_parameters_unavailable')}
      </p>
    );
  } else {
    content = (
      <ChatProvider>
        <div className="mb-3 flex items-center justify-between gap-2">
          <span>{localize('com_endpoint_examples')}</span>
          <PresetsMenu />
        </div>
        <Parameters />
      </ChatProvider>
    );
  }

  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="text-text-primary focus-visible:ring-focus-control min-h-11 cursor-pointer rounded-lg py-3 font-medium focus-visible:ring-2 focus-visible:outline-hidden focus-visible:ring-inset">
        {localize('com_ui_model_parameters')}
      </summary>
      {open && (
        <>
          <p className="text-text-secondary mb-4 text-sm">
            {localize('com_ui_model_parameters_scope')}
          </p>
          {/* The editor normalizes values on mount. Never mount it in a closed
              disclosure or before the configuration is resolved. */}
          {content}
        </>
      )}
    </details>
  );
}
