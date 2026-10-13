import { useContext, useCallback, useEffect, useState } from 'react';
import { JSX } from 'react/jsx-runtime';
import { Sun, Moon, Monitor } from 'lucide';
import type { IconNode } from './MorphIcon';
import { ThemeContext, isDark } from '../theme';
import { MorphIcon } from './MorphIcon';
import { useLocalize } from '../hooks';
import { Button } from './Button';

declare global {
  interface Window {
    /** Last accepted change per appearance control. Global rather than a ref so
     *  the throttle survives the selector remounting, which the auth routes do
     *  on every navigation between login, register and verification. */
    lastThemeChange?: Record<string, number>;
  }
}

/** Ctrl+Shift+T auto-repeats while held, which is what this throttle is for. */
const CHANGE_THROTTLE_MS = 500;

type ThemeType = 'system' | 'dark' | 'light' | 'high-contrast-light' | 'high-contrast-dark';

/** Legacy contrast modes still show their scheme while stored preferences migrate. */
const themeIcons: Record<ThemeType, IconNode> = {
  system: Monitor,
  dark: Moon,
  light: Sun,
  'high-contrast-light': Sun,
  'high-contrast-dark': Moon,
};

const Theme = ({ theme, onChange }: { theme: string; onChange: (value: string) => void }) => {
  const localize = useLocalize();

  const nextTheme = isDark(theme) ? 'light' : 'dark';

  useEffect(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 't') {
        e.preventDefault();
        onChange(nextTheme);
      }
    };
    window.addEventListener('keydown', handleKeyPress);
    return () => window.removeEventListener('keydown', handleKeyPress);
  }, [nextTheme, onChange]);

  return (
    <Button
      variant="ghost"
      size="icon"
      className="text-text-primary h-auto w-auto p-2"
      aria-label={localize('com_ui_toggle_theme')}
      aria-keyshortcuts="Ctrl+Shift+T"
      onClick={(e) => {
        e.preventDefault();
        onChange(nextTheme);
      }}
    >
      <MorphIcon icon={themeIcons[theme as ThemeType]} size={24} />
    </Button>
  );
};

const ThemeSelector = ({ returnThemeOnly }: { returnThemeOnly?: boolean }): JSX.Element => {
  const { theme, setTheme } = useContext(ThemeContext);
  const [announcement, setAnnouncement] = useState('');
  const localize = useLocalize();

  const changeTheme = useCallback(
    (value: string, control: string) => {
      const now = Date.now();
      const changes = window.lastThemeChange ?? {};
      const last = changes[control];
      if (typeof last === 'number' && now - last < CHANGE_THROTTLE_MS) {
        return;
      }
      window.lastThemeChange = { ...changes, [control]: now };

      setTheme(value);
      setAnnouncement(
        isDark(value)
          ? localize('com_ui_dark_theme_enabled')
          : localize('com_ui_light_theme_enabled'),
      );
    },
    [setTheme, localize],
  );

  const changeScheme = useCallback((value: string) => changeTheme(value, 'scheme'), [changeTheme]);

  useEffect(() => {
    if (announcement) {
      const timeout = setTimeout(() => setAnnouncement(''), 1000);
      return () => clearTimeout(timeout);
    }
  }, [announcement]);

  if (returnThemeOnly === true) {
    return <Theme theme={theme} onChange={changeScheme} />;
  }

  return (
    <div className="bg-surface-primary flex flex-col items-center justify-center pt-6 sm:pt-0">
      <div className="absolute bottom-0 left-0 m-4 flex items-center">
        <Theme theme={theme} onChange={changeScheme} />
      </div>
      <div role="alert" aria-live="assertive" aria-atomic="true" className="sr-only">
        {announcement}
      </div>
    </div>
  );
};

export default ThemeSelector;
