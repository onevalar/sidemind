import { useRef, useState } from 'react';
import {
  Label,
  Button,
  Spinner,
  OGDialog,
  OGDialogTitle,
  OGDialogHeader,
  InfoHoverCard,
  OGDialogTrigger,
  OGDialogContent,
} from '@librechat/client';
import { useGetEndpointsQuery, useLocalModeQuery } from '~/data-provider';
import ChatGPTConnection from './ChatGPTConnection';
import { isChatGPTEndpointConfig } from './utils';
import useProviderKeys from './useProviderKeys';
import ProviderKeyRow from './ProviderKeyRow';
import { useLocalize } from '~/hooks';

export default function ProviderKeys() {
  const localize = useLocalize();
  const [open, setOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const { data: endpointsConfig, isLoading, isError, refetch } = useGetEndpointsQuery();
  const localMode = useLocalModeQuery().data?.localMode === true;
  const endpoints = useProviderKeys();

  const handleOpenAutoFocus = (event: Event) => {
    event.preventDefault();
    contentRef.current?.focus();
  };

  const connections = endpointsConfig && (
    <div className="divide-border-light divide-y">
      {endpoints.map((endpoint) =>
        isChatGPTEndpointConfig(endpointsConfig[endpoint]) ? (
          <ChatGPTConnection key={endpoint} endpoint={endpoint} />
        ) : (
          <ProviderKeyRow key={endpoint} endpoint={endpoint} endpointsConfig={endpointsConfig} />
        ),
      )}
    </div>
  );

  if (localMode) {
    let content = connections;
    if (isLoading) {
      content = (
        <div role="status" className="text-text-secondary flex items-center gap-2 text-sm">
          <Spinner className="size-4" aria-hidden="true" />
          {localize('com_ui_loading')}
        </div>
      );
    } else if (isError) {
      content = (
        <div className="space-y-2">
          <p role="alert" className="text-text-destructive text-sm">
            {localize('com_ui_model_connections_load_error')}
          </p>
          <Button variant="outline" onClick={() => refetch()}>
            {localize('com_ui_retry')}
          </Button>
        </div>
      );
    } else if (endpoints.length === 0) {
      content = (
        <p role="status" className="text-text-secondary text-sm">
          {localize('com_ui_model_connections_empty')}
        </p>
      );
    }
    return (
      <div className="space-y-4">
        <p className="text-text-secondary text-sm">
          {localize('com_ui_provider_api_keys_description')}
        </p>
        {content}
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between">
      <Label id="provider-api-keys-label">
        {localize('com_ui_settings_label_provider_api_keys')}
      </Label>
      <OGDialog open={open} onOpenChange={setOpen}>
        <OGDialogTrigger asChild>
          <Button variant="outline" aria-labelledby="provider-api-keys-label">
            {localize('com_ui_manage')}
          </Button>
        </OGDialogTrigger>
        <OGDialogContent
          focusOutline="hidden"
          ref={contentRef}
          tabIndex={-1}
          onOpenAutoFocus={handleOpenAutoFocus}
          className="bg-surface-dialog text-text-primary focus-visible:ring-text-primary w-11/12 max-w-2xl shadow-2xl focus-visible:ring-2 focus-visible:ring-inset"
          aria-describedby={undefined}
        >
          <OGDialogHeader className="space-y-0 pr-8 text-left">
            <div className="flex items-center gap-1.5">
              <OGDialogTitle>{localize('com_ui_settings_label_provider_api_keys')}</OGDialogTitle>
              <InfoHoverCard text={localize('com_ui_provider_api_keys_description')} />
            </div>
          </OGDialogHeader>
          {connections}
        </OGDialogContent>
      </OGDialog>
    </div>
  );
}
