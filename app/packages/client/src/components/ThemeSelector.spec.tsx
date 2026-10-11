import '@testing-library/jest-dom';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import ThemeSelector from './ThemeSelector';
import { ThemeContext } from '../theme';

jest.mock('./MorphIcon', () => {
  const { createMorphIconMock } = jest.requireActual('../test/mockMorphIcon');
  const { Sun, Moon, Monitor, Contrast } = jest.requireActual('lucide');
  return {
    MorphIcon: createMorphIconMock([
      [Sun, 'sun'],
      [Moon, 'moon'],
      [Monitor, 'monitor'],
      [Contrast, 'contrast'],
    ]),
  };
});

jest.mock('../hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

const renderWith = (
  theme: string,
  highContrast: boolean,
  setTheme: jest.Mock,
  children: React.ReactElement,
) => {
  const view = render(
    <ThemeContext.Provider
      value={
        {
          theme,
          setTheme,
          resolvedMode: 'light',
          highContrast,
          setThemeRGB: () => undefined,
          setThemeDefinition: () => undefined,
          setThemeName: () => undefined,
          resetTheme: () => undefined,
        } as React.ContextType<typeof ThemeContext>
      }
    >
      {children}
    </ThemeContext.Provider>,
  );
  return { setTheme, unmount: view.unmount };
};

const renderTheme = (theme: string, highContrast = false, setTheme = jest.fn()) =>
  renderWith(theme, highContrast, setTheme, <ThemeSelector returnThemeOnly />);

/** The form the auth routes render, with its live announcement. */
const renderAuthControls = (theme: string, highContrast = false, setTheme = jest.fn()) =>
  renderWith(theme, highContrast, setTheme, <ThemeSelector />);

beforeEach(() => {
  /** `changeTheme` throttles itself through this global for 500ms. */
  window.lastThemeChange = undefined;
  window.matchMedia = jest.fn().mockImplementation(
    (media: string) =>
      ({
        matches: false,
        media,
        onchange: null,
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        addListener: jest.fn(),
        removeListener: jest.fn(),
        dispatchEvent: jest.fn(),
      }) as unknown as MediaQueryList,
  );
});

describe('ThemeSelector MorphIcon map', () => {
  it('shows monitor for system, moon for dark, sun for light', () => {
    const system = renderTheme('system');
    expect(screen.getByTestId('monitor')).toBeInTheDocument();
    expect(screen.getByTestId('monitor')).toHaveAttribute('data-size', '24');
    system.unmount();

    const dark = renderTheme('dark');
    expect(screen.getByTestId('moon')).toBeInTheDocument();
    dark.unmount();

    renderTheme('light');
    expect(screen.getByTestId('sun')).toBeInTheDocument();
  });

  /** Legacy values still have a scheme icon during migration. */
  it('shows the scheme icon for both high contrast modes', () => {
    const light = renderTheme('high-contrast-light', true);
    expect(screen.getByTestId('sun')).toBeInTheDocument();
    light.unmount();

    renderTheme('high-contrast-dark', true);
    expect(screen.getByTestId('moon')).toBeInTheDocument();
  });

  it('toggles theme when the button is activated', () => {
    // isDark('light') is false → next is dark
    const { setTheme } = renderTheme('light');
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_toggle_theme' }));
    expect(setTheme).toHaveBeenCalledWith('dark');
  });
});

describe('ThemeSelector scheme toggle', () => {
  it('flips a legacy contrast choice to a plain scheme', () => {
    const { setTheme } = renderTheme('high-contrast-light', true);
    fireEvent.click(screen.getByRole('button'));
    expect(setTheme).toHaveBeenCalledWith('dark');
  });

  it('never carries OS-requested contrast into the chosen scheme', () => {
    const { setTheme } = renderTheme('system', true);
    fireEvent.click(screen.getByRole('button'));
    expect(setTheme).toHaveBeenCalledWith('dark');
  });

  it('leaves an ordinary system mode on the plain schemes', () => {
    const { setTheme } = renderTheme('system', false);
    fireEvent.click(screen.getByRole('button'));
    expect(setTheme).toHaveBeenCalledWith('dark');
  });

  it('answers Ctrl+Shift+T with the same choice', () => {
    const { setTheme } = renderTheme('system', true);
    fireEvent.keyDown(window, { key: 'T', ctrlKey: true, shiftKey: true });
    expect(setTheme).toHaveBeenCalledWith('dark');
  });
});

describe('ThemeSelector auth controls', () => {
  it('offers only the scheme toggle, not an app contrast toggle', () => {
    const { setTheme } = renderAuthControls('dark');
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(
      screen.queryByRole('button', { name: 'com_ui_toggle_high_contrast' }),
    ).not.toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: 'com_ui_toggle_theme' });
    fireEvent.click(toggle);
    expect(setTheme).toHaveBeenCalledWith('light');
    expect(screen.getByRole('alert')).toHaveTextContent('com_ui_light_theme_enabled');
  });

  it('announces only a plain scheme under an OS contrast request', () => {
    const { setTheme } = renderAuthControls('system', true);
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_toggle_theme' }));
    expect(setTheme).toHaveBeenCalledWith('dark');
    expect(screen.getByRole('alert')).toHaveTextContent('com_ui_dark_theme_enabled');
  });

  it('still throttles held keyboard shortcuts', () => {
    const { setTheme } = renderAuthControls('light');
    fireEvent.keyDown(window, { key: 'T', ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: 'T', ctrlKey: true, shiftKey: true, repeat: true });
    expect(setTheme).toHaveBeenCalledTimes(1);
  });
});
