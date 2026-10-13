import { motionTokens } from "../../lib/motion-tokens";
import { COLS, COUNT, DAYS, ROWS, cellOf, type Cell } from "./terrain-data";

/**
 * A 7 by 24 bar terrain drawn on canvas 2D with its own perspective camera and spring integrator.
 * Everything that moves per frame lives here in typed arrays; React only hears about discrete changes.
 */
export type TerrainEvents = { onHover(cell: Cell | null): void; onPick(cell: Cell | null): void; onMoved(moved: boolean): void };
export type Terrain = {
  setValues(norm: readonly number[], tone: number, origin: Cell | null): void;
  setView(top: boolean): void;
  setFocus(cell: Cell | null): void;
  setActive(cell: Cell | null): void;
  orbit(dYaw: number, dPitch: number): void;
  zoom(factor: number): void;
  reset(): void;
  destroy(): void;
};
type Parts = { root: HTMLElement; plot: HTMLElement; canvas: HTMLCanvasElement; panel: HTMLElement };
type Rgb = [number, number, number];
type Cfg = { k: number; c: number };
type Param = { x: number; v: number; to: number; cfg: Cfg; mode: "spring" | "coast" | "held"; eps: number };

const DEG = Math.PI / 180;
/** World units: one cell is 1, a full-scale bar is H tall. */
const H = 5.4, FOOT = .4, MIN_H = .035, LIFT = .42, DIST = 42;
const HALF_W = COLS / 2, HALF_D = ROWS / 2;
const HOME = { yaw: -32 * DEG, narrowYaw: -50 * DEG, pitch: 30 * DEG, ty: H * .16 };
const INTRO = { yaw: -6 * DEG, pitch: 76 * DEG, zoom: .84 };
const PITCH: [number, number] = [10 * DEG, 84 * DEG];
const TOP: [number, number] = [90 * DEG, 90 * DEG];
const ZOOM: [number, number] = [.7, 2.8];
/** Velocity decay per second while the camera coasts after a throw. */
const FRICTION = 3.2, STEP = 1 / 240, SENS_PITCH = .0055;
/** Light from the upper left front; side faces darken by how far they turn away from it. */
const LIGHT = [-.52, .74, .42];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (e0: number, e1: number, x: number) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
/** Apple's rubber band: resistance grows the further you pull past the edge. */
const rubber = (over: number, dim: number) => (1 - 1 / ((over * .55) / dim + 1)) * dim;
const band = (x: number, [lo, hi]: [number, number], dim: number) => x < lo ? lo - rubber(lo - x, dim) : x > hi ? hi + rubber(x - hi, dim) : x;
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** The same visualDuration and bounce mapping Motion uses, so canvas springs match the DOM ones. */
export function springOf({ visualDuration, bounce }: { visualDuration: number; bounce: number }): Cfg {
  const root = (2 * Math.PI) / (visualDuration * 1.2), k = root * root;
  return { k, c: 2 * clamp(1 - bounce, .05, 1) * Math.sqrt(k) };
}
const { spring } = motionTokens;
const CFG = {
  rise: springOf({ visualDuration: .7, bounce: .24 }),
  morph: springOf(spring.morph),
  camera: springOf({ ...spring.smooth, visualDuration: .9 }),
  intro: springOf({ ...spring.smooth, visualDuration: 1.7 }),
  zoom: springOf({ ...spring.smooth, visualDuration: .36 }),
  back: springOf({ ...spring.smooth, visualDuration: .5 }),
  lift: springOf(spring.snappy),
  dim: springOf({ ...spring.smooth, visualDuration: .24 }),
  tone: springOf({ ...spring.smooth, visualDuration: .5 }),
  panel: springOf({ visualDuration: .2, bounce: 0 }),
  frame: springOf({ ...spring.smooth, visualDuration: .6 }),
};

const param = (x: number, cfg: Cfg, eps: number): Param => ({ x, v: 0, to: x, cfg, mode: "spring", eps });
function go(p: Param, to: number, cfg: Cfg, instant: boolean) {
  p.to = to; p.cfg = cfg; p.mode = "spring";
  if (instant) { p.x = to; p.v = 0; }
}

/* Colors: CSS variables resolve through a 1 px canvas, ramps interpolate in OKLab. */
const lin = (c: number) => { c /= 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; };
const gam = (c: number) => 255 * clamp(c <= .0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - .055, 0, 1);
function toLab([r8, g8, b8]: Rgb): Rgb {
  const r = lin(r8), g = lin(g8), b = lin(b8);
  const l = Math.cbrt(.4122214708 * r + .5363325363 * g + .0514459929 * b), m = Math.cbrt(.2119034982 * r + .6806995451 * g + .1073969566 * b), s = Math.cbrt(.0883024619 * r + .2817188376 * g + .6299787005 * b);
  return [.2104542553 * l + .793617785 * m - .0040720468 * s, 1.9779984951 * l - 2.428592205 * m + .4505937099 * s, .0259040371 * l + .7827717662 * m - .808675766 * s];
}
function fromLab([L, A, B]: Rgb): Rgb {
  const l = (L + .3963377774 * A + .2158037573 * B) ** 3, m = (L - .1055613458 * A - .0638541728 * B) ** 3, s = (L - .0894841775 * A - 1.291485548 * B) ** 3;
  return [gam(4.0767416621 * l - 3.3077115913 * m + .2309699292 * s), gam(-1.2684380046 * l + 2.6097574011 * m - .3413193965 * s), gam(-.0041960863 * l - .7034186147 * m + 1.707614701 * s)];
}
const mixLab = (a: Rgb, b: Rgb, t: number) => { const x = toLab(a), y = toLab(b); return fromLab([lerp(x[0], y[0], t), lerp(x[1], y[1], t), lerp(x[2], y[2], t)]); };
const RAMP = 64;
function fillRamp(out: Float32Array, low: Rgb, high: Rgb) {
  for (let i = 0; i <= RAMP; i++) { const c = mixLab(low, high, (i / RAMP) ** .9); out.set(c, i * 3); }
}
const css = (r: number, g: number, b: number, a = 1) => a >= 1 ? `rgb(${r | 0} ${g | 0} ${b | 0})` : `rgb(${r | 0} ${g | 0} ${b | 0} / ${a.toFixed(3)})`;

/** Wave position along time, then down the week: 0 at Monday 00:00, 1 at Sunday 23:00. */
const ROW = Uint8Array.from({ length: COUNT }, (_, i) => Math.floor(i / COLS)), COL = Uint8Array.from({ length: COUNT }, (_, i) => i % COLS);
const WAVE = Float64Array.from({ length: COUNT }, (_, i) => (COL[i] / (COLS - 1)) * .78 + (ROW[i] / (ROWS - 1)) * .22);
const colX = (h: number) => h - (COLS - 1) / 2, rowZ = (d: number) => d - (ROWS - 1) / 2;
const idx = (c: Cell) => c.d * COLS + c.h;
const hourText = (h: number) => `${String(h).padStart(2, "0")}:00`;

export function createTerrain({ root, plot, canvas, panel }: Parts, events: TerrainEvents, init: { norm: readonly number[]; tone: number }): Terrain {
  const ctx = canvas.getContext("2d");
  const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  let reduce = motionQuery.matches;
  let w = 0, hgt = 0, dpr = 1, narrow = false, top = false, introduced = false, visible = false, moved = false;
  let active: Cell | null = null, focus: Cell | null = null, hoverIdx = -1, panelShown = false, pw = 208, ph = 150;

  const norm = Float64Array.from(init.norm);
  const hx = new Float64Array(COUNT), hv = new Float64Array(COUNT), hto = new Float64Array(COUNT), delay = new Float64Array(COUNT);
  const lx = new Float64Array(COUNT), lv = new Float64Array(COUNT), lto = new Float64Array(COUNT);
  const mx = new Float64Array(COUNT), mv = new Float64Array(COUNT), mto = new Float64Array(COUNT);
  let hcfg = CFG.rise;
  /** Phones look along the week at a steeper angle so the long hour axis recedes instead of shrinking. */
  const homeYaw = () => narrow ? HOME.narrowYaw : HOME.yaw;

  const yaw = param(INTRO.yaw, CFG.camera, 1e-4), pitch = param(INTRO.pitch, CFG.camera, 1e-4), zoom = param(INTRO.zoom, CFG.camera, 1e-4);
  const tx = param(0, CFG.camera, 1e-3), ty = param(HOME.ty, CFG.camera, 1e-3), tz = param(0, CFG.camera, 1e-3);
  const flat = param(0, CFG.camera, 1e-4), tone = param(init.tone, CFG.tone, 1e-3);
  const px = param(0, CFG.panel, .05), py = param(0, CFG.panel, .05);
  const fitF = param(0, CFG.frame, .01), fitX = param(0, CFG.frame, .05), fitY = param(0, CFG.frame, .05);
  const params = [yaw, pitch, zoom, tx, ty, tz, flat, tone, px, py, fitF, fitX, fitY];

  // Per frame geometry kept for hit testing and the value panel.
  const order = Array.from({ length: COUNT }, (_, i) => i);
  const dist2 = new Float64Array(COUNT), faces = new Float64Array(COUNT * 24), faceCount = new Uint8Array(COUNT), tops = new Float64Array(COUNT * 2);
  const pts = new Float64Array(16), depth = new Float64Array(8);

  // Theme
  const rampA = new Float32Array((RAMP + 1) * 3), rampB = new Float32Array((RAMP + 1) * 3);
  let bg: Rgb = [255, 255, 255], fg: Rgb = [20, 20, 20], muted: Rgb = [120, 120, 120], floor: Rgb = [245, 245, 245], edge: Rgb = [230, 230, 230], font = "sans-serif";
  const probe = document.createElement("canvas");
  probe.width = probe.height = 1;
  const pctx = probe.getContext("2d", { willReadFrequently: true });
  function rgb(value: string, fallback: Rgb): Rgb {
    if (!pctx || !value) return fallback;
    pctx.clearRect(0, 0, 1, 1);
    pctx.fillStyle = "#000";
    pctx.fillStyle = value;
    pctx.fillRect(0, 0, 1, 1);
    const d = pctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2]];
  }
  function readTheme() {
    const cs = getComputedStyle(root), v = (name: string, fallback: Rgb) => rgb(cs.getPropertyValue(name).trim(), fallback);
    bg = v("--surface", bg); fg = v("--foreground", fg); muted = v("--text-muted", muted);
    const soft = v("--surface-muted", floor), strong = v("--border-strong", edge);
    edge = v("--border", edge);
    floor = mixLab(bg, soft, .75);
    const low = mixLab(soft, strong, .5);
    fillRamp(rampA, low, v("--accent", fg));
    fillRamp(rampB, low, v("--danger", [200, 60, 50]));
    font = cs.fontFamily || font;
  }

  /* Camera, rebuilt every frame from the springs. */
  const cam = { cx: 0, cy: 0, cz: 0, rx: 1, rz: 0, ux: 0, uy: 1, uz: 0, fx: 0, fy: 0, fz: -1, focal: 1, ox: 0, oy: 0, dist: DIST };
  let framed = false;
  function updateCamera() {
    const fl = flat.x, sy = Math.sin(yaw.x), cy = Math.cos(yaw.x), sp = Math.sin(pitch.x), cp = Math.cos(pitch.x);
    // Top view backs the camera away while the framing scales up to compensate: a dolly zoom that flattens perspective into a heatmap.
    const dist = DIST * (1 + 2.8 * fl), hy = HOME.ty * (1 - fl), squash = H * (1 - .975 * fl);
    // Framing is measured from a fixed heading, so orbiting feels rigid while tilt, flattening and new data reframe the shot.
    const fyaw = lerp(homeYaw(), 0, fl), s0 = Math.sin(fyaw), c0 = Math.cos(fyaw);
    const ex = dist * s0 * cp, ey = hy + dist * sp, ez = dist * c0 * cp;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    const extend = (x: number, y: number, z: number) => {
      const dx = x - ex, dy = y - ey, dz = z - ez, Z = Math.max(.5, -dx * s0 * cp - dy * sp - dz * c0 * cp);
      const X = (dx * c0 - dz * s0) / Z, Y = (-dx * s0 * sp + dy * cp - dz * c0 * sp) / Z;
      x0 = Math.min(x0, X); x1 = Math.max(x1, X); y0 = Math.min(y0, Y); y1 = Math.max(y1, Y);
    };
    for (let k = 0; k < 4; k++) extend((k & 1 ? 1 : -1) * (HALF_W + 1.3), 0, (k & 2 ? 1 : -1) * (HALF_D + 1.2));
    for (let i = 0; i < COUNT; i++) extend(colX(COL[i]), Math.max(hto[i], 0) * squash, rowZ(ROW[i]));
    const padX = narrow ? 18 : 26, padY = 18;
    const F = Math.max(1, Math.min((w - padX * 2) / (x1 - x0), (hgt - padY * 2) / (y1 - y0)));
    const OX = w / 2 - (F * (x0 + x1)) / 2, OY = hgt / 2 + (F * (y0 + y1)) / 2;
    if (!framed || reduce) { go(fitF, F, CFG.frame, true); go(fitX, OX, CFG.frame, true); go(fitY, OY, CFG.frame, true); framed = true; }
    else if (Math.abs(fitF.to - F) > .01 || Math.abs(fitX.to - OX) > .05 || Math.abs(fitY.to - OY) > .05) { fitF.to = F; fitX.to = OX; fitY.to = OY; kick(); }
    Object.assign(cam, {
      cx: tx.x + dist * sy * cp, cy: ty.x * (1 - fl) + dist * sp, cz: tz.x + dist * cy * cp,
      rx: cy, rz: -sy, ux: -sy * sp, uy: cp, uz: -cy * sp, fx: -sy * cp, fy: -sp, fz: -cy * cp,
      focal: fitF.x * zoom.x, ox: fitX.x, oy: fitY.x, dist,
    });
  }
  function project(x: number, y: number, z: number, out: Float64Array, k: number) {
    const dx = x - cam.cx, dy = y - cam.cy, dz = z - cam.cz;
    const Z = dx * cam.fx + dy * cam.fy + dz * cam.fz, s = cam.focal / Math.max(Z, .5);
    out[k] = cam.ox + (dx * cam.rx + dz * cam.rz) * s;
    out[k + 1] = cam.oy - (dx * cam.ux + dy * cam.uy + dz * cam.uz) * s;
    return Z;
  }
  const scratch = new Float64Array(8);
  function quad(a: [number, number, number], b: [number, number, number], c: [number, number, number], d: [number, number, number]) {
    if (!ctx) return;
    project(...a, scratch, 0); project(...b, scratch, 2); project(...c, scratch, 4); project(...d, scratch, 6);
    ctx.beginPath();
    ctx.moveTo(scratch[0], scratch[1]); ctx.lineTo(scratch[2], scratch[3]); ctx.lineTo(scratch[4], scratch[5]); ctx.lineTo(scratch[6], scratch[7]);
    ctx.closePath();
  }
  function line(a: [number, number, number], b: [number, number, number]) {
    if (!ctx) return;
    project(...a, scratch, 0); project(...b, scratch, 2);
    ctx.beginPath(); ctx.moveTo(scratch[0], scratch[1]); ctx.lineTo(scratch[2], scratch[3]);
  }

  function draw() {
    if (!ctx || !w || !hgt) return;
    updateCamera();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    const fl = flat.x, show = active ?? focus, sy = Math.sin(yaw.x), cy = Math.cos(yaw.x);
    // Axis labels sit on whichever edges face the camera, crossfading as it orbits past them.
    const right = smooth(.15, .45, sy), back = smooth(-.15, -.45, cy);
    const sideX = right > .5 ? 1 : -1, sideZ = back > .5 ? -1 : 1;

    // Floor plate and the crosshair lanes that run from the active bar out to its axes.
    ctx.fillStyle = css(...floor);
    quad([-HALF_W - .3, 0, -HALF_D - .3], [HALF_W + .3, 0, -HALF_D - .3], [HALF_W + .3, 0, HALF_D + .3], [-HALF_W - .3, 0, HALF_D + .3]);
    ctx.fill();
    if (show) {
      const x = colX(show.h), z = rowZ(show.d), ex = sideX * (HALF_W + .55), ez = sideZ * (HALF_D + .55);
      ctx.fillStyle = css(...fg, .05);
      quad([Math.min(x, ex), 0, z - .5], [Math.max(x, ex), 0, z - .5], [Math.max(x, ex), 0, z + .5], [Math.min(x, ex), 0, z + .5]); ctx.fill();
      quad([x - .5, 0, Math.min(z, ez)], [x + .5, 0, Math.min(z, ez)], [x + .5, 0, Math.max(z, ez)], [x - .5, 0, Math.max(z, ez)]); ctx.fill();
      ctx.strokeStyle = css(...fg, .55); ctx.lineWidth = 1;
      line([x, 0, z], [ex, 0, z]); ctx.stroke();
      line([x, 0, z], [x, 0, ez]); ctx.stroke();
    }

    // Painter's order: equal footprints on a grid sort cleanly by horizontal distance from the camera.
    for (let i = 0; i < COUNT; i++) dist2[i] = (colX(COL[i]) - cam.cx) ** 2 + (rowZ(ROW[i]) - cam.cz) ** 2;
    order.sort((a, b) => dist2[b] - dist2[a]);
    const toneK = clamp(tone.x, 0, 1);
    for (const i of order) drawBar(i, fl, toneK, show);
    if (show) strokeOutline(.5, true);

    drawLabels(right, back, show);
    placePanel(show);
  }

  function drawBar(i: number, fl: number, toneK: number, show: Cell | null) {
    if (!ctx) return;
    const d = ROW[i], h = COL[i], cx = colX(h), cz = rowZ(d);
    // Flattening sweeps along time so the terrain melts into the heatmap instead of dropping all at once.
    const f = smooth(0, 1, (fl - WAVE[i] * .3) / .7);
    const value = clamp(hx[i], 0, 1.25), height = Math.max(MIN_H, value * H * (1 - .975 * f));
    const y0 = lx[i], y1 = y0 + height, x0 = cx - FOOT, x1 = cx + FOOT, z0 = cz - FOOT, z1 = cz + FOOT;
    for (let k = 0; k < 8; k++) depth[k] = project(k & 1 ? x1 : x0, k & 2 ? y1 : y0, k & 4 ? z1 : z0, pts, k * 2);

    if (y0 > .005) {
      ctx.fillStyle = css(...fg, .1 * clamp(y0 / LIFT, 0, 1));
      quad([x0, 0, z0], [x1, 0, z0], [x1, 0, z1], [x0, 0, z1]); ctx.fill();
    }

    const t = clamp(value, 0, 1) * RAMP, k0 = Math.floor(t), k1 = Math.min(RAMP, k0 + 1), kf = t - k0;
    const base: Rgb = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const a = lerp(rampA[k0 * 3 + c], rampA[k1 * 3 + c], kf), b = lerp(rampB[k0 * 3 + c], rampB[k1 * 3 + c], kf);
      base[c] = lerp(a, b, toneK);
    }
    const Z = (depth[0] + depth[7]) / 2, fog = clamp((Z - (cam.dist - 6)) / 34, 0, 1) * .2;
    const fade = clamp(mx[i], 0, 1) * .72 + fog;
    const shade = (dark: number) => {
      const r = base[0] * (1 - dark), g = base[1] * (1 - dark), b = base[2] * (1 - dark);
      return css(lerp(r, bg[0], fade), lerp(g, bg[1], fade), lerp(b, bg[2], fade));
    };

    let n = 0;
    const face = (a: number, b: number, c: number, e: number, dark: number) => {
      const color = shade(dark);
      ctx.fillStyle = color; ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(pts[a * 2], pts[a * 2 + 1]); ctx.lineTo(pts[b * 2], pts[b * 2 + 1]); ctx.lineTo(pts[c * 2], pts[c * 2 + 1]); ctx.lineTo(pts[e * 2], pts[e * 2 + 1]);
      ctx.closePath(); ctx.fill(); ctx.stroke();
      const o = i * 24 + n * 8;
      faces[o] = pts[a * 2]; faces[o + 1] = pts[a * 2 + 1]; faces[o + 2] = pts[b * 2]; faces[o + 3] = pts[b * 2 + 1];
      faces[o + 4] = pts[c * 2]; faces[o + 5] = pts[c * 2 + 1]; faces[o + 6] = pts[e * 2]; faces[o + 7] = pts[e * 2 + 1];
      n++;
    };
    const side = (dot: number) => .24 - .2 * dot;
    ctx.lineWidth = .6; ctx.lineJoin = "round";
    if (cam.cx < x0) face(0, 2, 6, 4, side(-LIGHT[0]));
    else if (cam.cx > x1) face(1, 3, 7, 5, side(LIGHT[0]));
    if (cam.cz < z0) face(0, 1, 3, 2, side(-LIGHT[2]));
    else if (cam.cz > z1) face(4, 5, 7, 6, side(LIGHT[2]));
    if (cam.cy > y1) face(2, 3, 7, 6, 0);
    faceCount[i] = n;
    project(cx, y1, cz, tops, i * 2);

    if (show && show.d === d && show.h === h) {
      outline.set([pts[4], pts[5], pts[6], pts[7], pts[14], pts[15], pts[12], pts[13]]);
      strokeOutline(.9, false);
    }
  }

  /** The active bar's top edge; drawn again dashed over everything, so a bar hidden behind taller ones still shows where it is. */
  const outline = new Float64Array(8);
  function strokeOutline(alpha: number, xray: boolean) {
    if (!ctx) return;
    ctx.strokeStyle = css(...fg, alpha); ctx.lineWidth = 1.25;
    ctx.setLineDash(xray ? [3, 3] : []);
    ctx.beginPath();
    ctx.moveTo(outline[0], outline[1]); ctx.lineTo(outline[2], outline[3]); ctx.lineTo(outline[4], outline[5]); ctx.lineTo(outline[6], outline[7]);
    ctx.closePath(); ctx.stroke();
    ctx.setLineDash([]);
  }
  function label(text: string, x: number, y: number, z: number, alpha: number, on: boolean) {
    if (!ctx || alpha < .02) return;
    project(x, y, z, scratch, 0);
    const sx = scratch[0], sy = scratch[1];
    if (on) {
      ctx.font = `500 11px ${font}`;
      const tw = ctx.measureText(text).width;
      ctx.fillStyle = css(...fg, alpha);
      ctx.beginPath();
      ctx.roundRect(sx - tw / 2 - 7, sy - 10, tw + 14, 20, 10);
      ctx.fill();
      ctx.fillStyle = css(...bg, alpha);
    } else {
      ctx.font = `400 11px ${font}`;
      ctx.fillStyle = css(...muted, alpha);
    }
    ctx.fillText(text, sx, sy + .5);
  }
  /** The smallest label step whose spacing on screen clears the label's footprint along that axis. */
  function axisStep(gaps: number, tw: number, th: number, steps: readonly number[]) {
    const dx = (scratch[2] - scratch[0]) / gaps, dy = (scratch[3] - scratch[1]) / gaps, len = Math.hypot(dx, dy) || 1e-6;
    const need = (Math.abs(dx) / len) * tw + (Math.abs(dy) / len) * th + 6;
    return steps.find(s => len * s >= need) ?? 0;
  }
  function drawLabels(right: number, back: number, show: Cell | null) {
    if (!ctx) return;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    for (const [side, a] of [[-1, 1 - right], [1, right]] as const) {
      if (a < .02) continue;
      const x = side * (HALF_W + 1.25);
      project(x, 0, rowZ(0), scratch, 0); project(x, 0, rowZ(ROWS - 1), scratch, 2);
      const step = axisStep(ROWS - 1, 24, 13, [1, 2, 3]) || 6;
      for (let d = 0; d < ROWS; d++) {
        const on = show?.d === d;
        if (!on && (d % step || (show && step > 1 && Math.abs(d - show.d) < step))) continue;
        label(DAYS[d], x, 0, rowZ(d), a, on);
      }
    }
    for (const [side, a] of [[-1, back], [1, 1 - back]] as const) {
      if (a < .02) continue;
      const z = side * (HALF_D + 1.05);
      project(colX(0), 0, z, scratch, 0); project(colX(COLS - 1), 0, z, scratch, 2);
      // Full times when there is room, bare hours when the axis is foreshortened.
      const long = axisStep(COLS - 1, 34, 13, [3]) > 0, step = axisStep(COLS - 1, long ? 34 : 17, 13, [3, 6, 12]) || 12;
      for (let h = 0; h < COLS; h++) {
        const on = show?.h === h;
        if (!on && (h % step || (show && Math.abs(h - show.h) < step * .67))) continue;
        label(long || on ? hourText(h) : String(h).padStart(2, "0"), colX(h), 0, z, a, on);
      }
    }
  }


  function placePanel(show: Cell | null) {
    if (!show) { panelShown = false; return; }
    const i = idx(show), sx = tops[i * 2], sy = tops[i * 2 + 1];
    let left = sx + 22;
    if (left + pw > w - 8) left = sx - 22 - pw;
    left = clamp(left, 8, Math.max(8, w - pw - 8));
    // Above and beside the bar when there is room, otherwise level with its top; never over the bar itself.
    let y = sy - ph - 16;
    if (y < 8) y = sy - ph * .45;
    y = clamp(y, 8, Math.max(8, hgt - ph - 8));
    px.to = left; py.to = y;
    // A panel that appears starts beside its bar; only later moves glide.
    if (!panelShown || reduce) { px.x = left; py.x = y; px.v = py.v = 0; panelShown = true; }
    else if (Math.abs(px.x - left) > .05 || Math.abs(py.x - y) > .05) kick();
    panel.style.transform = `translate3d(${px.x.toFixed(2)}px, ${py.x.toFixed(2)}px, 0)`;
  }

  /* Simulation */
  function stepParam(p: Param, dt: number) {
    if (p.mode === "spring") { p.v += (-p.cfg.k * (p.x - p.to) - p.cfg.c * p.v) * dt; p.x += p.v * dt; }
    else if (p.mode === "coast") { p.x += p.v * dt; p.v *= Math.exp(-FRICTION * dt); }
  }
  const limits = (p: Param): [number, number] | null => p === pitch ? (top ? TOP : PITCH) : p === yaw ? (top ? [0, 0] : null) : p === zoom ? ZOOM : null;
  function step(dt: number) {
    let busy = !!drag || !!pinch;
    for (let i = 0; i < COUNT; i++) if (delay[i] > 0) { delay[i] -= dt; busy = true; }
    const n = Math.max(1, Math.ceil(dt / STEP)), s = dt / n;
    for (let k = 0; k < n; k++) {
      for (const p of params) {
        stepParam(p, s);
        const lim = p.mode === "coast" ? limits(p) : null;
        // A throw that runs past a limit hands its velocity to a spring, so it bounces off the edge.
        if (lim && (p.x < lim[0] || p.x > lim[1])) { p.mode = "spring"; p.to = clamp(p.x, lim[0], lim[1]); p.cfg = CFG.back; }
      }
      for (let i = 0; i < COUNT; i++) {
        if (delay[i] <= 0) { hv[i] += (-hcfg.k * (hx[i] - hto[i]) - hcfg.c * hv[i]) * s; hx[i] += hv[i] * s; }
        lv[i] += (-CFG.lift.k * (lx[i] - lto[i]) - CFG.lift.c * lv[i]) * s; lx[i] += lv[i] * s;
        mv[i] += (-CFG.dim.k * (mx[i] - mto[i]) - CFG.dim.c * mv[i]) * s; mx[i] += mv[i] * s;
      }
    }
    for (const p of params) {
      if (p.mode === "held") continue;
      if (p.mode === "coast") { if (Math.abs(p.v) < .01) { p.mode = "spring"; p.to = p.x; p.v = 0; } else busy = true; continue; }
      if (Math.abs(p.x - p.to) < p.eps && Math.abs(p.v) < p.eps * 10) { p.x = p.to; p.v = 0; } else busy = true;
    }
    for (let i = 0; i < COUNT; i++) {
      if (Math.abs(hx[i] - hto[i]) < 1e-4 && Math.abs(hv[i]) < 1e-3) { hx[i] = hto[i]; hv[i] = 0; } else busy = true;
      if (Math.abs(lx[i] - lto[i]) < 1e-4 && Math.abs(lv[i]) < 1e-3) { lx[i] = lto[i]; lv[i] = 0; } else busy = true;
      if (Math.abs(mx[i] - mto[i]) < 1e-4 && Math.abs(mv[i]) < 1e-3) { mx[i] = mto[i]; mv[i] = 0; } else busy = true;
    }
    return busy;
  }

  let raf = 0, last = 0;
  function frame(now: number) {
    raf = 0;
    const dt = Math.min(.05, Math.max(0, (now - last) / 1000));
    last = now;
    const busy = step(dt);
    draw();
    // Drawing can ask for another frame itself (a panel that must catch up), so never queue two.
    if (busy && !raf && visible && !document.hidden) raf = requestAnimationFrame(frame);
  }
  function kick() {
    if (raf || !visible || document.hidden) return;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }

  function emphasize() {
    const show = active ?? focus;
    for (let i = 0; i < COUNT; i++) {
      const d = ROW[i], h = COL[i], on = !!show && d === show.d && h === show.h;
      mto[i] = !show || d === show.d || h === show.h ? 0 : active ? .36 : .5;
      lto[i] = on ? LIFT : 0;
      if (reduce) { mx[i] = mto[i]; lx[i] = lto[i]; mv[i] = lv[i] = 0; }
    }
    kick();
  }
  function markMoved() { if (!moved) { moved = true; events.onMoved(true); } }

  function intro() {
    if (introduced) return;
    introduced = true;
    hcfg = CFG.rise;
    for (let i = 0; i < COUNT; i++) {
      hto[i] = norm[i];
      if (reduce) { hx[i] = norm[i]; delay[i] = 0; } else delay[i] = WAVE[i] * .8;
    }
    const cfg = reduce ? CFG.camera : CFG.intro;
    if (!top) { go(yaw, homeYaw(), cfg, reduce); go(pitch, HOME.pitch, cfg, reduce); }
    if (!focus) go(zoom, 1, cfg, reduce);
    kick();
  }

  /* Input */
  type Drag = { id: number; x0: number; y0: number; yaw0: number; pitch0: number; moved: boolean; touch: boolean; caught: boolean; samples: { t: number; x: number; y: number }[] };
  let drag: Drag | null = null, pinch: { d0: number; z0: number } | null = null;
  const pointers = new Map<number, { x: number; y: number }>();
  const local = (e: PointerEvent | WheelEvent) => { const r = plot.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const sensYaw = () => (Math.PI * 1.1) / Math.max(360, w);

  function hitTest(x: number, y: number) {
    for (let k = COUNT - 1; k >= 0; k--) {
      const i = order[k];
      for (let f = 0; f < faceCount[i]; f++) {
        const o = i * 24 + f * 8;
        let pos = 0, neg = 0;
        for (let e = 0; e < 4; e++) {
          const ax = faces[o + e * 2], ay = faces[o + e * 2 + 1], bx = faces[o + ((e + 1) % 4) * 2], by = faces[o + ((e + 1) % 4) * 2 + 1];
          const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
          if (cross > 0) pos++; else if (cross < 0) neg++;
        }
        if (!pos || !neg) return i;
      }
    }
    return -1;
  }
  function hover(i: number) {
    if (i === hoverIdx) return;
    hoverIdx = i;
    active = i < 0 ? null : cellOf(i);
    plot.toggleAttribute("data-over", i >= 0);
    emphasize();
    events.onHover(active);
  }
  function release(p: Param, v: number) {
    const lim = limits(p) ?? [-Infinity, Infinity];
    v = reduce ? 0 : clamp(v, -14, 14);
    if (p.x < lim[0] || p.x > lim[1]) { p.mode = "spring"; p.to = clamp(p.x, lim[0], lim[1]); p.cfg = CFG.back; p.v = v; if (reduce) { p.x = p.to; p.v = 0; } }
    else if (Math.abs(v) > .05) { p.mode = "coast"; p.v = v; }
    else { p.mode = "spring"; p.to = p.x; p.v = 0; }
  }

  function onDown(e: PointerEvent) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const p = local(e);
    pointers.set(e.pointerId, p);
    try { plot.setPointerCapture(e.pointerId); } catch { /* capture is best effort */ }
    intro();
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, z0: zoom.x };
      drag = null; plot.removeAttribute("data-dragging");
      return;
    }
    if (pointers.size > 2) return;
    // Touching a coasting terrain catches it.
    const caught = yaw.mode === "coast" || pitch.mode === "coast";
    if (caught) { yaw.mode = pitch.mode = "held"; yaw.v = pitch.v = 0; yaw.to = yaw.x; pitch.to = pitch.x; }
    drag = { id: e.pointerId, x0: p.x, y0: p.y, yaw0: yaw.x, pitch0: pitch.x, moved: false, touch: e.pointerType === "touch", caught, samples: [{ t: e.timeStamp, ...p }] };
  }
  function onMove(e: PointerEvent) {
    const p = local(e);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      zoom.mode = "held"; zoom.v = 0;
      zoom.x = zoom.to = band((pinch.z0 * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.d0, ZOOM, .5);
      markMoved(); kick();
      return;
    }
    if (drag && drag.id === e.pointerId) {
      if (!drag.moved && Math.hypot(p.x - drag.x0, p.y - drag.y0) > (drag.touch ? 8 : 4)) {
        Object.assign(drag, { moved: true, x0: p.x, y0: p.y, yaw0: yaw.x, pitch0: pitch.x });
        hover(-1);
        plot.setAttribute("data-dragging", "");
      }
      if (!drag.moved) return;
      yaw.mode = "held"; yaw.v = 0;
      yaw.x = yaw.to = band(drag.yaw0 - (p.x - drag.x0) * sensYaw(), limits(yaw) ?? [-Infinity, Infinity], .5);
      // Touch keeps vertical swipes for page scroll, so only mice and pens tilt the camera.
      if (!drag.touch) { pitch.mode = "held"; pitch.v = 0; pitch.x = pitch.to = band(drag.pitch0 + (p.y - drag.y0) * SENS_PITCH, limits(pitch) ?? PITCH, .4); }
      drag.samples.push({ t: e.timeStamp, x: p.x, y: p.y });
      while (drag.samples.length > 2 && e.timeStamp - drag.samples[0].t > 100) drag.samples.shift();
      if (!top) markMoved();
      kick();
      return;
    }
    if (e.pointerType === "mouse" && !pointers.size) hover(hitTest(p.x, p.y));
  }
  function onUp(e: PointerEvent) {
    const p = local(e), cancelled = e.type === "pointercancel";
    pointers.delete(e.pointerId);
    if (pinch) {
      if (pointers.size < 2) { pinch = null; go(zoom, clamp(zoom.x, ...ZOOM), CFG.back, reduce); kick(); }
      drag = null;
      return;
    }
    if (!drag || drag.id !== e.pointerId) return;
    const d = drag;
    drag = null;
    plot.removeAttribute("data-dragging");
    if (d.moved) {
      const s = d.samples, a = s[0], b = s[s.length - 1], span = (b.t - a.t) / 1000;
      const fresh = span > .005 && e.timeStamp - b.t < 60;
      release(yaw, fresh ? (-(b.x - a.x) / span) * sensYaw() : 0);
      release(pitch, fresh && !d.touch ? ((b.y - a.y) / span) * SENS_PITCH : 0);
    } else {
      if (d.caught) { release(yaw, 0); release(pitch, 0); }
      if (!cancelled) {
        const i = hitTest(p.x, p.y);
        if (e.pointerType === "mouse") hover(i);
        events.onPick(i < 0 ? null : cellOf(i));
      }
    }
    kick();
  }
  function onLeave(e: PointerEvent) { if (e.pointerType === "mouse" && !drag) hover(-1); }
  function onWheel(e: WheelEvent) {
    // A pinch always zooms; a plain wheel zooms once the chart has focus, and hands the scroll back at the limits.
    if (!e.ctrlKey && document.activeElement !== plot) return;
    const delta = e.deltaY * (e.deltaMode === 1 ? 16 : 1);
    const next = clamp(zoom.to * Math.exp(-delta * (e.ctrlKey ? .01 : .0018)), ...ZOOM);
    if (!e.ctrlKey && Math.abs(next - zoom.to) < 1e-4) return;
    e.preventDefault();
    intro();
    go(zoom, next, CFG.zoom, reduce);
    markMoved(); kick();
  }

  /* Environment */
  const resize = new ResizeObserver(() => {
    const r = plot.getBoundingClientRect();
    const wasNarrow = narrow;
    w = r.width; hgt = r.height; dpr = Math.min(2, window.devicePixelRatio || 1); narrow = w < 560;
    if (narrow !== wasNarrow && introduced && !moved && !top) go(yaw, homeYaw(), CFG.camera, reduce);
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(hgt * dpr);
    framed = false;
    draw();
  });
  const panelSize = new ResizeObserver(() => { pw = panel.offsetWidth || pw; ph = panel.offsetHeight || ph; });
  const inView = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible && entry.intersectionRatio >= .3) intro();
    if (visible) kick();
  }, { threshold: [0, .3, .6] });
  const theme = new MutationObserver(() => { readTheme(); draw(); });
  const scheme = window.matchMedia("(prefers-color-scheme: dark)");
  const onScheme = () => { readTheme(); draw(); };
  const onMotion = () => { reduce = motionQuery.matches; if (reduce) { intro(); emphasize(); } };
  const onVisibility = () => { if (!document.hidden) kick(); };

  readTheme();
  resize.observe(plot); panelSize.observe(panel); inView.observe(plot);
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-accent", "class", "style"] });
  scheme.addEventListener("change", onScheme);
  motionQuery.addEventListener("change", onMotion);
  document.addEventListener("visibilitychange", onVisibility);
  document.fonts?.ready.then(() => draw());
  plot.addEventListener("pointerdown", onDown);
  plot.addEventListener("pointermove", onMove);
  plot.addEventListener("pointerup", onUp);
  plot.addEventListener("pointercancel", onUp);
  plot.addEventListener("pointerleave", onLeave);
  plot.addEventListener("wheel", onWheel, { passive: false });
  if (reduce) { yaw.x = yaw.to = homeYaw(); pitch.x = pitch.to = HOME.pitch; zoom.x = zoom.to = 1; intro(); }

  return {
    setValues(next, toneTo, origin) {
      norm.set(next);
      go(tone, toneTo, CFG.tone, reduce);
      if (focus) go(ty, Math.max(HOME.ty, norm[idx(focus)] * H * .5), CFG.camera, reduce);
      if (!introduced) { intro(); return; }
      hcfg = CFG.morph;
      const reach = Math.hypot(COLS - 1, ROWS - 1);
      for (let i = 0; i < COUNT; i++) {
        const inFlight = Math.abs(hv[i]) > .02;
        hto[i] = norm[i];
        if (reduce) { hx[i] = norm[i]; hv[i] = 0; delay[i] = 0; continue; }
        // The change ripples out from the bar you are looking at, or sweeps along time when nothing is selected.
        const d = ROW[i], h = COL[i];
        delay[i] = inFlight ? 0 : origin ? (Math.hypot(h - origin.h, d - origin.d) / reach) * .36 : WAVE[i] * .32;
      }
      kick();
    },
    setView(next) {
      top = next;
      intro();
      yaw.x = wrap(yaw.x); yaw.to = wrap(yaw.to);
      go(flat, top ? 1 : 0, CFG.camera, reduce);
      go(yaw, top ? 0 : homeYaw(), CFG.camera, reduce);
      go(pitch, top ? TOP[0] : HOME.pitch, CFG.camera, reduce);
      if (!focus) go(zoom, 1, CFG.camera, reduce);
      kick();
    },
    setFocus(cell) {
      focus = cell;
      intro();
      if (cell) {
        const i = idx(cell);
        go(tx, colX(cell.h), CFG.camera, reduce); go(tz, rowZ(cell.d), CFG.camera, reduce);
        go(ty, Math.max(HOME.ty, norm[i] * H * .5), CFG.camera, reduce);
        go(zoom, clamp(Math.max(zoom.to, narrow ? 1.8 : 1.5), ...ZOOM), CFG.camera, reduce);
      } else {
        go(tx, 0, CFG.camera, reduce); go(tz, 0, CFG.camera, reduce); go(ty, HOME.ty, CFG.camera, reduce); go(zoom, 1, CFG.camera, reduce);
      }
      emphasize();
    },
    setActive(cell) {
      hoverIdx = cell ? idx(cell) : -1;
      active = cell;
      emphasize();
    },
    orbit(dYaw, dPitch) {
      if (top) return;
      intro();
      go(yaw, yaw.to + dYaw, CFG.camera, reduce);
      go(pitch, clamp(pitch.to + dPitch, ...PITCH), CFG.camera, reduce);
      markMoved(); kick();
    },
    zoom(factor) {
      intro();
      go(zoom, clamp(zoom.to * factor, ...ZOOM), CFG.zoom, reduce);
      markMoved(); kick();
    },
    reset() {
      yaw.x = wrap(yaw.x);
      go(yaw, top ? 0 : homeYaw(), CFG.camera, reduce);
      go(pitch, top ? TOP[0] : HOME.pitch, CFG.camera, reduce);
      go(zoom, 1, CFG.camera, reduce);
      moved = false;
      events.onMoved(false);
      kick();
    },
    destroy() {
      cancelAnimationFrame(raf);
      resize.disconnect(); panelSize.disconnect(); inView.disconnect(); theme.disconnect();
      scheme.removeEventListener("change", onScheme);
      motionQuery.removeEventListener("change", onMotion);
      document.removeEventListener("visibilitychange", onVisibility);
      plot.removeEventListener("pointerdown", onDown);
      plot.removeEventListener("pointermove", onMove);
      plot.removeEventListener("pointerup", onUp);
      plot.removeEventListener("pointercancel", onUp);
      plot.removeEventListener("pointerleave", onLeave);
      plot.removeEventListener("wheel", onWheel);
    },
  };
}
