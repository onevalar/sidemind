import { motionTokens } from "../../lib/motion-tokens";
import {
  CARD, HEALTH_LABEL, NODES, PEOPLE, PROJECTS, PROJECT_NODE, STATUS_LABEL, TASKS, TASK_NODE, TEAMS, TEAM_NODE, WORLD,
  formatDay, pathTo, type MapNode, type Stats, type Status, type WorkModel,
} from "./zoom-data";

export interface Palette {
  surface: string; muted: string; fg: string; secondary: string; faint: string;
  border: string; subtle: string; strong: string; accent: string; success: string; warning: string; danger: string;
  body: string; display: string;
}
export interface EngineHooks {
  hover: (node: number) => void;
  path: (path: number[]) => void;
  zoomed: (zoomed: boolean) => void;
  interact: () => void;
  tour: (playing: boolean) => void;
  changed: () => void;
  announce: (text: string) => void;
}

type Pt = { x: number; y: number };
/** `to` is the node the flight lands on, so the breadcrumb and panel switch once instead of ticking through every level the camera passes. */
type Flight = { at: (t: number) => [number, number, number]; t0: number; dur: number; bump: number; end: [number, number, number]; to: number; done?: () => void };
type Drag = { id: number; sx: number; sy: number; rx: number; ry: number; moved: boolean; caught: boolean; samples: { x: number; y: number; t: number }[] };
type Pinch = { d0: number; s0: number; wx: number; wy: number; c: Pt };
type ItemRect = { task: number; item: number; x: number; y: number; w: number; h: number };

const { spring, ease } = motionTokens;
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (a: number, b: number, v: number) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const easeOut = (t: number) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
const backOut = (t: number) => { const c = 1.9, x = clamp(t, 0, 1) - 1; return 1 + (c + 1) * x * x * x + c * x * x; };
const rubber = (d: number, dim: number) => (1 - 1 / ((d * .55) / dim + 1)) * dim;
const unrubber = (y: number, dim: number) => (y >= dim * .98 ? 90 * dim : ((1 / (1 - y / dim) - 1) * dim) / .55);

/** Cubic bezier easing, solved with Newton steps and a bisection fallback. */
function bezier([x1, y1, x2, y2]: readonly number[]) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx, cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t, dx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) { const e = sx(t) - x, d = dx(t); if (Math.abs(e) < 1e-6 || Math.abs(d) < 1e-6) break; t -= e / d; }
    if (t < 0 || t > 1 || Math.abs(sx(t) - x) > 1e-4) { let lo = 0, hi = 1; t = x; for (let i = 0; i < 30; i++) { if (sx(t) < x) lo = t; else hi = t; t = (lo + hi) / 2; } }
    return ((ay * t + by) * t + cy) * t;
  };
}
const flightEase = bezier(ease.inOut);

/** Smooth zoom and pan (van Wijk and Nuij): the camera rises just enough to keep both ends in sight. */
function zoomPath(p0: [number, number, number], p1: [number, number, number], rho = 1.35) {
  const [ux0, uy0, w0] = p0, [ux1, uy1, w1] = p1, dx = ux1 - ux0, dy = uy1 - uy0, d2 = dx * dx + dy * dy, rho2 = rho * rho, rho4 = rho2 * rho2;
  if (d2 < (Math.min(w0, w1) * 1e-4) ** 2) {
    const S = Math.log(w1 / w0) / rho;
    return { S: Math.abs(S), at: (t: number): [number, number, number] => [ux0 + t * dx, uy0 + t * dy, w0 * Math.exp(rho * t * S)] };
  }
  const d1 = Math.sqrt(d2);
  const b0 = (w1 * w1 - w0 * w0 + rho4 * d2) / (2 * w0 * rho2 * d1), b1 = (w1 * w1 - w0 * w0 - rho4 * d2) / (2 * w1 * rho2 * d1);
  const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0), r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1);
  const S = (r1 - r0) / rho, c0 = Math.cosh(r0), s0 = Math.sinh(r0);
  return {
    S: Math.abs(S),
    at: (t: number): [number, number, number] => {
      const s = t * S, u = (w0 / (rho2 * d1)) * (c0 * Math.tanh(rho * s + r0) - s0);
      return [ux0 + u * dx, uy0 + u * dy, (w0 * c0) / Math.cosh(rho * s + r0)];
    },
  };
}

const TOUR = [TEAM_NODE[0], PROJECT_NODE[0], TASK_NODE[0], TASK_NODE[6], TEAM_NODE[1], PROJECT_NODE[7], 0];
const PAN_FRICTION = 3.6;

export class ZoomEngine {
  private ctx: CanvasRenderingContext2D;
  private mctx: CanvasRenderingContext2D | null;
  private pal: Palette = { surface: "#fff", muted: "#f6f6f6", fg: "#111", secondary: "#555", faint: "#777", border: "#e8e8e8", subtle: "#f1f1f1", strong: "#c8c8c8", accent: "#333", success: "#1f8a4c", warning: "#b7791f", danger: "#c53030", body: "sans-serif", display: "sans-serif" };
  private W = 0; private H = 0; private dpr = 1; private mw = 0; private mh = 0;
  private cx = WORLD.w / 2; private cy = WORLD.h / 2; private s = .5;
  private zt = Math.log(.5); private zv = 0; private anchor: Pt | null = null; private lastWheel = 0;
  private vx = 0; private vy = 0; private panTarget: Pt | null = null; private pvx = 0; private pvy = 0;
  private flight: Flight | null = null;
  private drag: Drag | null = null; private pinch: Pinch | null = null;
  private pointers = new Map<number, Pt>();
  private mouse: Pt | null = null;
  private raf = 0; private last = 0;
  private visible = false; private hidden = false; private reduce = false; private sized = false;
  private introT0 = -1; private introDone = false;
  private view = 0; private hoverNode = -1; private hoverItem = -1; private cursor = -1; private cursorItem = -1;
  private hl = new Map<number, number>();
  private dim = new Float32Array(NODES.length).fill(1);
  private spot = 0; private spotPerson = -1; private spotProject = -1;
  private shown = new Float32Array(NODES.length);
  private statusT = new Float64Array(TASKS.length).fill(-1e9);
  private itemT: Float64Array[] = TASKS.map(t => new Float64Array(t.checklist.length).fill(-1e9));
  private cache = new Map<number, Stats>();
  private items: ItemRect[] = [];
  private faces: (HTMLCanvasElement | null)[] = PEOPLE.map(() => null);
  private widths = new Map<string, number>();
  private prefixes = new Map<string, number[]>();
  private font = "";
  private hasSpacing: boolean;
  private panel: HTMLElement | null = null; private pw = 248; private ph = 160; private px = 0; private py = 0; private panelOn = false;
  private readout: HTMLElement | null = null; private readText = "";
  private zoomedFlag = false;
  private touring = false; private tourStep = 0; private tourTimer = 0;
  private dead = false;

  constructor(private canvas: HTMLCanvasElement, private mini: HTMLCanvasElement | null, private stage: HTMLElement, private model: WorkModel, private hooks: EngineHooks) {
    this.ctx = canvas.getContext("2d")!;
    this.mctx = mini?.getContext("2d") ?? null;
    this.hasSpacing = "letterSpacing" in this.ctx;
    for (const id of [0, ...TEAM_NODE, ...PROJECT_NODE]) this.shown[id] = this.stat(id).progress;
    PEOPLE.forEach((p, i) => {
      if (!p.portrait) return;
      const img = new Image();
      img.decoding = "async";
      img.onload = () => {
        if (this.dead) return;
        const size = 160, c = document.createElement("canvas");
        c.width = c.height = size;
        const g = c.getContext("2d");
        if (!g) return;
        const side = img.naturalWidth * .62, sx = (img.naturalWidth - side) / 2, sy = Math.max(0, img.naturalHeight * .3 - side / 2);
        g.beginPath(); g.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2); g.clip();
        g.drawImage(img, sx, sy, side, side, 0, 0, size, size);
        this.faces[i] = c;
        this.wake();
      };
      img.src = p.portrait;
    });
    document.fonts?.ready.then(() => { if (!this.dead) { this.widths.clear(); this.prefixes.clear(); this.font = ""; this.wake(); } });
  }

  /* ---------- lifecycle ---------- */

  private stat(id: number) {
    let v = this.cache.get(id);
    if (!v) { v = this.model.stats(id); this.cache.set(id, v); }
    return v;
  }

  destroy() { this.dead = true; cancelAnimationFrame(this.raf); clearTimeout(this.tourTimer); }
  setPalette(p: Palette) {
    if (p.body !== this.pal.body || p.display !== this.pal.display) { this.widths.clear(); this.prefixes.clear(); }
    this.pal = p; this.font = ""; this.wake();
  }
  setReduced(r: boolean) { this.reduce = r; if (r && this.flight) this.finishFlight(); this.wake(); }
  setVisible(v: boolean) { this.visible = v; if (!v) this.stopTour(); this.maybeIntro(); this.wake(); }
  setHidden(h: boolean) { this.hidden = h; if (h) this.stopTour(); this.wake(); }
  attachPanel(el: HTMLElement | null) { this.panel = el; if (el) this.measurePanel(); }
  measurePanel() { if (this.panel) { this.pw = this.panel.offsetWidth; this.ph = this.panel.offsetHeight; this.wake(); } }
  attachReadout(el: HTMLElement | null) { this.readout = el; this.readText = ""; this.wake(); }

  resize(w: number, h: number, dpr: number) {
    if (w < 2 || h < 2) return;
    const first = !this.sized;
    const oldFit = this.sized ? this.fitS : 0;
    this.W = w; this.H = h; this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr);
    if (this.mini) {
      this.mw = this.mini.clientWidth; this.mh = this.mini.clientHeight;
      this.mini.width = Math.round(this.mw * dpr); this.mini.height = Math.round(this.mh * dpr);
    }
    this.font = "";
    this.sized = true;
    if (first || this.view === 0) {
      const [x, y] = this.centerFor(0, this.fitS);
      if (!this.flight || first) { this.cx = x; this.cy = y; this.s = this.fitS; this.zt = Math.log(this.s); }
    } else if (oldFit) {
      this.s = clamp(this.s * (this.fitS / oldFit), this.fitS, this.maxS); this.zt = Math.log(this.s);
    }
    this.maybeIntro();
    this.wake();
  }

  private maybeIntro() {
    if (this.introDone || !this.visible || !this.sized) return;
    this.introDone = true;
    if (this.reduce) return;
    this.introT0 = performance.now();
    this.s = this.fitS * .72; this.zt = Math.log(this.s);
    const [x, y] = this.centerFor(0, this.s);
    this.cx = x; this.cy = y;
    this.flyTo(0, undefined, 1500);
  }

  private wake() {
    if (this.raf || this.dead || !this.visible || this.hidden || !this.sized) return;
    this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number) => {
    this.raf = 0;
    const gap = now - this.last;
    const dt = gap > 0 && gap < 100 ? gap / 1000 : 1 / 60;
    this.last = now;
    const busy = this.step(dt, now);
    this.draw(now);
    if (busy) this.wake();
  };

  /* ---------- camera geometry ---------- */

  private get insets() { const small = this.W < 560; return { top: small ? 56 : 64, bottom: small ? 56 : 60, side: small ? 12 : 24 }; }
  private get fitS() { const { top, bottom, side } = this.insets; return Math.min((this.W - side * 2) / WORLD.w, (this.H - top - bottom) / WORLD.h); }
  private get maxS() { const t = NODES[TASK_NODE[0]]; return this.fitFor(t) * 1.7; }
  private fitFor(n: MapNode) {
    if (n.kind === 0) return this.fitS;
    const { top, bottom, side } = this.insets;
    return Math.min((this.W - side * 2) / n.w, (this.H - top - bottom) / n.h) * (n.kind === 3 ? .96 : .97);
  }
  private centerFor(id: number, s: number): [number, number] {
    const n = NODES[id], { top, bottom } = this.insets;
    const x = n.x + n.w / 2, y = n.y + n.h / 2 - (top - bottom) / 2 / s;
    const [lx, hx] = this.range(s, 0), [ly, hy] = this.range(s, 1);
    return [clamp(x, lx, hx), clamp(y, ly, hy)];
  }
  /** Allowed camera centers at scale s: the world may reach the safe edges, never further. */
  private range(s: number, axis: 0 | 1): [number, number] {
    const { top, bottom, side } = this.insets;
    if (axis === 0) {
      const half = (this.W / 2 - side) / s;
      return half * 2 >= WORLD.w ? [WORLD.w / 2, WORLD.w / 2] : [half, WORLD.w - half];
    }
    const lo = (this.H / 2 - top) / s, hi = WORLD.h - (this.H / 2 - bottom) / s;
    if (lo > hi) { const c = WORLD.h / 2 - (top - bottom) / 2 / s; return [c, c]; }
    return [lo, hi];
  }
  private band(raw: number, [lo, hi]: [number, number], dim: number) {
    const s = this.s;
    return raw < lo ? lo - rubber((lo - raw) * s, dim) / s : raw > hi ? hi + rubber((raw - hi) * s, dim) / s : raw;
  }
  private unband(v: number, [lo, hi]: [number, number], dim: number) {
    const s = this.s;
    return v < lo ? lo - unrubber((lo - v) * s, dim) / s : v > hi ? hi + unrubber((v - hi) * s, dim) / s : v;
  }
  private toWorld(p: Pt): Pt { return { x: this.cx + (p.x - this.W / 2) / this.s, y: this.cy + (p.y - this.H / 2) / this.s }; }
  private screenRect(n: MapNode) {
    const s = this.s, ox = this.W / 2 - this.cx * s, oy = this.H / 2 - this.cy * s;
    return { x: n.x * s + ox, y: n.y * s + oy, w: n.w * s, h: n.h * s };
  }

  /* ---------- motion ---------- */

  flyTo(id: number, done?: () => void, duration?: number) {
    if (!this.sized) return;
    const n = NODES[id];
    const s1 = clamp(id === 0 ? this.fitS : this.fitFor(n), this.fitS, this.maxS);
    const [x1, y1] = this.centerFor(id, s1);
    this.vx = this.vy = 0; this.zv = 0; this.anchor = null; this.panTarget = null;
    this.setHover(-1, -1);
    if (this.cursor >= 0 && NODES[this.cursor].parent !== id) this.cursor = -1;
    this.cursorItem = -1;
    const end: [number, number, number] = [x1, y1, this.W / s1];
    const to = n.kind === 4 ? n.parent : id;
    const w0 = this.W / this.s;
    if (this.reduce || (Math.abs(x1 - this.cx) * s1 < .5 && Math.abs(y1 - this.cy) * s1 < .5 && Math.abs(Math.log(this.s / s1)) < .002)) {
      this.flight = { at: () => end, t0: 0, dur: 0, bump: 0, end, to, done };
      this.finishFlight();
      return;
    }
    const path = zoomPath([this.cx, this.cy, w0], end);
    const dur = duration ?? clamp(420 + 400 * path.S, 560, 1500);
    const bump = end[2] < w0 * .95 && duration === undefined ? .05 + .035 * Math.min(2, Math.log(w0 / end[2])) : 0;
    this.flight = { at: path.at, t0: performance.now(), dur, bump, end, to, done };
    this.wake();
  }

  private finishFlight() {
    const f = this.flight;
    if (!f) return;
    this.flight = null;
    [this.cx, this.cy] = f.end; this.s = this.W / f.end[2]; this.zt = Math.log(this.s); this.zv = 0;
    this.wake();
    f.done?.();
  }

  private halt() {
    this.flight = null; this.panTarget = null; this.anchor = null;
    this.vx = this.vy = 0; this.zv = 0; this.zt = Math.log(this.s);
  }

  zoomBy(f: number) {
    this.stopTour(); this.hooks.interact();
    if (this.flight) this.halt();
    const { top, bottom } = this.insets;
    this.anchor = { x: this.W / 2, y: (top + this.H - bottom) / 2 };
    const lo = Math.log(this.fitS), hi = Math.log(this.maxS);
    const next = this.zt + Math.log(f);
    this.zt = next > hi + .01 ? hi + .14 : next < lo - .01 ? lo - .14 : clamp(next, lo, hi);
    this.lastWheel = performance.now();
    if (this.reduce) this.applyZoom(clamp(this.zt, lo, hi));
    this.wake();
  }
  fitAll() { this.stopTour(); this.hooks.interact(); this.flyTo(0); }
  flyOut() {
    this.stopTour(); this.hooks.interact();
    if (this.cursor >= 0 || this.cursorItem >= 0) { this.cursor = -1; this.cursorItem = -1; this.setHover(-1, -1); this.wake(); return; }
    if (this.view > 0) this.flyTo(NODES[this.view].parent);
  }
  goTo(id: number) { this.stopTour(); this.hooks.interact(); this.flyTo(id); }

  private applyZoom(ls: number) {
    const s0 = this.s, s1 = Math.exp(ls);
    if (this.anchor) {
      const ax = this.anchor.x - this.W / 2, ay = this.anchor.y - this.H / 2;
      this.cx += ax / s0 - ax / s1; this.cy += ay / s0 - ay / s1;
    }
    this.s = s1;
  }

  private step(dt: number, now: number): boolean {
    let busy = false;
    const f = this.flight;
    if (f) {
      const t = clamp((now - f.t0) / f.dur, 0, 1);
      if (t >= 1) this.finishFlight();
      else {
        const [x, y, w] = f.at(flightEase(t));
        this.cx = x; this.cy = y; this.s = this.W / (w * Math.exp(f.bump * Math.sin(Math.PI * t)));
        busy = true;
      }
    } else if (!this.drag && !this.pinch) {
      const n = Math.max(1, Math.ceil(dt / (1 / 120))), h = dt / n;
      const lo = Math.log(this.fitS), hi = Math.log(this.maxS);
      if (now - this.lastWheel > 170) this.zt = clamp(this.zt, lo, hi);
      const target = this.zt > hi ? hi + rubber(this.zt - hi, .35) : this.zt < lo ? lo - rubber(lo - this.zt, .35) : this.zt;
      for (let i = 0; i < n; i++) {
        const ls = Math.log(this.s);
        if (Math.abs(target - ls) > 1e-4 || Math.abs(this.zv) > 1e-3) {
          if (this.reduce) { this.applyZoom(target); this.zv = 0; }
          else {
            this.zv += (spring.responsive.stiffness * (target - ls) - spring.responsive.damping * this.zv) * h;
            this.applyZoom(ls + this.zv * h);
          }
          busy = true;
        } else if (this.zv !== 0 || ls !== target) { this.applyZoom(target); this.zv = 0; }

        if (this.panTarget) {
          const k = spring.gentle.stiffness, c = spring.gentle.damping;
          this.pvx += (k * (this.panTarget.x - this.cx) - c * this.pvx) * h;
          this.pvy += (k * (this.panTarget.y - this.cy) - c * this.pvy) * h;
          this.cx += this.pvx * h; this.cy += this.pvy * h;
          if (Math.hypot(this.panTarget.x - this.cx, this.panTarget.y - this.cy) * this.s < .3 && Math.hypot(this.pvx, this.pvy) * this.s < 2) { this.cx = this.panTarget.x; this.cy = this.panTarget.y; this.panTarget = null; this.pvx = this.pvy = 0; }
          busy = true;
          continue;
        }
        busy = this.axis(0, h) || busy;
        busy = this.axis(1, h) || busy;
      }
    }

    const view = this.flight ? this.flight.to : this.viewNode();
    if (view !== this.view) {
      this.view = view;
      this.hooks.path(pathTo(view));
      if (this.cursor >= 0 && NODES[this.cursor].parent !== view) { this.cursor = -1; this.setHover(-1, -1); }
    }
    const zoomed = this.s > this.fitS * 1.06;
    if (zoomed !== this.zoomedFlag) { this.zoomedFlag = zoomed; this.hooks.zoomed(zoomed); }
    if (this.mouse && !this.drag && !this.pinch && !this.flight && busy && this.cursor < 0 && this.cursorItem < 0) this.pointerHover(this.mouse, false);

    return this.fades(dt, now) || busy;
  }

  /** One axis of free motion: momentum with friction inside bounds, a gentle spring outside them. */
  private axis(axis: 0 | 1, h: number) {
    const [lo, hi] = this.range(this.s, axis);
    let c = axis ? this.cy : this.cx, v = axis ? this.vy : this.vx;
    const over = c < lo ? c - lo : c > hi ? c - hi : 0;
    if (over !== 0) {
      if (this.reduce) { c = clamp(c, lo, hi); v = 0; }
      else {
        v += (spring.gentle.stiffness * over * this.s - spring.gentle.damping * v) * h;
        c -= (v * h) / this.s;
        if (Math.abs(over * this.s) < .25 && Math.abs(v) < 4) { c = clamp(c, lo, hi); v = 0; }
      }
    } else if (v !== 0) {
      v *= Math.exp(-PAN_FRICTION * h);
      c -= (v * h) / this.s;
      if (Math.abs(v) < 3) v = 0;
    }
    if (axis) { this.cy = c; this.vy = v; } else { this.cx = c; this.vx = v; }
    return over !== 0 || v !== 0;
  }

  /** The deepest region, card or task that fills the view; it drives the breadcrumb and the numbers. */
  private viewNode() {
    const { top, bottom, side } = this.insets;
    const w = this.W - side * 2, h = this.H - top - bottom;
    // At the overview the whole studio is in view, even when one team happens to fill half the stage height.
    if (this.s <= this.fitS * 1.06) return 0;
    const c = this.toWorld({ x: this.W / 2, y: (top + this.H - bottom) / 2 });
    let node = 0;
    for (;;) {
      const next = NODES[node].children.find(k => {
        const n = NODES[k];
        return n.kind !== 4 && c.x >= n.x && c.x <= n.x + n.w && c.y >= n.y && c.y <= n.y + n.h && (n.w * this.s >= w * .55 || n.h * this.s >= h * .55);
      });
      if (next === undefined) return node;
      node = next;
    }
  }

  private fades(dt: number, now: number) {
    let busy = false;
    const k = 1 - Math.exp(-dt * (this.reduce ? 1e3 : 11));
    for (const [id, v] of this.hl) {
      const target = id === this.hoverNode ? 1 : 0, next = v + (target - v) * k;
      if (Math.abs(target - next) < .004) { if (target) this.hl.set(id, 1); else this.hl.delete(id); } else { this.hl.set(id, next); busy = true; }
    }
    if (this.hoverNode >= 0 && !this.hl.has(this.hoverNode)) { this.hl.set(this.hoverNode, this.reduce ? 1 : 0); busy = true; }
    const path = pathTo(this.view);
    for (let i = 1; i < NODES.length; i++) {
      const n = NODES[i];
      if (n.kind === 4) continue;
      const depth = n.kind, onPath = path[depth] === i, parentOnPath = path[depth - 1] === n.parent && path.length > depth;
      const target = !parentOnPath || onPath ? 1 : n.kind === 1 ? .42 : .5;
      const v = this.dim[i];
      if (Math.abs(v - target) > .003) { this.dim[i] = v + (target - v) * k * .7; busy = true; } else this.dim[i] = target;
    }
    const spotOn = this.hoverNode >= 0 && NODES[this.hoverNode].kind === 4;
    if (spotOn) { this.spotPerson = NODES[this.hoverNode].ref; this.spotProject = NODES[this.hoverNode].parent; }
    const st = spotOn ? 1 : 0;
    if (Math.abs(this.spot - st) > .003) { this.spot += (st - this.spot) * k; busy = true; } else this.spot = st;
    for (const id of [0, ...TEAM_NODE, ...PROJECT_NODE]) {
      const target = this.stat(id).progress, v = this.shown[id];
      if (Math.abs(target - v) > .0005) { this.shown[id] = this.reduce ? target : v + (target - v) * (1 - Math.exp(-dt * 6)); busy = true; } else this.shown[id] = target;
    }
    if (this.introT0 > 0 && now - this.introT0 < 2200) busy = true;
    return busy || now - this.lastAnim < 700;
  }
  private lastAnim = -1e9;

  /* ---------- input ---------- */

  private local(e: { clientX: number; clientY: number }): Pt {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  pointerDown(e: PointerEvent) {
    this.stopTour(); this.hooks.interact();
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    if (this.pointers.size === 2) { this.startPinch(); return; }
    if (this.pointers.size > 2) return;
    const caught = !!this.flight || Math.hypot(this.vx, this.vy) > 90 || !!this.panTarget;
    this.halt();
    this.drag = { id: e.pointerId, sx: p.x, sy: p.y, rx: this.unband(this.cx, this.range(this.s, 0), this.W), ry: this.unband(this.cy, this.range(this.s, 1), this.H), moved: false, caught, samples: [{ x: p.x, y: p.y, t: performance.now() }] };
    this.wake();
  }

  pointerMove(e: PointerEvent) {
    const p = this.local(e);
    if (e.pointerType === "mouse") this.mouse = p;
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, p);
    if (this.pinch) { this.movePinch(); return; }
    const d = this.drag;
    if (d && d.id === e.pointerId) {
      if (!d.moved && Math.hypot(p.x - d.sx, p.y - d.sy) < 5) return;
      if (!d.moved) { d.moved = true; this.setHover(-1, -1); this.stage.dataset.dragging = "true"; }
      this.cx = this.band(d.rx - (p.x - d.sx) / this.s, this.range(this.s, 0), this.W);
      this.cy = this.band(d.ry - (p.y - d.sy) / this.s, this.range(this.s, 1), this.H);
      const now = performance.now();
      d.samples.push({ x: p.x, y: p.y, t: now });
      while (d.samples.length > 2 && now - d.samples[0].t > 90) d.samples.shift();
      this.wake();
      return;
    }
    if (!d && e.pointerType === "mouse" && !this.flight) this.pointerHover(p);
  }

  pointerUp(e: PointerEvent, cancelled = false) {
    const p = this.local(e);
    this.pointers.delete(e.pointerId);
    if (this.pinch) {
      if (this.pointers.size < 2) this.endPinch();
      return;
    }
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    this.drag = null;
    delete this.stage.dataset.dragging;
    if (!d.moved) { if (!d.caught && !cancelled) this.click(p); }
    else if (!this.reduce) {
      const a = d.samples[0], b = d.samples[d.samples.length - 1], now = performance.now();
      if (b.t > a.t && now - b.t < 70) {
        const k = 1000 / (b.t - a.t);
        this.vx = clamp((b.x - a.x) * k, -5000, 5000); this.vy = clamp((b.y - a.y) * k, -5000, 5000);
      }
    }
    if (e.pointerType === "mouse" && !this.flight) this.pointerHover(p);
    this.wake();
  }

  pointerLeave() { this.mouse = null; if (!this.drag && this.cursor < 0) this.setHover(-1, -1); }

  private startPinch() {
    const [a, b] = [...this.pointers.values()];
    this.halt();
    this.drag = null;
    const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, w = this.toWorld(c);
    this.pinch = { d0: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)), s0: this.s, wx: w.x, wy: w.y, c };
    this.setHover(-1, -1);
  }
  private movePinch() {
    const pz = this.pinch;
    if (!pz || this.pointers.size < 2) return;
    const [a, b] = [...this.pointers.values()];
    const lo = Math.log(this.fitS), hi = Math.log(this.maxS);
    const raw = Math.log(pz.s0) + Math.log(Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)) / pz.d0);
    const ls = raw > hi ? hi + rubber(raw - hi, .35) : raw < lo ? lo - rubber(lo - raw, .35) : raw;
    this.s = Math.exp(ls);
    pz.c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    this.cx = pz.wx - (pz.c.x - this.W / 2) / this.s;
    this.cy = pz.wy - (pz.c.y - this.H / 2) / this.s;
    this.wake();
  }
  private endPinch() {
    const pz = this.pinch;
    this.pinch = null;
    if (!pz) return;
    this.zt = clamp(Math.log(this.s), Math.log(this.fitS), Math.log(this.maxS));
    this.anchor = pz.c; this.lastWheel = 0;
    const rest = [...this.pointers.entries()][0];
    if (rest) {
      const [id, p] = rest;
      this.drag = { id, sx: p.x, sy: p.y, rx: this.unband(this.cx, this.range(this.s, 0), this.W), ry: this.unband(this.cy, this.range(this.s, 1), this.H), moved: true, caught: true, samples: [{ x: p.x, y: p.y, t: performance.now() }] };
    }
    this.wake();
  }

  wheel(e: WheelEvent) {
    e.preventDefault();
    this.stopTour(); this.hooks.interact();
    if (this.flight || this.panTarget) this.halt();
    const p = this.local(e);
    this.mouse = p;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.H : 1;
    const dx = e.deltaX * unit, dy = e.deltaY * unit;
    if (!e.ctrlKey && Math.abs(dx) > Math.abs(dy)) {
      const [lo, hi] = this.range(this.s, 0), out = this.cx < lo || this.cx > hi;
      this.vx = 0;
      this.cx += (dx / this.s) * (out ? .3 : 1);
      this.wake();
      return;
    }
    const lo = Math.log(this.fitS), hi = Math.log(this.maxS);
    this.anchor = p;
    this.lastWheel = performance.now();
    this.zt = clamp(this.zt - dy * (e.ctrlKey ? .012 : .0022), lo - .7, hi + .7);
    if (this.reduce) { this.zt = clamp(this.zt, lo, hi); this.applyZoom(this.zt); }
    this.wake();
  }

  miniPointer(e: PointerEvent) {
    if (!this.mini || !this.sized) return;
    this.stopTour(); this.hooks.interact();
    const r = this.mini.getBoundingClientRect();
    const { m, ox, oy } = this.miniFrame();
    const x = (e.clientX - r.left - ox) / m, y = (e.clientY - r.top - oy) / m;
    this.flight = null; this.vx = this.vy = 0; this.anchor = null; this.zt = Math.log(this.s); this.zv = 0;
    const { top, bottom } = this.insets;
    const tx = clamp(x, ...this.range(this.s, 0)), ty = clamp(y - (top - bottom) / 2 / this.s, ...this.range(this.s, 1));
    if (this.reduce) { this.cx = tx; this.cy = ty; } else this.panTarget = { x: tx, y: ty };
    this.wake();
  }

  /* ---------- picking ---------- */

  /** What a click would fly into: the deepest thing you can read, or the next level inside the current view. */
  private pick(p: Pt): { node: number; item: number } {
    for (const r of this.items) if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) return { node: TASK_NODE[r.task], item: r.item };
    const w = this.toWorld(p), s = this.s;
    const inside = (n: MapNode) => w.x >= n.x && w.x <= n.x + n.w && w.y >= n.y && w.y <= n.y + n.h;
    const team = NODES[0].children.find(k => inside(NODES[k]));
    if (team === undefined) return { node: -1, item: -1 };
    let best = team;
    const card = NODES[team].children.find(k => inside(NODES[k]));
    if (card === undefined || !(NODES[card].w * s >= 150 || this.view === team)) return { node: best, item: -1 };
    best = card;
    for (const k of NODES[card].children) {
      const n = NODES[k];
      if (n.kind === 4) {
        const r = n.w / 2;
        if (n.w * s >= 18 && Math.hypot(w.x - (n.x + r), w.y - (n.y + r)) <= r) return { node: k, item: -1 };
      } else if (inside(n) && (n.w * s >= 90 || this.view === card)) return { node: k, item: -1 };
    }
    return { node: best, item: -1 };
  }

  private pointerHover(p: Pt, moved = true) {
    const { node, item } = this.pick(p);
    const shown = node === this.view && item < 0 ? -1 : node;
    if (moved) { this.cursor = -1; this.cursorItem = -1; }
    this.setHover(shown, item);
    this.stage.dataset.clickable = String(item >= 0 || (node >= 0 && node !== this.view) || (node < 0 && this.view > 0));
  }

  private setHover(node: number, item: number) {
    if (node === this.hoverNode && item === this.hoverItem) return;
    const wasOn = this.hoverNode >= 0;
    this.hoverNode = node; this.hoverItem = item;
    const panelNode = item >= 0 ? -1 : node;
    if (panelNode >= 0 && !wasOn) this.panelOn = false;
    this.hooks.hover(panelNode);
    this.wake();
  }

  private click(p: Pt) {
    const { node, item } = this.pick(p);
    if (item >= 0) { this.toggle(NODES[node].ref, item); return; }
    if (node < 0) { if (this.view > 0) this.flyTo(NODES[this.view].parent); return; }
    this.activate(node);
  }

  private activate(node: number) {
    const n = NODES[node];
    if (n.kind === 4) {
      const project = PROJECTS[NODES[n.parent].ref];
      const mine = project.tasks.filter(t => TASKS[t].assignee === n.ref);
      const order: Status[] = ["progress", "review", "blocked", "todo", "done"];
      mine.sort((a, b) => order.indexOf(this.model.status(a)) - order.indexOf(this.model.status(b)));
      this.flyTo(mine.length ? TASK_NODE[mine[0]] : n.parent);
      return;
    }
    if (node !== this.view) this.flyTo(node);
  }

  toggle(task: number, item: number) {
    const before = this.model.status(task);
    this.model.toggle(task, item);
    const after = this.model.status(task), now = performance.now();
    this.itemT[task][item] = now; this.lastAnim = now;
    if (after !== before) this.statusT[task] = now;
    this.cache.clear();
    const t = TASKS[task], done = this.model.done(task), label = t.checklist[item];
    this.hooks.changed();
    this.hooks.announce(`${label} ${this.model.checks[task][item] ? "checked" : "unchecked"}. ${t.title}: ${done} of ${t.checklist.length} done${after !== before ? `, now ${STATUS_LABEL[after].toLowerCase()}` : ""}.`);
    this.wake();
  }

  /* ---------- keyboard ---------- */

  moveCursor(dx: number, dy: number) {
    this.stopTour(); this.hooks.interact();
    const view = NODES[this.view];
    if (view.kind === 3) {
      const t = TASKS[view.ref], n = t.checklist.length;
      this.cursorItem = this.cursorItem < 0 ? 0 : clamp(this.cursorItem + (dy || dx), 0, n - 1);
      this.cursor = -1; this.setHover(this.view, this.cursorItem);
      this.hooks.announce(`${t.checklist[this.cursorItem]}, ${this.model.checks[view.ref][this.cursorItem] ? "checked" : "not checked"}. Press Enter to toggle.`);
      return;
    }
    const kids = view.children;
    if (!kids.length) return;
    let next = kids[0];
    if (this.cursor >= 0 && kids.includes(this.cursor)) {
      const a = NODES[this.cursor], ax = a.x + a.w / 2, ay = a.y + a.h / 2;
      let best = Infinity;
      next = this.cursor;
      for (const k of kids) {
        if (k === this.cursor) continue;
        const b = NODES[k], ddx = b.x + b.w / 2 - ax, ddy = b.y + b.h / 2 - ay;
        const along = ddx * dx + ddy * dy, across = Math.abs(ddx * dy) + Math.abs(ddy * dx);
        if (along <= 1) continue;
        const score = along + across * 2.5;
        if (score < best) { best = score; next = k; }
      }
    }
    this.cursor = next;
    this.setHover(next, -1);
    this.hooks.announce(this.describeNode(next) + " Press Enter to zoom in.");
  }

  activateCursor() {
    this.stopTour(); this.hooks.interact();
    if (NODES[this.view].kind === 3 && this.cursorItem >= 0) { this.toggle(NODES[this.view].ref, this.cursorItem); return; }
    if (this.cursor >= 0) { const c = this.cursor; this.cursor = -1; this.activate(c); return; }
    this.moveCursor(1, 0);
  }

  describeNode(id: number) {
    const n = NODES[id], st = this.stat(id);
    const pct = `${Math.round(st.progress * 100)}% complete`;
    if (n.kind === 1) return `${n.name} team, ${st.projects} projects, ${st.open} open tasks, ${pct}.`;
    if (n.kind === 2) { const p = PROJECTS[n.ref]; return `${p.name}, ${HEALTH_LABEL[p.health].toLowerCase()}, ${pct}, ${st.open} open tasks, due ${formatDay(p.due)}.`; }
    if (n.kind === 3) { const t = TASKS[n.ref]; return `${t.title}, ${STATUS_LABEL[this.model.status(n.ref)].toLowerCase()}, assigned to ${PEOPLE[t.assignee].name}, due ${formatDay(t.due)}, ${this.model.done(n.ref)} of ${t.checklist.length} checklist items done.`; }
    if (n.kind === 4) return `${n.name}, ${PEOPLE[n.ref].role}, ${st.open} open tasks in ${NODES[n.parent].name}.`;
    return `Northstar Studio, ${TEAMS.length} teams, ${st.projects} projects, ${st.open} open tasks, ${pct}.`;
  }

  /* ---------- tour ---------- */

  toggleTour() { if (this.touring) this.stopTour(); else this.startTour(); }
  private startTour() {
    this.touring = true; this.tourStep = 0; this.hooks.tour(true); this.hooks.interact();
    this.cursor = -1; this.cursorItem = -1;
    this.nextStop();
  }
  private nextStop() {
    if (!this.touring) return;
    if (this.tourStep >= TOUR.length) { this.stopTour(); return; }
    const id = TOUR[this.tourStep++];
    this.flyTo(id, () => { if (this.touring) this.tourTimer = window.setTimeout(() => this.nextStop(), this.tourStep >= TOUR.length ? 0 : this.reduce ? 2400 : 1500); });
  }
  stopTour() {
    if (!this.touring) return;
    this.touring = false; clearTimeout(this.tourTimer); this.hooks.tour(false);
  }

  /* ---------- text ---------- */

  private setFont(size: number, weight: number, display = false) {
    const f = `${weight} ${size.toFixed(2)}px ${display ? this.pal.display : this.pal.body}`;
    if (f === this.font) return;
    this.font = f; this.ctx.font = f;
    if (this.hasSpacing) (this.ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${((display ? -.03 : -.01) * size).toFixed(3)}px`;
  }
  private width(text: string, size: number, weight: number, display = false) {
    const key = `${weight}${display ? "d" : "b"}${text}`;
    let w = this.widths.get(key);
    if (w === undefined) { this.setFont(100, weight, display); w = this.ctx.measureText(text).width; this.widths.set(key, w); }
    return (w * size) / 100;
  }
  private fit(text: string, size: number, weight: number, maxW: number) {
    if (maxW <= 0) return "";
    if (this.width(text, size, weight) <= maxW) return text;
    const key = `${weight}${text}`;
    let pre = this.prefixes.get(key);
    if (!pre) { this.setFont(100, weight); pre = [...text].map((_, i) => this.ctx.measureText(text.slice(0, i + 1)).width); this.prefixes.set(key, pre); }
    const room = (maxW - this.width("…", size, weight)) * 100 / size;
    let lo = 0, hi = pre.length;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (pre[mid - 1] <= room) lo = mid; else hi = mid - 1; }
    return lo ? text.slice(0, lo).trimEnd() + "…" : "";
  }
  private wrap(text: string, size: number, weight: number, maxW: number, maxLines: number) {
    const words = text.split(" "), lines: string[] = [];
    let line = "";
    for (let i = 0; i < words.length; i++) {
      const test = line ? `${line} ${words[i]}` : words[i];
      if (!line || this.width(test, size, weight) <= maxW) { line = test; continue; }
      if (lines.length === maxLines - 1) { lines.push(this.fit(`${line} ${words.slice(i).join(" ")}`, size, weight, maxW)); return lines; }
      lines.push(line); line = words[i];
    }
    if (line) lines.push(this.width(line, size, weight) > maxW ? this.fit(line, size, weight, maxW) : line);
    return lines;
  }
  /** Draws one line; y is the top of a line box 1.3 times the size tall. */
  private text(str: string, x: number, y: number, size: number, weight: number, color: string, align: CanvasTextAlign = "left", display = false) {
    if (!str) return;
    this.setFont(size, weight, display);
    const c = this.ctx;
    c.fillStyle = color; c.textAlign = align;
    c.fillText(str, x, y + size * .65 + size * .36);
  }

  /* ---------- drawing ---------- */

  private rr(x: number, y: number, w: number, h: number, r: number) {
    const c = this.ctx;
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    c.beginPath();
    if (c.roundRect) c.roundRect(x, y, w, h, r);
    else { c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
  }
  private circle(x: number, y: number, r: number) { const c = this.ctx; c.beginPath(); c.arc(x, y, Math.max(0, r), 0, Math.PI * 2); }

  private partial(points: number[][], p: number) {
    const c = this.ctx, segs = points.slice(1).map((q, i) => Math.hypot(q[0] - points[i][0], q[1] - points[i][1]));
    let left = segs.reduce((a, b) => a + b, 0) * clamp(p, 0, 1);
    c.beginPath(); c.moveTo(points[0][0], points[0][1]);
    for (let i = 0; i < segs.length && left > 0; i++) {
      const t = Math.min(1, left / segs[i]);
      c.lineTo(lerp(points[i][0], points[i + 1][0], t), lerp(points[i][1], points[i + 1][1], t));
      left -= segs[i];
    }
    c.stroke();
  }

  private glyph(st: Status, x: number, y: number, d: number, alpha: number, since: number) {
    const c = this.ctx, r = d / 2, lw = Math.max(1, d * .12), p = this.pal;
    const t = (performance.now() - since) / 420, pop = this.reduce || t >= 1 ? 1 : backOut(t);
    c.globalAlpha = alpha;
    if (st === "done" || st === "blocked") {
      this.circle(x, y, r * (st === "done" ? pop : 1)); c.fillStyle = st === "done" ? p.success : p.danger; c.fill();
      c.strokeStyle = p.surface; c.lineWidth = lw * 1.15; c.lineCap = "round"; c.lineJoin = "round";
      if (st === "done") this.partial([[x - r * .4, y + r * .02], [x - r * .1, y + r * .32], [x + r * .42, y - r * .28]], this.reduce ? 1 : clamp(t * 1.4 - .15, 0, 1));
      else { c.beginPath(); c.moveTo(x - r * .42, y); c.lineTo(x + r * .42, y); c.stroke(); }
      return;
    }
    this.circle(x, y, r - lw / 2); c.strokeStyle = st === "todo" ? p.strong : p.accent; c.lineWidth = lw; c.stroke();
    if (st === "todo") return;
    c.beginPath(); c.moveTo(x, y); c.arc(x, y, r * .5, -Math.PI / 2, -Math.PI / 2 + Math.PI * (st === "review" ? 1.5 : 1)); c.closePath();
    c.fillStyle = p.accent; c.fill();
  }

  private avatar(person: number, x: number, y: number, d: number, alpha: number, ring = 0) {
    const c = this.ctx, face = this.faces[person], r = d / 2, p = this.pal;
    c.globalAlpha = alpha;
    if (ring > 0) { this.circle(x + r, y + r, r + ring); c.fillStyle = p.surface; c.fill(); }
    if (face && d >= 7) { c.drawImage(face, x, y, d, d); return; }
    this.circle(x + r, y + r, r);
    c.fillStyle = d < 10 ? p.strong : p.muted; c.fill();
    if (d >= 10) { c.lineWidth = 1; c.strokeStyle = p.border; c.stroke(); }
    if (d >= 16) this.text(PEOPLE[person].initials, x + r, y + r - d * .4 * .65, d * .4, 500, p.secondary, "center");
  }

  private intro(delay: number, now: number) {
    if (this.introT0 < 0) return 1;
    return easeOut((now - this.introT0 - delay) / 520);
  }

  private draw(now: number) {
    const { ctx: c, W, H, dpr, s } = this;
    if (!this.sized) return;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, W, H);
    this.items = [];
    const ox = W / 2 - this.cx * s, oy = H / 2 - this.cy * s;
    this.grid(ox, oy);
    c.textBaseline = "alphabetic";
    TEAM_NODE.forEach((id, ti) => this.drawTeam(NODES[id], ti, ox, oy, now));
    c.globalAlpha = 1;
    this.drawMini();
    this.placePanel();
    if (this.readout) {
      const z = s / this.fitS, t = `${z < 9.95 ? z.toFixed(1) : Math.round(z)}×`;
      if (t !== this.readText) { this.readText = t; this.readout.textContent = t; }
    }
  }

  /** A world-anchored dot grid that refines as you zoom, so depth reads even between regions. */
  private grid(ox: number, oy: number) {
    const c = this.ctx;
    c.fillStyle = this.pal.strong;
    for (const unit of [8, 32, 128, 512]) {
      const sp = unit * this.s;
      if (sp < 14 || sp > 420) continue;
      const a = smooth(14, 30, sp) * (1 - smooth(140, 420, sp)) * .55;
      if (a < .01) continue;
      c.globalAlpha = a;
      c.beginPath();
      const x0 = ((ox % sp) + sp) % sp, y0 = ((oy % sp) + sp) % sp;
      for (let x = x0; x < this.W; x += sp) for (let y = y0; y < this.H; y += sp) c.rect(x - .75, y - .75, 1.5, 1.5);
      c.fill();
    }
  }

  private drawTeam(n: MapNode, ti: number, ox: number, oy: number, now: number) {
    const { ctx: c, s, pal, W, H } = this;
    const k = this.intro(ti * 70, now);
    if (k <= 0) return;
    const x = n.x * s + ox, y = n.y * s + oy + (1 - k) * 18, w = n.w * s, h = n.h * s;
    if (x > W || y > H || x + w < 0 || y + h < 0) return;
    const a = k * this.dim[n.id], hv = this.hl.get(n.id) ?? 0;
    c.globalAlpha = a;
    this.rr(x, y, w, h, clamp(18 * s, 6, 30));
    c.fillStyle = pal.muted; c.fill();
    c.lineWidth = 1; c.strokeStyle = pal.border; c.stroke();
    if (hv > 0) { c.globalAlpha = a * hv; c.strokeStyle = pal.strong; c.stroke(); }

    const team = TEAMS[n.ref], pad = clamp(20 * s, 8, 28);
    const nameSize = clamp(28 * s, 11, 22), nameTop = y + clamp(14 * s, 2, 36);
    const pct = Math.round(this.shown[n.id] * 100);
    c.globalAlpha = a;
    this.text(this.fit(team.name, nameSize, 500, w - pad * 2 - 44), x + pad, nameTop, nameSize, 500, pal.fg);
    c.globalAlpha = a;
    const pctSize = clamp(20 * s, 11, 15);
    this.text(`${pct}%`, x + w - pad, nameTop + (nameSize - pctSize) * 1.01, pctSize, 500, pal.secondary, "right");
    const metaNat = 20 * s, ma = smooth(8.5, 10.5, metaNat);
    if (ma > .01) {
      const size = clamp(metaNat, 11, 13), top = Math.max(nameTop + nameSize * 1.3, y + 50 * s), d = size * 1.45;
      this.avatar(team.lead, x + pad, top + (size * 1.3 - d) / 2, d, a * ma);
      c.globalAlpha = a * ma;
      const st = this.stat(n.id);
      this.text(this.fit(`${PEOPLE[team.lead].name} · ${st.projects} projects · ${st.open} open tasks`, size, 400, w - pad * 2 - d - 6), x + pad + d + 6, top, size, 400, pal.secondary);
    }
    const ts = Math.min(1, k * 1.5);
    for (const pid of n.children) this.drawCard(NODES[pid], a * ts, ti, ox, oy + (1 - k) * 18, now);
  }

  private drawCard(n: MapNode, alpha: number, ti: number, ox: number, oy: number, now: number) {
    const { ctx: c, s, pal, W, H } = this;
    const x = n.x * s + ox, y = n.y * s + oy, w = n.w * s, h = n.h * s;
    if (x > W || y > H || x + w < 0 || y + h < 0 || w < 2) return;
    const a = alpha * this.dim[n.id], hv = this.hl.get(n.id) ?? 0, project = PROJECTS[n.ref];
    c.globalAlpha = a;
    this.rr(x, y, w, h, clamp(12 * s, 2.5, 26));
    c.fillStyle = pal.surface; c.fill();
    c.lineWidth = 1; c.strokeStyle = pal.border; c.stroke();
    if (hv > 0) { c.globalAlpha = a * hv; c.strokeStyle = pal.strong; c.stroke(); }

    const pad = CARD.pad * s, inner = w - pad * 2;
    const tNat = 13 * s, ta = smooth(9.6, 12, tNat);
    const mNat = 9.5 * s, ma = smooth(8.8, 11, mNat), mSize = clamp(mNat, 11, 13);
    const pct = Math.round(this.shown[n.id] * 100);
    if (ta > .01) {
      const size = clamp(tNat, 12, 20);
      c.globalAlpha = a * ta;
      this.text(this.fit(project.name, size, 500, inner - (ma > .01 ? this.width(`${pct}%`, mSize, 500) + 10 : 0)), x + pad, y + 11 * s, size, 500, pal.fg);
    }
    if (ma > .01) {
      const top = y + 31 * s, dot = mSize * .5, tone = project.health === "on-track" ? pal.success : project.health === "at-risk" ? pal.warning : pal.danger;
      c.globalAlpha = a * ma;
      this.circle(x + pad + dot / 2, top + mSize * .65, dot / 2); c.fillStyle = tone; c.fill();
      this.text(`${pct}%`, x + w - pad, y + 11 * s + (clamp(tNat, 12, 20) - mSize) * 1.01, mSize, 500, pal.secondary, "right");
      c.globalAlpha = a * ma;
      this.text(this.fit(`${HEALTH_LABEL[project.health]} · Due ${formatDay(project.due)}`, mSize, 400, inner - dot - 6), x + pad + dot + 6, top, mSize, 400, pal.secondary);
    }
    const by = y + CARD.bar * s, bh = clamp(3 * s, 1.5, 6);
    c.globalAlpha = a;
    this.rr(x + pad, by, inner, bh, bh / 2); c.fillStyle = pal.subtle; c.fill();
    this.rr(x + pad, by, Math.max(bh, inner * this.shown[n.id]), bh, bh / 2); c.fillStyle = pal.accent; c.fill();

    const cardIndex = TEAMS[ti].projects.indexOf(n.ref);
    let tileIndex = 0;
    for (const k of n.children) {
      const child = NODES[k];
      if (child.kind !== 3) continue;
      const ik = this.intro(ti * 70 + 180 + cardIndex * 45 + tileIndex++ * 16, now);
      if (ik > 0) this.drawTile(child, a * ik, ox, oy, ik);
    }
    this.drawPeople(n, project.people, a, x, y, w);
  }

  private drawPeople(n: MapNode, people: number[], a: number, x: number, y: number, w: number) {
    const { s, pal } = this;
    const d = CARD.avatar * s;
    if (d < 3 || y + CARD.people * s > this.H || y + (CARD.people + CARD.avatar) * s < 0) return;
    const top = y + CARD.people * s, ring = clamp(d * .09, .6, 2.5);
    const persons = n.children.filter(k => NODES[k].kind === 4);
    for (let j = people.length - 1; j >= 0; j--) {
      const px = x + (CARD.pad + j * CARD.step) * s, hv = this.hl.get(persons[j]) ?? 0;
      this.avatar(people[j], px, top, d, a, ring);
      if (hv > 0) { const c = this.ctx; c.globalAlpha = a * hv; this.circle(px + d / 2, top + d / 2, d / 2 + ring * .5); c.lineWidth = Math.max(1, ring); c.strokeStyle = pal.fg; c.stroke(); }
    }
    const nat = 9 * s, na = smooth(8.8, 11, nat);
    if (na < .01) return;
    const size = clamp(nat, 11, 13), tx = x + (CARD.pad + (people.length - 1) * CARD.step + CARD.avatar + 6) * s;
    const others = people.length - 1;
    this.ctx.globalAlpha = a * na;
    this.text(this.fit(others ? `${PEOPLE[people[0]].name} and ${others} ${others === 1 ? "other" : "others"}` : PEOPLE[people[0]].name, size, 400, x + w - CARD.pad * s - tx), tx, top + (d - size * 1.3) / 2, size, 400, pal.secondary);
  }

  private drawTile(n: MapNode, alpha: number, ox: number, oy: number, ik: number) {
    const { ctx: c, s, pal, W, H } = this;
    const task = n.ref, t = TASKS[task], st = this.model.status(task);
    let x = n.x * s + ox, y = n.y * s + oy, w = n.w * s, h = n.h * s;
    if (x > W || y > H || x + w < 0 || y + h < 0 || w < 1) return;
    if (ik < 1) { const sc = .55 + .45 * ik; x += (w * (1 - sc)) / 2; y += (h * (1 - sc)) / 2; w *= sc; h *= sc; }
    const spot = this.spot > 0 && n.parent === this.spotProject && t.assignee !== this.spotPerson ? 1 - .7 * this.spot : 1;
    const a = alpha * this.dim[n.id] * spot, hv = this.hl.get(n.id) ?? 0;
    const far = 1 - smooth(34, 64, w), r = clamp(4 * s, 1.5, 20);
    this.rr(x, y, w, h, r);
    if (far > 0) {
      const [fill, fa] = st === "done" ? [pal.fg, .13] : st === "progress" ? [pal.accent, .85] : st === "review" ? [pal.accent, .42] : st === "blocked" ? [pal.danger, .85] : [pal.strong, .6];
      c.globalAlpha = a * far * fa; c.fillStyle = fill; c.fill();
    }
    if (far < 1) { c.globalAlpha = a * (1 - far); c.fillStyle = pal.muted; c.fill(); }
    if (hv > 0) { c.globalAlpha = a * hv; c.lineWidth = 1; c.strokeStyle = pal.strong; c.stroke(); }
    if (w < 70) return;

    const med = smooth(70, 100, w), det = smooth(300, 420, w);
    const P = lerp(clamp(w * .07, 6, 12), clamp(w * .045, 14, 32), det);
    const size = lerp(clamp(4.6 * s, 11, 14), clamp(w * .034, 16, 28), det), lh = size * 1.28;
    const g = clamp(size * .92, 10, 14);
    const indent = (g + 6) * (1 - det);
    const titleTop = y + P + 26 * det;
    const footD = clamp(size * 1.35, 14, 20), footTop = y + h - P - footD;
    const maxLines = det > .5 ? 2 : clamp(Math.floor((footTop - 3 - titleTop) / lh), 1, 2);
    const detailOn = det > .01;
    if (detailOn) { c.save(); this.rr(x, y, w, h, r); c.clip(); }

    if (det < .99) this.glyph(st, x + P + g / 2, titleTop + lh / 2, g, a * med * (1 - det), this.statusT[task]);
    c.globalAlpha = a * med;
    const lines = this.wrap(t.title, size, 500, w - P * 2 - indent, maxLines);
    lines.forEach((line, i) => { c.globalAlpha = a * med; this.text(line, x + P + indent, titleTop + i * lh, size, 500, st === "done" ? pal.secondary : pal.fg); });

    const foot = med * (1 - det) * smooth(52, 70, h);
    if (foot > .01) {
      this.avatar(t.assignee, x + P, footTop, footD, a * foot);
      const fs = clamp(size * .88, 11, 12.5), done = this.model.done(task);
      c.globalAlpha = a * foot;
      this.text(st === "blocked" ? "Blocked" : `${done}/${t.checklist.length} · ${formatDay(t.due)}`, x + w - P, footTop + (footD - fs * 1.3) / 2, fs, st === "blocked" ? 500 : 400, st === "blocked" ? pal.danger : pal.faint, "right");
    }
    if (detailOn) this.drawDetail(task, st, x, y, w, h, P, titleTop + lines.length * lh, a * det);
    if (detailOn) c.restore();
  }

  /** The deepest level: a task opens into its brief, owner and a checklist you can tick. */
  private drawDetail(task: number, st: Status, x: number, y: number, w: number, h: number, P: number, below: number, a: number) {
    const { ctx: c, pal } = this;
    const t = TASKS[task], project = PROJECTS[t.project], bottom = y + h - P * .7;
    const fits = (b: number) => smooth(-4, 18, bottom - b);
    const ms = 13, g = 14;
    this.glyph(st, x + P + g / 2, y + P + ms * .65, g, a, this.statusT[task]);
    c.globalAlpha = a;
    this.text(STATUS_LABEL[st], x + P + g + 8, y + P, ms, 500, st === "blocked" ? pal.danger : pal.fg);
    const lw = this.width(STATUS_LABEL[st], ms, 500);
    c.globalAlpha = a;
    this.text(`· Due ${formatDay(t.due)} · ${t.points} ${t.points === 1 ? "point" : "points"}`, x + P + g + 8 + lw + 6, y + P, ms, 400, pal.secondary);
    c.globalAlpha = a;
    this.text(`${t.comments} ${t.comments === 1 ? "comment" : "comments"}`, x + w - P, y + P, ms, 400, pal.faint, "right");

    let yy = below + 8;
    const ds = clamp(w * .019, 13, 15), dlh = ds * 1.5;
    const desc = this.wrap(this.model.describe(task), ds, 400, Math.min(w - P * 2, 620), 3);
    desc.forEach((line, i) => { c.globalAlpha = a * fits(yy + (i + 1) * dlh); this.text(line, x + P, yy + i * dlh, ds, 400, pal.secondary); });
    yy += desc.length * dlh + 14;

    const rowA = a * fits(yy + 58);
    if (rowA > .01) {
      c.globalAlpha = rowA; c.fillStyle = pal.border; c.fillRect(x + P, yy, w - P * 2, 1);
      yy += 14;
      const d = 36;
      this.avatar(t.assignee, x + P, yy, d, rowA);
      c.globalAlpha = rowA;
      this.text(PEOPLE[t.assignee].name, x + P + d + 10, yy + 1, 14, 500, pal.fg);
      c.globalAlpha = rowA;
      this.text(PEOPLE[t.assignee].role, x + P + d + 10, yy + 19, 13, 400, pal.faint);
      c.globalAlpha = rowA;
      this.text(this.fit(`${project.name} · ${TEAMS[project.team].name}`, 13, 400, w - P * 2 - 220), x + w - P, yy + 10, 13, 400, pal.faint, "right");
      yy += d + 16;
    } else yy += 66;

    const headA = a * fits(yy + 20);
    const done = this.model.done(task), n = t.checklist.length;
    c.globalAlpha = headA;
    this.text("Checklist", x + P, yy, 13, 500, pal.fg);
    c.globalAlpha = headA;
    this.text(`${done} of ${n}`, x + P + this.width("Checklist", 13, 500) + 8, yy, 13, 400, pal.faint);
    const barW = Math.min(160, w * .22), bx = x + w - P - barW;
    c.globalAlpha = headA; this.rr(bx, yy + 7, barW, 4, 2); c.fillStyle = pal.subtle; c.fill();
    this.rr(bx, yy + 7, Math.max(4, (barW * done) / n), 4, 2); c.fillStyle = done === n ? pal.success : pal.accent; c.fill();
    yy += 26;

    const now = performance.now();
    t.checklist.forEach((label, i) => {
      const ia = a * fits(yy + 26);
      if (ia < .01) { yy += 28; return; }
      const on = this.model.checks[task][i], row = { task, item: i, x: x + P - 8, y: yy - 2, w: Math.min(w - P * 2 + 16, 420), h: 28 };
      const hot = (this.hoverItem === i && this.hoverNode === TASK_NODE[task]) || (this.cursorItem === i && this.view === TASK_NODE[task]);
      if (hot) { c.globalAlpha = ia; this.rr(row.x, row.y, row.w, row.h, 9); c.fillStyle = pal.muted; c.fill(); }
      const k = this.reduce ? 1 : clamp((now - this.itemT[task][i]) / 300, 0, 1), bs = 16, bxx = x + P, byy = yy + 4;
      c.globalAlpha = ia;
      this.rr(bxx, byy, bs, bs, 5);
      if (on) {
        const pop = k < 1 ? backOut(k) : 1;
        this.rr(bxx + (bs * (1 - pop)) / 2, byy + (bs * (1 - pop)) / 2, bs * pop, bs * pop, 5); c.fillStyle = pal.fg; c.fill();
        c.strokeStyle = pal.surface; c.lineWidth = 1.8; c.lineCap = "round"; c.lineJoin = "round";
        this.partial([[bxx + 4.2, byy + 8.4], [bxx + 7, byy + 11.2], [bxx + 12, byy + 5.4]], clamp(k * 1.5 - .2, 0, 1));
      } else { c.lineWidth = 1.25; c.strokeStyle = pal.strong; c.stroke(); }
      c.globalAlpha = ia;
      this.text(label, bxx + bs + 10, yy + 3, 14, 400, on ? pal.faint : pal.fg);
      if (ia > .5 && a > .6) this.items.push(row);
      yy += 28;
    });
  }

  private miniFrame() {
    const m = Math.min((this.mw - 12) / WORLD.w, (this.mh - 12) / WORLD.h);
    return { m, ox: (this.mw - WORLD.w * m) / 2, oy: (this.mh - WORLD.h * m) / 2 };
  }

  private drawMini() {
    const c = this.mctx;
    if (!c || !this.mw) return;
    const { m, ox, oy } = this.miniFrame(), p = this.pal;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.mw, this.mh);
    c.globalAlpha = 1;
    for (const id of TEAM_NODE) {
      const n = NODES[id];
      c.globalAlpha = .4 + .6 * this.dim[id];
      c.beginPath(); c.roundRect?.(ox + n.x * m, oy + n.y * m, n.w * m, n.h * m, 3); c.fillStyle = p.muted; c.fill(); c.lineWidth = 1; c.strokeStyle = p.border; c.stroke();
      for (const k of n.children) { const q = NODES[k]; c.fillStyle = p.strong; c.fillRect(ox + q.x * m, oy + q.y * m, q.w * m, q.h * m * .7); }
    }
    c.globalAlpha = 1;
    const vw = (this.W / this.s) * m, vh = (this.H / this.s) * m;
    let vx = ox + (this.cx * m) - vw / 2, vy = oy + (this.cy * m) - vh / 2, w = vw, h = vh;
    const min = 6;
    if (w < min) { vx -= (min - w) / 2; w = min; }
    if (h < min) { vy -= (min - h) / 2; h = min; }
    const x0 = clamp(vx, 1, this.mw - 1), y0 = clamp(vy, 1, this.mh - 1), x1 = clamp(vx + w, 1, this.mw - 1), y1 = clamp(vy + h, 1, this.mh - 1);
    c.beginPath(); c.roundRect?.(x0, y0, Math.max(2, x1 - x0), Math.max(2, y1 - y0), 2.5);
    c.globalAlpha = .14; c.fillStyle = p.accent; c.fill();
    c.globalAlpha = 1; c.lineWidth = 1.5; c.strokeStyle = p.accent; c.stroke();
  }

  /** The value card glides after the pointer, or sits beside the keyboard cursor. */
  private placePanel() {
    const el = this.panel;
    if (!el || this.hoverNode < 0 || this.hoverItem >= 0) return;
    const { W, H, pw, ph } = this;
    let tx: number, ty: number;
    if (this.cursor >= 0 || !this.mouse) {
      const r = this.screenRect(NODES[this.hoverNode]);
      tx = r.x + r.w + 12 + pw <= W - 8 ? r.x + r.w + 12 : r.x - 12 - pw;
      ty = r.y;
    } else {
      const m = this.mouse;
      tx = m.x + 18 + pw <= W - 8 ? m.x + 18 : m.x - 18 - pw;
      ty = m.y + 18 + ph <= H - 8 ? m.y + 18 : m.y - 18 - ph;
    }
    tx = clamp(tx, 8, Math.max(8, W - pw - 8)); ty = clamp(ty, 60, Math.max(60, H - ph - 8));
    if (!this.panelOn || this.reduce) { this.px = tx; this.py = ty; this.panelOn = true; }
    else { this.px += (tx - this.px) * .24; this.py += (ty - this.py) * .24; if (Math.abs(tx - this.px) + Math.abs(ty - this.py) > .3) this.lastAnim = performance.now(); }
    el.style.transform = `translate3d(${this.px.toFixed(1)}px, ${this.py.toFixed(1)}px, 0)`;
  }
}
