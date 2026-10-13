import React from 'react';
import { useTranslation } from 'react-i18next';
import { act, render, screen } from '@testing-library/react';
import type { TranslationResource } from './i18n';
import type { TranslationKeys } from '~/hooks';
import {
  __resetLocaleForTests,
  __setLocaleLoaderForTests,
  changeLanguageSafely,
  ensureLocale,
  initializeI18n,
  normalizeLocale,
} from './i18n';
import English from './en/translation.json';
import Spanish from './es/translation.json';
import French from './fr/translation.json';
import i18n from './i18n';

// The shared test setup stubs this hook without language-change subscriptions.
jest.unmock('react-i18next');

const workspacePrefixes = [
  'com_canvas_',
  'com_auth_local_',
  'com_ui_chatgpt_',
  'com_ui_settings_',
  'com_ui_provider_api_keys_',
  'com_endpoint_config_',
  'com_ui_composer_',
  'com_ui_context_',
  'com_ui_greeting_',
];

const workspaceKeys = Object.keys(English).filter((key) =>
  workspacePrefixes.some((prefix) => key.startsWith(prefix)),
);

function WorkspaceLabels() {
  const { t } = useTranslation();
  return React.createElement(
    'section',
    null,
    React.createElement('h1', null, t('com_canvas_title')),
    React.createElement('button', null, t('com_ui_settings_label_provider_api_keys')),
    React.createElement('p', null, t('com_ui_chatgpt_connected_as', { 0: 'reader@example.com' })),
    React.createElement('p', null, t('com_endpoint_config_key_encryption', { 0: '2030-01-02' })),
    React.createElement('p', null, t('com_ui_composer_hint_uploading', { count: 2 })),
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}

describe('i18next translation tests', () => {
  // Ensure i18next is initialized before any tests run
  beforeAll(async () => {
    await initializeI18n();
  });

  afterEach(async () => {
    await changeLanguageSafely('en');
  });

  it('should return the correct translation for a valid key in English', async () => {
    await changeLanguageSafely('en');
    expect(i18n.t('com_ui_examples')).toBe(English.com_ui_examples);
  });

  it('should return the correct translation for a valid key in French', async () => {
    await changeLanguageSafely('fr');
    expect(i18n.t('com_ui_examples')).toBe(French.com_ui_examples);
  });

  it('should return the correct translation for a valid key in Spanish', async () => {
    await changeLanguageSafely('es');
    expect(i18n.t('com_ui_examples')).toBe(Spanish.com_ui_examples);
  });

  it('updates mounted workspace labels and interpolated values when switching Chinese and English', async () => {
    await changeLanguageSafely('en');
    const { unmount } = render(React.createElement(WorkspaceLabels));
    expect(screen.getByRole('heading', { name: 'Message canvas' })).toBeInTheDocument();

    await act(async () => {
      await changeLanguageSafely('zh-Hans');
    });
    expect(document.documentElement.lang).toBe('zh-Hans');
    expect(screen.getByRole('heading', { name: '消息画布' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '模型连接' })).toBeInTheDocument();
    expect(screen.getByText('已连接为 reader@example.com')).toBeInTheDocument();
    expect(screen.getByText('当前密钥已加密，将于 2030-01-02 删除')).toBeInTheDocument();
    expect(screen.getByText('正在上传 2 个文件…')).toBeInTheDocument();

    await act(async () => {
      await changeLanguageSafely('zh-Hant');
    });
    expect(document.documentElement.lang).toBe('zh-Hant');
    expect(screen.getByRole('heading', { name: '訊息畫布' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '模型連線' })).toBeInTheDocument();
    expect(screen.getByText('已連接為 reader@example.com')).toBeInTheDocument();
    expect(screen.getByText('目前的金鑰已加密，將於 2030-01-02 刪除')).toBeInTheDocument();
    expect(screen.getByText('正在上傳 2 個檔案…')).toBeInTheDocument();

    await act(async () => {
      await changeLanguageSafely('en');
    });
    expect(document.documentElement.lang).toBe('en');
    expect(screen.getByRole('heading', { name: 'Message canvas' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Model connections' })).toBeInTheDocument();
    expect(screen.getByText('Connected as reader@example.com')).toBeInTheDocument();
    unmount();
  });

  it.each(['zh-Hans', 'zh-Hant'])(
    'provides %s workspace translations without English fallback and preserves placeholders',
    async (locale) => {
      await changeLanguageSafely(locale);
      const untranslatedNames = new Set([
        'com_canvas_brand',
        'com_ui_settings_section_langfuse',
        'com_ui_settings_tab_langfuse',
      ]);

      for (const key of workspaceKeys) {
        const source = English[key as keyof typeof English];
        // Read the selected resource directly: i18n.t would hide a missing key with English.
        const translated = i18n.getResource(locale, 'translation', key);
        expect({ key, translated }).toEqual({ key, translated: expect.any(String) });
        expect(translated.trim()).not.toBe('');
        expect({ key, placeholders: (translated.match(/\{\{[^}]+\}\}/g) ?? []).sort() }).toEqual({
          key,
          placeholders: (source.match(/\{\{[^}]+\}\}/g) ?? []).sort(),
        });
        if (!untranslatedNames.has(key)) {
          expect({ key, translated }).not.toEqual({ key, translated: source });
        }
      }
    },
  );

  it('should fallback to English for an invalid language code', async () => {
    // When an invalid language is provided, i18next should fallback to English
    await changeLanguageSafely('invalid-code');
    expect(i18n.t('com_ui_examples')).toBe(English.com_ui_examples);
  });

  it('should return the key itself for an invalid key', async () => {
    await changeLanguageSafely('en');
    expect(i18n.t('invalid-key' as TranslationKeys)).toBe('invalid-key'); // Returns the key itself
  });

  it('should correctly format placeholders in the translation', async () => {
    await changeLanguageSafely('en');
    expect(i18n.t('com_endpoint_default_with_num', { 0: 'John' })).toBe('default: John');

    await changeLanguageSafely('fr');
    expect(i18n.t('com_endpoint_default_with_num', { 0: 'Marie' })).toBe('par défaut : Marie');
  });

  it('should normalize language selector values to locale files', () => {
    expect(normalizeLocale('en-US')).toBe('en');
    expect(normalizeLocale('de-DE')).toBe('de');
    expect(normalizeLocale('fr-FR')).toBe('fr');
    expect(normalizeLocale('ar-EG')).toBe('ar');
    expect(normalizeLocale('he-IL')).toBe('he');
    expect(normalizeLocale('nl-NL')).toBe('nl');
    expect(normalizeLocale('pl-PL')).toBe('pl');
    expect(normalizeLocale('uk-UA')).toBe('uk');
    expect(normalizeLocale('zh-Hans')).toBe('zh-Hans');
    expect(normalizeLocale('zh-Hant')).toBe('zh-Hant');
    expect(normalizeLocale('pt-BR')).toBe('pt-BR');
    expect(normalizeLocale('pt-PT')).toBe('pt-PT');
  });

  it('should reuse an in-flight locale load', async () => {
    __resetLocaleForTests('sv');
    const pendingLocale = deferred<{ default: TranslationResource }>();
    const loadLocale = jest.fn(() => pendingLocale.promise);
    const restoreLoader = __setLocaleLoaderForTests('sv', loadLocale);

    const firstLoad = ensureLocale('sv-SE');
    const secondLoad = ensureLocale('sv-SE');

    expect(loadLocale).toHaveBeenCalledTimes(1);

    pendingLocale.resolve({ default: { com_ui_examples: 'svenska exempel' } });

    await expect(Promise.all([firstLoad, secondLoad])).resolves.toEqual(['sv', 'sv']);
    expect(i18n.getResource('sv', 'translation', 'com_ui_examples')).toBe('svenska exempel');

    restoreLoader();
    __resetLocaleForTests('sv');
  });

  it('should retry a locale load after a transient failure', async () => {
    __resetLocaleForTests('ka');
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    let callCount = 0;
    const restoreLoader = __setLocaleLoaderForTests('ka', async () => {
      callCount += 1;
      if (callCount === 1) {
        throw new Error('temporary chunk failure');
      }

      return { default: { com_ui_examples: 'ქართული მაგალითები' } };
    });

    await expect(ensureLocale('ka-GE')).resolves.toBe('en');
    await expect(ensureLocale('ka-GE')).resolves.toBe('ka');

    expect(callCount).toBe(2);
    expect(i18n.getResource('ka', 'translation', 'com_ui_examples')).toBe('ქართული მაგალითები');

    restoreLoader();
    __resetLocaleForTests('ka');
    consoleErrorSpy.mockRestore();
  });

  it('should only apply the newest rapid language switch', async () => {
    __resetLocaleForTests('sv');
    __resetLocaleForTests('ka');
    __resetLocaleForTests('sl');

    const svLocale = deferred<{ default: TranslationResource }>();
    const kaLocale = deferred<{ default: TranslationResource }>();
    const slLocale = deferred<{ default: TranslationResource }>();
    const restoreSv = __setLocaleLoaderForTests('sv', () => svLocale.promise);
    const restoreKa = __setLocaleLoaderForTests('ka', () => kaLocale.promise);
    const restoreSl = __setLocaleLoaderForTests('sl', () => slLocale.promise);

    const firstSwitch = changeLanguageSafely('sv-SE');
    const secondSwitch = changeLanguageSafely('ka-GE');
    const latestSwitch = changeLanguageSafely('sl');

    svLocale.resolve({ default: { com_ui_examples: 'svenska exempel' } });
    await firstSwitch;
    expect(i18n.language).not.toBe('sv');

    kaLocale.resolve({ default: { com_ui_examples: 'ქართული მაგალითები' } });
    await secondSwitch;
    expect(i18n.language).not.toBe('ka');

    slLocale.resolve({ default: { com_ui_examples: 'slovenski primeri' } });
    await expect(latestSwitch).resolves.toBe('sl');
    expect(i18n.language).toBe('sl');
    expect(document.documentElement.lang).toBe('sl');

    restoreSv();
    restoreKa();
    restoreSl();
    __resetLocaleForTests('sv');
    __resetLocaleForTests('ka');
    __resetLocaleForTests('sl');
  });

  it('should restore the newest language if an older change finishes late', async () => {
    __resetLocaleForTests('sv');
    __resetLocaleForTests('sl');

    const svLocale = deferred<{ default: TranslationResource }>();
    const slLocale = deferred<{ default: TranslationResource }>();
    const restoreSv = __setLocaleLoaderForTests('sv', () => svLocale.promise);
    const restoreSl = __setLocaleLoaderForTests('sl', () => slLocale.promise);

    const firstSwitch = changeLanguageSafely('sv-SE');
    const latestSwitch = changeLanguageSafely('sl');

    slLocale.resolve({ default: { com_ui_examples: 'slovenski primeri' } });
    await expect(latestSwitch).resolves.toBe('sl');
    expect(i18n.language).toBe('sl');

    svLocale.resolve({ default: { com_ui_examples: 'svenska exempel' } });
    await firstSwitch;
    expect(i18n.language).toBe('sl');
    expect(document.documentElement.lang).toBe('sl');

    restoreSv();
    restoreSl();
    __resetLocaleForTests('sv');
    __resetLocaleForTests('sl');
  });
});
