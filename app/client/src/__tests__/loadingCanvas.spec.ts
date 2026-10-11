import { join } from 'node:path';
import { readFileSync } from 'node:fs';

/** The pre-React canvas is painted by an inline bootstrap in `index.html`, which
 *  no bundle imports, so the only way to hold it to the resolved palette is to
 *  run the script the document actually ships. */
const bootstrap = (() => {
  const html = readFileSync(join(__dirname, '..', '..', 'index.html'), 'utf8');
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map(([, body]) => body)
    .find((body) => body.includes('#loading-container'));

  if (!script) {
    throw new Error('index.html no longer carries a #loading-container bootstrap');
  }

  return script;
})();

const canvasFor = (stored: string | null, matching: string[]): string | undefined => {
  window.localStorage.clear();
  if (stored !== null) {
    window.localStorage.setItem('color-theme', stored);
  }
  window.matchMedia = ((query: string) =>
    ({ matches: matching.includes(query) }) as MediaQueryList) as typeof window.matchMedia;
  document.head.querySelectorAll('style').forEach((node) => node.remove());

  new Function(bootstrap)();

  return document.head
    .querySelector('style')
    ?.innerHTML.match(/background-color:\s*([^;\s]+)/)?.[1];
};

const DARK_SCHEME = '(prefers-color-scheme: dark)';
const MORE_CONTRAST = '(prefers-contrast: more)';
const CUSTOM_CONTRAST = '(prefers-contrast: custom)';
const FORCED_COLORS = '(forced-colors: active)';

describe('loading canvas', () => {
  it.each([
    ['high-contrast-dark', [], '#0d0d0d'],
    ['high-contrast-light', [], '#ffffff'],
    ['dark', [], '#0d0d0d'],
    ['light', [], '#ffffff'],
  ])('paints the stored %s mode', (stored, matching, expected) => {
    expect(canvasFor(stored, matching as string[])).toBe(expected);
  });

  it('follows only the OS color scheme under system', () => {
    expect(canvasFor('system', [DARK_SCHEME, MORE_CONTRAST])).toBe('#0d0d0d');
    expect(canvasFor('system', [DARK_SCHEME])).toBe('#0d0d0d');
    expect(canvasFor('system', [MORE_CONTRAST])).toBe('#ffffff');
    expect(canvasFor('system', [])).toBe('#ffffff');
  });

  it('leaves forced colors to the browser instead of selecting an app palette', () => {
    expect(canvasFor('system', [DARK_SCHEME, CUSTOM_CONTRAST, FORCED_COLORS])).toBe('#0d0d0d');
    expect(canvasFor('system', [DARK_SCHEME, FORCED_COLORS])).toBe('#0d0d0d');
  });

  /** An unset or unrecognised value is what `getInitialTheme` resolves as
   *  `system`, so the canvas has to resolve it the same way. */
  it('treats an unset or unknown mode as system', () => {
    expect(canvasFor(null, [DARK_SCHEME])).toBe('#0d0d0d');
    expect(canvasFor(null, [DARK_SCHEME, MORE_CONTRAST])).toBe('#0d0d0d');
    expect(canvasFor('sepia', [DARK_SCHEME, MORE_CONTRAST])).toBe('#0d0d0d');
  });
});
