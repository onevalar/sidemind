import type { MeshPoint } from "../../gradient-mesh/gradient-mesh";

/**
 * The soft palette of the hero mesh, derived from the page accent in OKLCH. Light mode is mostly near white with gentle,
 * low chroma tints of the accent and two neighbours; dark mode is deep, desaturated and calm. A lighter (or, in dark mode,
 * quieter) pool sits behind the headline and the field, so the text always reads.
 */

type Rgb = [number, number, number];

/** Hue used when the accent has no chroma (the neutral accent): a calm blue violet. */
export const DEFAULT_HUE = 268;

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const toLinear = (c: number) => (c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
const toGamma = (c: number) => (c <= .0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - .055);

function oklchHex(l: number, c: number, h: number) {
  const hr = (h * Math.PI) / 180;
  const a = c * Math.cos(hr), b = c * Math.sin(hr);
  const l_ = (l + .3963377774 * a + .2158037573 * b) ** 3;
  const m_ = (l - .1055613458 * a - .0638541728 * b) ** 3;
  const s_ = (l - .0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [
    4.0767416621 * l_ - 3.3077115913 * m_ + .2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - .3413193965 * s_,
    -.0041960863 * l_ - .7034186147 * m_ + 1.707614701 * s_,
  ];
  return `#${rgb.map(v => Math.round(clamp(toGamma(clamp(v))) * 255).toString(16).padStart(2, "0")).join("")}`;
}

function toOklch([r, g, b]: Rgb): [number, number, number] {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
  const l = Math.cbrt(.4122214708 * lr + .5363325363 * lg + .0514459929 * lb);
  const m = Math.cbrt(.2119034982 * lr + .6806995451 * lg + .1073969566 * lb);
  const s = Math.cbrt(.0883024619 * lr + .2817188376 * lg + .6299787005 * lb);
  const L = .2104542553 * l + .793617785 * m - .0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + .4505937099 * s;
  const B = .0259040371 * l + .7827717662 * m - .808675766 * s;
  return [L, Math.hypot(A, B), ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360];
}

/** Resolves any CSS color (hex, rgb, oklch, color-mix) to sRGB through a 1px canvas. */
let probe: CanvasRenderingContext2D | null = null;
function resolveColor(value: string): Rgb | null {
  if (!value.trim()) return null;
  probe ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!probe) return null;
  probe.canvas.width = probe.canvas.height = 1;
  probe.fillStyle = "#000";
  probe.fillStyle = value.trim();
  probe.clearRect(0, 0, 1, 1);
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
  return [r / 255, g / 255, b / 255];
}

export interface HeroMeshPalette { base: string; points: MeshPoint[] }

/** Large, overlapping spreads at the edges, and the pool in the middle painted last so it always sits on top. */
const LAYOUT = [
  { id: "a", x: .06, y: .04, spread: 1.05 },
  { id: "b", x: .96, y: .1, spread: .95 },
  { id: "c", x: .94, y: .96, spread: 1 },
  { id: "d", x: .04, y: .94, spread: .9 },
  { id: "pool", x: .5, y: .48, spread: .62 },
];
/** Lightness, chroma, and hue offset from the accent for each point. */
const LIGHT: [number, number, number][] = [[.935, .042, 0], [.95, .032, 38], [.93, .04, -34], [.955, .026, 150], [.99, .004, 0]];
const DARK: [number, number, number][] = [[.29, .045, 0], [.26, .036, 38], [.27, .042, -34], [.23, .024, 150], [.18, .01, 0]];

export function heroMeshPalette(hue: number, dark: boolean): HeroMeshPalette {
  const spec = dark ? DARK : LIGHT;
  return {
    base: dark ? oklchHex(.175, .012, hue) : oklchHex(.982, .008, hue),
    points: LAYOUT.map((p, i) => ({ ...p, color: oklchHex(spec[i][0], spec[i][1], hue + spec[i][2]) })),
  };
}

/** Reads the theme and the accent hue from the computed style of an element. */
export function readHeroMesh(element: Element, hue?: number): HeroMeshPalette {
  const style = getComputedStyle(element);
  const bg = resolveColor(style.getPropertyValue("--background")) ?? [1, 1, 1];
  const dark = toOklch(bg)[0] < .5;
  let h = hue;
  if (h === undefined) {
    const accent = resolveColor(style.getPropertyValue("--accent"));
    const lch = accent ? toOklch(accent) : null;
    h = lch && lch[1] > .04 ? lch[2] : DEFAULT_HUE;
  }
  return heroMeshPalette(h, dark);
}
