import { useMemo, useState } from 'react';
import type { SettingsContextValue, SettingsTab } from './types';
import { filterSettings } from './search';
import { getSettings } from './registry';
import { useLocalize } from '~/hooks';
import Section from './Section';

interface ContentProps {
  activeTab: SettingsTab;
  query: string;
  ctx: SettingsContextValue;
}

export default function Content({ activeTab, query, ctx }: ContentProps) {
  const localize = useLocalize();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const { tabs, entries } = useMemo(() => getSettings(ctx), [ctx]);
  const tab = tabs.find((t) => t.id === activeTab)!;

  const results = useMemo(
    () => (query.trim() ? filterSettings(entries, query, ctx, localize) : null),
    [entries, query, ctx, localize],
  );

  if (results !== null) {
    return (
      <div aria-label={localize('com_ui_settings_results_aria')} aria-live="polite">
        {results.length === 0 ? (
          <p className="text-text-secondary p-2 text-sm">
            {localize('com_ui_settings_no_results')}
          </p>
        ) : (
          <div className="text-text-primary overflow-hidden rounded-xl text-sm">
            {results.map(({ entry, label }) => {
              const Cmp = entry.Component;
              const tabMeta = tabs.find((t) => t.id === entry.tab)!;
              const sectionMeta = tabMeta.sections.find((s) => s.id === entry.section);
              return (
                <div key={entry.id} className="px-4 py-3">
                  <div className="text-text-tertiary mb-1.5 text-xs">
                    {localize(tabMeta.labelKey)} ›{' '}
                    {sectionMeta ? localize(sectionMeta.labelKey) : label}
                  </div>
                  <Cmp />
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  const sections = tab.sections.flatMap((section) => {
    const settings = entries.filter(
      (entry) => entry.tab === activeTab && entry.section === section.id,
    );
    if (settings.length === 0) return [];
    return [
      {
        advanced: section.advanced,
        content: (
          <Section
            key={section.id}
            heading={localize(section.labelKey)}
            icon={section.icon}
            danger={section.danger}
          >
            {settings.map((e) => {
              const Cmp = e.Component;
              return (
                <div key={e.id} className="px-4 py-3">
                  <Cmp />
                </div>
              );
            })}
          </Section>
        ),
      },
    ];
  });

  return (
    <div>
      {sections.filter((section) => !section.advanced).map((section) => section.content)}
      {sections.some((section) => section.advanced) && (
        <details
          open={advancedOpen}
          onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
        >
          <summary className="text-text-secondary focus-visible:ring-focus-control min-h-11 cursor-pointer rounded-lg px-1 py-3 text-sm font-medium focus-visible:ring-2 focus-visible:outline-hidden focus-visible:ring-inset">
            {localize('com_ui_advanced_settings')}
          </summary>
          {advancedOpen &&
            sections.filter((section) => section.advanced).map((section) => section.content)}
        </details>
      )}
    </div>
  );
}
