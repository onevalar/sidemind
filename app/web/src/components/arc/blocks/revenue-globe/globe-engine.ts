import { motionTokens } from "../../lib/motion-tokens";
import { CITIES, DAY, HQ, N, NOW, REGIONS, forEachTx, largestBefore, snapshotAt, type Snapshot, type Tx } from "./globe-data";
import { isLand } from "./globe-land";
import { DEG, clamp, cubicBezier, dot, normalize, rubberBand, slerp, smoothstep, springStep, toVec, type Vec } from "./globe-math";

export type Mode = "live" | "replay" | "paused";
export type Focus = { kind: "city" | "region"; index: number } | null;
export type EngineEvents = {
  tick: (snapshot: Snapshot) => void;
  frame: (clock: number, live: number) => void;
  hover: (city: number | null) => void;
  focus: (focus: Focus) => void;
  mode: (mode: Mode) => void;
  anchor: (city: number | null, x: number, y: number, shown: boolean) => void;
};

type Dots = { x: Float32Array; y: Float32Array; z: Float32Array; land: Uint8Array; count: number; step: number };
type Arc = { tx: Tx; born: number; dur: number; from: Vec; omega: number; lift: number; width: number; landed: boolean };
type Ripple = { city: number; born: number; dur: number; size: number; strong: boolean };
type Move = { from: Vec; to: Vec; omega: number; p: number; v: number; zoomFrom: number; zoomTo: number };
type Drag = { id: number; x0: number; y0: number; lon0: number; lat0: number; moved: boolean; touch: boolean; samples: { x: number; y: number; t: number }[] };

const REST_LAT = 22 * DEG;
const LAT_LIMIT = 66 * DEG;
/** Radians per second. The idle camera drifts back and forth across a band of longitudes that keeps headquarters in view. */
const AUTO_SPEED = .07;
const DRIFT_CENTER = -84 * DEG;
const DRIFT_RANGE = 46 * DEG;
const REPLAY_SPEED = 1500;
const CAMERA = { stiffness: 40, damping: 12.6 };
const ZOOM = { stiffness: 60, damping: 15.5 };
const NIGHT = .52;
const CITY_ZOOM = 1.3;
const REGION_ZOOM = 1.08;
const TICK_MS = 380;
/** Shade levels per dot kind (land, sea); each level is one canvas fill. */
const LEVELS = 8;
const easeArc = cubicBezier(...motionTokens.ease.inOut);
const easeEnter = cubicBezier(...motionTokens.ease.enter);

const HQ_VEC = toVec(CITIES[HQ].lat, CITIES[HQ].lon);
const CITY_VECS = CITIES.map(city => toVec(city.lat, city.lon));
/** Tangent frames at each city so ripples can be drawn as true circles on the sphere. */
const CITY_FRAMES = CITY_VECS.map(v => {
  const east = normalize([v[2], 0, -v[0]]);
  const north: Vec = [v[1] * east[2] - v[2] * east[1], v[2] * east[0] - v[0] * east[2], v[0] * east[1] - v[1] * east[0]];
  return { east, north };
});
const REGION_VECS = REGIONS.map((_, r) => normalize(CITY_VECS.reduce<Vec>((acc, v, i) => {
  const w = CITIES[i].region === r ? CITIES[i].weight : 0;
  return [acc[0] + v[0] * w, acc[1] + v[1] * w, acc[2] + v[2] * w];
}, [0, 0, 0])));

const dotCache = new Map<number, Dots>();
function buildDots(step: number): Dots {
  const cached = dotCache.get(step);
  if (cached) return cached;
  const xs: number[] = [], ys: number[] = [], zs: number[] = [], land: number[] = [];
  const grid = (spacing: number, keepLand: boolean) => {
    let row = 0;
    for (let lat = -90 + spacing / 2; lat < 90; lat += spacing, row++) {
      const count = Math.max(1, Math.round((360 * Math.cos(lat * DEG)) / spacing));
      for (let k = 0; k < count; k++) {
        const lon = -180 + ((k + (row % 2) * .5) * 360) / count;
        if (isLand(lon, lat) !== keepLand) continue;
        const v = toVec(lat, lon);
        xs.push(v[0]); ys.push(v[1]); zs.push(v[2]); land.push(keepLand ? 1 : 0);
      }
    }
  };
  grid(step, true);
  grid(step * 2.5, false);
  const dots = { x: Float32Array.from(xs), y: Float32Array.from(ys), z: Float32Array.from(zs), land: Uint8Array.from(land), count: xs.length, step };
  dotCache.set(step, dots);
  return dots;
}

/** Resolve any CSS color, including oklch, to an rgb() string the canvas understands everywhere. */
function readColors(host: HTMLElement) {
  const probe = document.createElement("span");
  probe.style.display = "none";
  host.appendChild(probe);
  const pixel = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  const read = (token: string, fallback: string) => {
    probe.style.color = fallback;
    probe.style.color = `var(${token}, ${fallback})`;
    const value = getComputedStyle(probe).color;
    if (!pixel) return value;
    pixel.clearRect(0, 0, 1, 1);
    pixel.fillStyle = fallback;
    pixel.fillStyle = value;
    pixel.fillRect(0, 0, 1, 1);
    const [r, g, b] = pixel.getImageData(0, 0, 1, 1).data;
    return `rgb(${r}, ${g}, ${b})`;
  };
  const colors = {
    fg: read("--foreground", "#111"), muted: read("--text-muted", "#888"), secondary: read("--text-secondary", "#555"),
    accent: read("--accent", "#333"), surface: read("--surface", "#fff"), border: read("--border", "#e5e5e5"),
  };
  probe.remove();
  return colors;
}

export class GlobeEngine {
  mode: Mode = "live";
  private ctx: CanvasRenderingContext2D | null;
  private colors = { fg: "#111", muted: "#888", secondary: "#555", accent: "#333", surface: "#fff", border: "#e5e5e5" };
  private font = "sans-serif";
  private dpr = 1; private w = 0; private h = 0; private baseR = 0;
  private dots: Dots | null = null;
  private px = new Float32Array(0); private py = new Float32Array(0); private bucket = new Int8Array(0); private order = new Int32Array(0);
  /** Per-frame bucket buffers, reused so the draw loop allocates nothing. */
  private counts = new Int32Array(LEVELS * 2); private offsets = new Int32Array(LEVELS * 2 + 1); private cursorAt = new Int32Array(LEVELS * 2);
  private cityX = new Float32Array(N); private cityY = new Float32Array(N); private cityZ = new Float32Array(N);
  private lon = -8 * DEG; private lat = REST_LAT; private zoom = .86;
  private vLon = -AUTO_SPEED * 6; private vLat = 0; private vZoom = 0; private drift = -1;
  private move: Move | null = null;
  private drag: Drag | null = null;
  private pointer = { x: 0, y: 0, inside: false };
  private hover: number | null = null;
  private peeked: number | null = null;
  private focus: Focus = null;
  private clock = NOW; private liveNow = NOW; private speed = 1; private catchUp = false;
  private scrubbing = false; private resume: Mode = "live";
  private arcs: Arc[] = []; private ripples: Ripple[] = []; private budget = 0;
  private stills: Tx[] = [];
  private snapshot: Snapshot;
  private started = 0; private last = 0; private lastTick = 0; private raf = 0;
  private onScreen = false; private pageVisible = true; private introStart = -1;
  private cursor = "";
  private tickKey = "";
  private observers: { disconnect(): void }[] = [];
  private cleanups: (() => void)[] = [];

  constructor(private canvas: HTMLCanvasElement, private host: HTMLElement, private reduced: boolean, private events: EngineEvents) {
    this.ctx = canvas.getContext("2d");
    this.snapshot = snapshotAt(NOW);
    this.started = performance.now();
    if (reduced) { this.lon = -45 * DEG; this.zoom = 1; this.vLon = 0; this.stills = largestBefore(NOW, 1500, 18); }
    this.refreshColors();

    const resize = new ResizeObserver(() => this.resize());
    resize.observe(host);
    const intersect = new IntersectionObserver(entries => {
      this.onScreen = entries.some(entry => entry.isIntersecting);
      if (this.onScreen && this.introStart < 0 && !reduced) this.introStart = performance.now() / 1000;
      this.schedule();
    });
    intersect.observe(host);
    const theme = new MutationObserver(() => this.refreshColors());
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-accent"] });
    this.observers.push(resize, intersect, theme);

    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    const onScheme = () => this.refreshColors();
    scheme.addEventListener("change", onScheme);
    const onVisibility = () => { this.pageVisible = document.visibilityState === "visible"; this.schedule(); };
    document.addEventListener("visibilitychange", onVisibility);
    const down = (event: PointerEvent) => this.pointerDown(event);
    const moveHandler = (event: PointerEvent) => this.pointerMove(event);
    const up = (event: PointerEvent) => this.pointerUp(event, false);
    const cancel = (event: PointerEvent) => this.pointerUp(event, true);
    const leave = () => { this.pointer.inside = false; this.schedule(); };
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", moveHandler);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", cancel);
    canvas.addEventListener("pointerleave", leave);
    this.cleanups.push(
      () => scheme.removeEventListener("change", onScheme),
      () => document.removeEventListener("visibilitychange", onVisibility),
      () => { canvas.removeEventListener("pointerdown", down); canvas.removeEventListener("pointermove", moveHandler); canvas.removeEventListener("pointerup", up); canvas.removeEventListener("pointercancel", cancel); canvas.removeEventListener("pointerleave", leave); },
    );
    this.resize();
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.observers.forEach(observer => observer.disconnect());
    this.cleanups.forEach(cleanup => cleanup());
  }

  // ---- Public controls -------------------------------------------------------------------------------------------

  select(next: Focus) {
    const same = next && this.focus && next.kind === this.focus.kind && next.index === this.focus.index;
    this.focus = same ? null : next;
    this.events.focus(this.focus);
    if (!this.focus) { this.move = null; this.schedule(); return; }
    const target = this.focus.kind === "city" ? CITY_VECS[this.focus.index] : REGION_VECS[this.focus.index];
    const lat = clamp(Math.asin(target[1]), -LAT_LIMIT, LAT_LIMIT);
    const lon = Math.atan2(target[0], target[2]);
    const to: Vec = [Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon)];
    const zoomTo = this.focus.kind === "city" ? CITY_ZOOM : REGION_ZOOM;
    if (this.reduced) { this.lon = lon; this.lat = lat; this.zoom = zoomTo; this.move = null; this.schedule(); return; }
    const from = this.center();
    const omega = Math.acos(clamp(dot(from, to), -1, 1));
    const carried = this.move ? (this.move.v * this.move.omega) / Math.max(omega, .05) : 0;
    this.move = { from, to, omega, p: 0, v: clamp(carried, 0, 3), zoomFrom: this.zoom, zoomTo };
    this.vLon = 0; this.vLat = 0;
    this.schedule();
  }

  clearFocus() { if (this.focus) this.select(this.focus); }

  /** Highlight a city from outside the canvas, for example while its row in the panel has focus. */
  peek(city: number | null) { this.peeked = city; this.schedule(); }

  nudge(dx: number, dy: number) {
    this.move = null;
    if (this.reduced) { this.lon += dx * .18; this.lat = clamp(this.lat + dy * .14, -LAT_LIMIT, LAT_LIMIT); }
    else { this.vLon += dx * 1.1; this.vLat += dy * .8; }
    this.schedule();
  }

  replayDay() { this.clock = 0; this.catchUp = false; this.speed = 1; this.setMode(this.reduced ? "paused" : "replay"); this.afterJump(); }

  togglePlay() {
    if (this.mode === "paused") this.setMode(this.clock >= this.liveNow - 1 ? "live" : "replay");
    else this.setMode("paused");
    this.catchUp = false;
  }

  goLive() {
    if (this.reduced || this.liveNow - this.clock < 2) { this.clock = this.liveNow; this.setMode("live"); this.afterJump(); return; }
    this.catchUp = true;
    this.setMode("replay");
  }

  seek(t: number) {
    this.clock = clamp(t, 0, this.liveNow);
    const atEdge = this.clock >= this.liveNow - 1;
    if (this.reduced) this.setMode(atEdge ? "live" : "paused");
    else if (this.mode !== "paused") this.setMode(atEdge ? "live" : "replay");
    this.catchUp = false;
    this.afterJump();
  }

  scrubStart() { if (!this.scrubbing) { this.resume = this.mode; this.scrubbing = true; this.setMode("paused"); } }
  scrubTo(t: number) { this.clock = clamp(t, 0, this.liveNow); this.afterJump(); }
  scrubEnd() {
    if (!this.scrubbing) return;
    this.scrubbing = false;
    const atEdge = this.clock >= this.liveNow - 1;
    if (this.reduced) this.setMode(atEdge ? "live" : "paused");
    else if (this.resume !== "paused") this.setMode(atEdge ? "live" : "replay");
  }

  get live() { return this.liveNow; }
  get time() { return this.clock; }

  // ---- Setup -----------------------------------------------------------------------------------------------------

  private refreshColors() {
    this.colors = readColors(this.host);
    this.font = getComputedStyle(this.host).fontFamily || "sans-serif";
    this.schedule();
  }

  private resize() {
    const rect = this.host.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = rect.width; this.h = rect.height;
    this.canvas.width = Math.round(rect.width * this.dpr);
    this.canvas.height = Math.round(rect.height * this.dpr);
    this.baseR = Math.min(rect.width, rect.height) * .41;
    // Keep land dots about 5.4px apart on screen whatever the globe's size.
    const step = Math.round(clamp(5.4 / (this.baseR * DEG), 1.2, 2.8) * 10) / 10;
    if (!this.dots || this.dots.step !== step) {
      this.dots = buildDots(step);
      this.px = new Float32Array(this.dots.count);
      this.py = new Float32Array(this.dots.count);
      this.bucket = new Int8Array(this.dots.count);
      this.order = new Int32Array(this.dots.count);
    }
    this.schedule(true);
  }

  private get running() { return this.onScreen && this.pageVisible; }

  /** Run the loop while on screen. With reduced motion, draw a single frame whenever something changes. */
  private schedule(force = false) {
    if (this.raf) return;
    if (!this.running && !force) return;
    this.raf = requestAnimationFrame(now => { this.raf = 0; this.frame(now); });
  }

  private setMode(mode: Mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode !== "replay") this.catchUp = false;
    this.events.mode(mode);
    this.schedule();
  }

  private afterJump() {
    this.arcs = this.arcs.filter(arc => arc.tx.t <= this.clock);
    if (this.reduced) this.stills = largestBefore(this.clock, 1500, 18);
    this.lastTick = 0;
    this.schedule();
  }

  private center(): Vec { return [Math.cos(this.lat) * Math.sin(this.lon), Math.sin(this.lat), Math.cos(this.lat) * Math.cos(this.lon)]; }

  // ---- Pointer ---------------------------------------------------------------------------------------------------

  private local(event: PointerEvent) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private pointerDown(event: PointerEvent) {
    if (event.button !== 0) return;
    const { x, y } = this.local(event);
    this.canvas.setPointerCapture(event.pointerId);
    this.drag = { id: event.pointerId, x0: x, y0: y, lon0: this.lon, lat0: this.lat, moved: false, touch: event.pointerType !== "mouse", samples: [{ x, y, t: event.timeStamp }] };
  }

  private pointerMove(event: PointerEvent) {
    const { x, y } = this.local(event);
    this.pointer = { x, y, inside: event.pointerType === "mouse" };
    const drag = this.drag;
    if (drag && drag.id === event.pointerId) {
      const dx = x - drag.x0, dy = drag.touch ? 0 : y - drag.y0;
      if (!drag.moved && Math.hypot(dx, dy) > 4) {
        drag.moved = true;
        drag.x0 = x; drag.y0 = drag.touch ? drag.y0 : y; drag.lon0 = this.lon; drag.lat0 = this.lat;
        this.move = null;
      }
      if (drag.moved) {
        const r = this.baseR * this.zoom;
        this.lon = drag.lon0 - (x - drag.x0) / r;
        const raw = drag.lat0 + (drag.touch ? 0 : (y - drag.y0) / r);
        const over = Math.abs(raw) - LAT_LIMIT;
        this.lat = over > 0 ? Math.sign(raw) * (LAT_LIMIT + rubberBand(over, .45)) : raw;
        this.vLon = 0; this.vLat = 0;
      }
      drag.samples.push({ x, y, t: event.timeStamp });
      while (drag.samples.length > 2 && event.timeStamp - drag.samples[0].t > 90) drag.samples.shift();
    }
    this.schedule();
  }

  private pointerUp(event: PointerEvent, cancelled: boolean) {
    const drag = this.drag;
    if (!drag || drag.id !== event.pointerId) return;
    this.drag = null;
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    if (cancelled) return;
    if (!drag.moved) { this.click(this.local(event)); return; }
    if (this.reduced) return;
    const first = drag.samples[0], last = drag.samples[drag.samples.length - 1];
    const dt = Math.max(16, last.t - first.t) / 1000;
    const r = this.baseR * this.zoom;
    this.vLon = clamp(-(last.x - first.x) / dt / r, -7, 7);
    this.vLat = drag.touch ? 0 : clamp((last.y - first.y) / dt / r, -5, 5);
    this.schedule();
  }

  private hitCity(x: number, y: number, radius: number) {
    let best: number | null = null, bestDistance = radius;
    for (let i = 0; i < N; i++) {
      if (this.cityZ[i] <= .05) continue;
      const distance = Math.hypot(this.cityX[i] - x, this.cityY[i] - y);
      if (distance < bestDistance) { best = i; bestDistance = distance; }
    }
    return best;
  }

  private click({ x, y }: { x: number; y: number }) {
    const city = this.hitCity(x, y, 18);
    if (city !== null) { this.select({ kind: "city", index: city }); return; }
    const r = this.baseR * this.zoom;
    const vx = (x - this.w / 2) / r, vy = (this.h / 2 - y) / r;
    if (vx * vx + vy * vy >= 1) { this.clearFocus(); return; }
    // Unproject the click, then pick the region of the nearest customer city.
    const vz = Math.sqrt(1 - vx * vx - vy * vy);
    const sinLat = Math.sin(this.lat), cosLat = Math.cos(this.lat), sinLon = Math.sin(this.lon), cosLon = Math.cos(this.lon);
    const wy = vy * cosLat + vz * sinLat;
    const z1 = -vy * sinLat + vz * cosLat;
    const point: Vec = [vx * cosLon + z1 * sinLon, wy, -vx * sinLon + z1 * cosLon];
    let nearest = 0, best = -2;
    CITY_VECS.forEach((v, i) => { const d = dot(v, point); if (d > best) { best = d; nearest = i; } });
    this.select({ kind: "region", index: CITIES[nearest].region });
  }

  // ---- Simulation ------------------------------------------------------------------------------------------------

  private advance(dt: number, real: number) {
    if (!this.reduced) this.liveNow = Math.min(DAY - 1, NOW + (performance.now() - this.started) / 1000);
    const previous = this.clock;
    if (this.mode === "live") this.clock = this.liveNow;
    else if (this.mode === "replay") {
      const remaining = this.liveNow - this.clock;
      const cap = this.catchUp ? 40000 : REPLAY_SPEED;
      const target = clamp(remaining * (this.catchUp ? 2.4 : 1.2), 2, cap);
      this.speed += (target - this.speed) * (1 - Math.exp(-dt / .3));
      this.clock = Math.min(this.liveNow, this.clock + this.speed * dt);
      if (this.liveNow - this.clock < 1) { this.clock = this.liveNow; this.setMode("live"); }
    }
    if (this.clock < previous) this.afterJump();
    else if (this.clock > previous && !this.reduced) this.spawn(previous, this.clock, dt, real);
  }

  private spawn(from: number, to: number, dt: number, real: number) {
    const live = this.mode === "live" && to - from < 3;
    if (!live && to - from > 3 * 3600) return;
    const crossed: Tx[] = [];
    forEachTx(from, to, tx => { crossed.push(tx); });
    if (!crossed.length) { this.budget = Math.min(3, this.budget + dt * 8); return; }
    let chosen = crossed;
    if (!live) {
      this.budget = Math.min(3, this.budget + dt * 8);
      const take = Math.floor(this.budget);
      chosen = take ? crossed.sort((a, b) => b.amount - a.amount).slice(0, take) : [];
      this.budget -= chosen.length;
    }
    for (const tx of chosen.slice(0, 6)) this.launch(tx, real);
    if (this.arcs.length > 80) this.arcs.splice(0, this.arcs.length - 80);
  }

  private launch(tx: Tx, real: number) {
    const size = clamp(Math.log10(tx.amount / 5) / 3.8, 0, 1);
    if (tx.city === HQ) { this.ripples.push({ city: HQ, born: real, dur: 1, size, strong: true }); return; }
    const from = CITY_VECS[tx.city];
    const omega = Math.acos(clamp(dot(from, HQ_VEC), -1, 1));
    const reach = omega / Math.PI;
    this.arcs.push({ tx, born: real, dur: 1.05 + reach * 1.1, from, omega, lift: .04 + reach * .24, width: 1 + size * 1.6, landed: false });
    this.ripples.push({ city: tx.city, born: real, dur: .8, size: size * .6, strong: false });
  }

  private updateCamera(dt: number, real: number) {
    if (this.drag?.moved) return;
    if (this.move) {
      const move = this.move;
      [move.p, move.v] = springStep(move.p, move.v, 1, CAMERA.stiffness, CAMERA.damping, dt);
      const p = clamp(move.p, 0, 1.02);
      const c = slerp(move.from, move.to, p, move.omega);
      this.lat = Math.asin(clamp(c[1], -1, 1));
      this.lon = Math.atan2(c[0], c[2]);
      // Pull back a little mid-flight on long moves, like a camera clearing the horizon.
      this.zoom = move.zoomFrom + (move.zoomTo - move.zoomFrom) * p - Math.sin(Math.PI * clamp(p, 0, 1)) * .16 * (move.omega / Math.PI);
      if (Math.abs(move.p - 1) < 5e-4 && Math.abs(move.v) < 5e-3) this.move = null;
      return;
    }
    const intro = this.introStart < 0 ? 0 : 1 - smoothstep(0, 1.6, real - this.introStart);
    const offset = Math.atan2(Math.sin(this.lon - DRIFT_CENTER), Math.cos(this.lon - DRIFT_CENTER));
    if (offset < -DRIFT_RANGE) this.drift = 1;
    else if (offset > DRIFT_RANGE) this.drift = -1;
    const target = this.reduced || this.focus ? 0 : AUTO_SPEED * this.drift * (1 + intro * 5);
    this.vLon += (target - this.vLon) * (1 - Math.exp(-dt / (intro > 0 ? .5 : 1.4)));
    this.lon += this.vLon * dt;
    const restLat = this.focus ? clamp(this.lat, -LAT_LIMIT, LAT_LIMIT) : REST_LAT;
    [this.lat, this.vLat] = springStep(this.lat, this.vLat, restLat, 9, 6, dt);
    const zoomTarget = this.focus ? (this.focus.kind === "city" ? CITY_ZOOM : REGION_ZOOM) : 1;
    [this.zoom, this.vZoom] = springStep(this.zoom, this.vZoom, zoomTarget, ZOOM.stiffness, ZOOM.damping, dt);
    if (this.reduced) { this.zoom = zoomTarget; this.vZoom = 0; this.vLat = 0; }
  }

  // ---- Frame -----------------------------------------------------------------------------------------------------

  private frame(now: number) {
    const real = now / 1000;
    const dt = this.last ? clamp((now - this.last) / 1000, 0, .05) : 1 / 60;
    this.last = now;
    this.advance(dt, real);
    this.updateCamera(dt, real);
    this.draw(real);
    this.updateHover();
    if (now - this.lastTick > (this.mode === "live" ? TICK_MS : TICK_MS * .45)) {
      this.lastTick = now;
      const pending = this.arcs.filter(arc => !arc.landed && arc.tx.t <= this.clock).map(arc => arc.tx);
      const key = `${this.clock}|${pending.map(tx => tx.id).join(",")}`;
      if (key !== this.tickKey) {
        this.tickKey = key;
        this.snapshot = snapshotAt(this.clock, pending);
        this.events.tick(this.snapshot);
      }
    }
    this.events.frame(this.clock, this.liveNow);
    if (this.reduced) { this.last = 0; return; }
    if (this.running) this.schedule(); else this.last = 0;
  }

  private updateHover() {
    const next = this.pointer.inside && !this.drag?.moved ? this.hitCity(this.pointer.x, this.pointer.y, 14) : null;
    if (next !== this.hover) { this.hover = next; this.events.hover(next); }
    const cursor = this.drag?.moved ? "grabbing" : next !== null ? "pointer" : "grab";
    if (cursor !== this.cursor) { this.cursor = cursor; this.canvas.style.cursor = cursor; }
    const shown = this.hover ?? this.peeked ?? (this.focus?.kind === "city" ? this.focus.index : null);
    if (shown === null) this.events.anchor(null, 0, 0, false);
    else this.events.anchor(shown, this.cityX[shown], this.cityY[shown], this.cityZ[shown] > .08);
  }

  private draw(real: number) {
    const ctx = this.ctx;
    const dots = this.dots;
    if (!ctx || !dots || !this.w) return;
    const { fg, accent, surface, border, secondary } = this.colors;
    const w = this.w, h = this.h, cx = w / 2, cy = h / 2, r = this.baseR * this.zoom;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.globalAlpha = 1;

    const sinLat = Math.sin(this.lat), cosLat = Math.cos(this.lat), sinLon = Math.sin(this.lon), cosLon = Math.cos(this.lon);
    const project = (x: number, y: number, z: number, out: number[]) => {
      const x1 = x * cosLon - z * sinLon;
      const z1 = x * sinLon + z * cosLon;
      out[0] = cx + r * x1;
      out[1] = cy - r * (y * cosLat - z1 * sinLat);
      out[2] = y * sinLat + z1 * cosLat;
      out[3] = x1 * x1 + (y * cosLat - z1 * sinLat) ** 2;
      return out;
    };
    const p: number[] = [0, 0, 0, 0];

    // The sphere: a faint disc and a hairline limb give the dots something to sit on.
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = fg;
    ctx.globalAlpha = .028;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    ctx.stroke();

    // Dots, depth-shaded toward the limb and dimmed on the night side. Bucketed so each shade is one fill.
    const sunLon = (12 - this.clock / 3600) * 15 * DEG;
    const sunX = Math.sin(sunLon), sunZ = Math.cos(sunLon);
    const intro = this.introStart < 0 ? (this.reduced ? 1 : 0) : easeEnter(clamp((real - this.introStart) / 1.5, 0, 1));
    const reveal = intro * (Math.PI / 2 + .5);
    const counts = this.counts;
    counts.fill(0);
    const { x: dx, y: dy, z: dz, land, count } = dots;
    for (let i = 0; i < count; i++) {
      const x1 = dx[i] * cosLon - dz[i] * sinLon;
      const z1 = dx[i] * sinLon + dz[i] * cosLon;
      const vz = dy[i] * sinLat + z1 * cosLat;
      if (vz <= 0) { this.bucket[i] = -1; continue; }
      let shade = .16 + .84 * Math.pow(vz, .65);
      const light = smoothstep(-.12, .16, dx[i] * sunX + dz[i] * sunZ);
      shade *= NIGHT + (1 - NIGHT) * light;
      if (intro < 1) shade *= smoothstep(reveal, reveal - .45, Math.acos(Math.min(1, vz)));
      if (shade < .02) { this.bucket[i] = -1; continue; }
      const b = Math.min(LEVELS - 1, Math.floor(shade * LEVELS)) + (land[i] ? 0 : LEVELS);
      this.bucket[i] = b;
      this.px[i] = cx + r * x1;
      this.py[i] = cy - r * (dy[i] * cosLat - z1 * sinLat);
      counts[b]++;
    }
    const offsets = this.offsets;
    for (let b = 0; b < LEVELS * 2; b++) offsets[b + 1] = offsets[b] + counts[b];
    const cursor = this.cursorAt;
    cursor.set(offsets.subarray(0, LEVELS * 2));
    for (let i = 0; i < count; i++) { const b = this.bucket[i]; if (b >= 0) this.order[cursor[b]++] = i; }
    const spacing = dots.step * DEG * r;
    const landR = clamp(spacing * .2, .75, 1.6);
    const seaR = clamp(spacing * .12, .5, .9);
    ctx.fillStyle = fg;
    for (let b = 0; b < LEVELS * 2; b++) {
      if (offsets[b] === offsets[b + 1]) continue;
      const isLandBucket = b < LEVELS;
      const shade = ((b % LEVELS) + .5) / LEVELS;
      ctx.globalAlpha = shade * (isLandBucket ? .6 : .22);
      ctx.beginPath();
      const radius = isLandBucket ? landR * (.7 + .3 * shade) : seaR;
      for (let k = offsets[b]; k < offsets[b + 1]; k++) {
        const i = this.order[k];
        if (isLandBucket) { ctx.moveTo(this.px[i] + radius, this.py[i]); ctx.arc(this.px[i], this.py[i], radius, 0, Math.PI * 2); }
        else ctx.rect(this.px[i] - radius, this.py[i] - radius, radius * 2, radius * 2);
      }
      ctx.fill();
    }

    // Cities, sized by revenue so far today.
    const focus = this.focus;
    const inFocus = (city: number) => !focus || (focus.kind === "city" ? focus.index === city || city === HQ : CITIES[city].region === focus.index || city === HQ);
    let maxRevenue = 1;
    for (let i = 0; i < N; i++) maxRevenue = Math.max(maxRevenue, this.snapshot.cityRevenue[i]);
    for (let i = 0; i < N; i++) {
      const v = CITY_VECS[i];
      project(v[0], v[1], v[2], p);
      this.cityX[i] = p[0]; this.cityY[i] = p[1]; this.cityZ[i] = p[2];
      if (p[2] <= 0 || i === HQ) continue;
      const size = 1.3 + 2.1 * Math.sqrt(Math.max(0, this.snapshot.cityRevenue[i]) / maxRevenue);
      ctx.globalAlpha = (.25 + .75 * p[2]) * (inFocus(i) ? .72 : .25) * Math.min(1, intro * 1.4);
      ctx.fillStyle = fg;
      ctx.beginPath();
      ctx.arc(p[0], p[1], size, 0, Math.PI * 2);
      ctx.fill();
    }

    // Arcs lift off the surface along great circles, draw in, land with a ripple, then retract into headquarters.
    const hold = .12;
    const survivors: Arc[] = [];
    const sample: number[] = [0, 0, 0, 0];
    /**
     * Depth of a projected point from 0 (hidden) to 4 (in front). Points behind the sphere are hidden inside its
     * silhouette and fade out with depth outside it, so arcs rise over the horizon instead of popping in.
     */
    const depth = (point: number[]) => point[2] >= 0 ? 4 : point[3] > 1 ? Math.round(smoothstep(-.4, 0, point[2]) * 4) : 0;
    const drawPath = (arc: Arc, tail: number, head: number, lift: number, alpha: number) => {
      const steps = Math.max(2, Math.ceil((head - tail) * 56));
      const sinO = Math.sin(arc.omega);
      let prevX = 0, prevY = 0, prevLevel = 0, openLevel = 0;
      for (let k = 0; k <= steps; k++) {
        const s = tail + ((head - tail) * k) / steps;
        const wa = Math.sin((1 - s) * arc.omega) / sinO, wb = Math.sin(s * arc.omega) / sinO;
        const height = 1 + lift * Math.sin(Math.PI * s);
        project((arc.from[0] * wa + HQ_VEC[0] * wb) * height, (arc.from[1] * wa + HQ_VEC[1] * wb) * height, (arc.from[2] * wa + HQ_VEC[2] * wb) * height, sample);
        const level = depth(sample);
        const segment = k ? Math.min(level, prevLevel) : 0;
        if (segment !== openLevel) {
          if (openLevel) ctx.stroke();
          if (segment) { ctx.globalAlpha = (alpha * segment) / 4; ctx.beginPath(); ctx.moveTo(prevX, prevY); }
          openLevel = segment;
        }
        if (openLevel) ctx.lineTo(sample[0], sample[1]);
        prevX = sample[0]; prevY = sample[1]; prevLevel = level;
      }
      if (openLevel) ctx.stroke();
      return prevLevel / 4;
    };
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const arcs = this.reduced ? [] : this.arcs;
    for (const arc of arcs) {
      const age = real - arc.born;
      const retract = arc.dur * .55;
      if (age > arc.dur + hold + retract) continue;
      survivors.push(arc);
      if (!arc.landed && age >= arc.dur) {
        arc.landed = true;
        this.ripples.push({ city: HQ, born: arc.born + arc.dur, dur: 1.1, size: (arc.width - 1) / 1.6, strong: true });
      }
      const head = age < arc.dur ? easeArc(age / arc.dur) : 1;
      const tail = age < arc.dur + hold ? 0 : easeArc((age - arc.dur - hold) / retract);
      const fade = age < arc.dur + hold ? 1 : 1 - .6 * tail;
      const dim = inFocus(arc.tx.city) ? 1 : .22;
      if (head - tail < .002) continue;
      // The ground track: the route traced faintly on the surface under the lifted arc.
      ctx.strokeStyle = fg;
      ctx.lineWidth = 1;
      drawPath(arc, tail, head, 0, .1 * fade * dim);
      ctx.strokeStyle = accent;
      ctx.lineWidth = arc.width;
      const headDepth = drawPath(arc, tail, head, arc.lift, .92 * fade * dim);
      if (age < arc.dur && headDepth > 0) {
        ctx.globalAlpha = .92 * dim * headDepth;
        ctx.fillStyle = accent;
        ctx.beginPath();
        ctx.arc(sample[0], sample[1], arc.width * .9 + 1.1, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (!this.reduced) this.arcs = survivors;

    // The still frame for reduced motion: the day's largest recent payments, drawn in full.
    if (this.reduced) {
      for (const tx of this.stills) {
        const from = CITY_VECS[tx.city];
        const omega = Math.acos(clamp(dot(from, HQ_VEC), -1, 1));
        const size = clamp(Math.log10(tx.amount / 5) / 3.8, 0, 1);
        const arc: Arc = { tx, born: 0, dur: 1, from, omega, lift: .04 + (omega / Math.PI) * .24, width: 1 + size * 1.6, landed: true };
        ctx.strokeStyle = accent;
        ctx.lineWidth = arc.width;
        drawPath(arc, 0, 1, arc.lift, .7 * (inFocus(tx.city) ? 1 : .22));
      }
    }

    // Ripples are true circles on the sphere, so they flatten into ellipses toward the limb.
    const ring: number[] = [0, 0, 0, 0];
    this.ripples = this.ripples.filter(ripple => real - ripple.born < ripple.dur);
    for (const ripple of this.ripples) {
      const age = real - ripple.born;
      if (age < 0) continue;
      const t = age / ripple.dur;
      const v = CITY_VECS[ripple.city];
      if (this.cityZ[ripple.city] <= .02) continue;
      const { east, north } = CITY_FRAMES[ripple.city];
      const radius = easeEnter(t) * (ripple.strong ? .045 + ripple.size * .05 : .02 + ripple.size * .03);
      const cosR = Math.cos(radius), sinR = Math.sin(radius);
      ctx.strokeStyle = ripple.strong ? accent : fg;
      ctx.globalAlpha = Math.pow(1 - t, 1.6) * (ripple.strong ? .85 : .45) * (inFocus(ripple.city) ? 1 : .3);
      ctx.lineWidth = ripple.strong ? 1.4 : 1;
      ctx.beginPath();
      for (let k = 0; k <= 28; k++) {
        const a = (k / 28) * Math.PI * 2;
        const ca = Math.cos(a) * sinR, sa = Math.sin(a) * sinR;
        project(v[0] * cosR + east[0] * ca + north[0] * sa, v[1] * cosR + east[1] * ca + north[1] * sa, v[2] * cosR + east[2] * ca + north[2] * sa, ring);
        if (k) ctx.lineTo(ring[0], ring[1]); else ctx.moveTo(ring[0], ring[1]);
      }
      ctx.stroke();
    }

    // Headquarters, where every arc lands.
    const hqZ = this.cityZ[HQ];
    if (hqZ > 0) {
      const x = this.cityX[HQ], y = this.cityY[HQ];
      const alpha = (.35 + .65 * hqZ) * Math.min(1, intro * 1.4);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = surface;
      ctx.beginPath(); ctx.arc(x, y, 5.2, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = accent;
      ctx.beginPath(); ctx.arc(x, y, 3.6, 0, Math.PI * 2); ctx.fill();
      this.label("San Francisco", x + 10, y + 4, alpha, secondary, surface, 400);
    }

    // Labels for the selection and the pointer.
    const labelled = new Set<number>();
    const placed: number[][] = [];
    if (focus?.kind === "city") labelled.add(focus.index);
    if (focus?.kind === "region") {
      const revenue = this.snapshot.cityRevenue;
      CITIES.map((_, i) => i).filter(i => CITIES[i].region === focus.index && i !== HQ).sort((a, b) => revenue[b] - revenue[a]).slice(0, 3).forEach(i => labelled.add(i));
    }
    if (this.hover !== null) labelled.add(this.hover);
    if (this.peeked !== null) labelled.add(this.peeked);
    for (const i of labelled) {
      const z = this.cityZ[i];
      if (z <= .08 || i === HQ) continue;
      const x = this.cityX[i], y = this.cityY[i];
      const strong = focus?.kind === "city" && focus.index === i;
      ctx.globalAlpha = .4 + .6 * z;
      ctx.strokeStyle = strong ? accent : fg;
      ctx.lineWidth = 1.25;
      ctx.beginPath(); ctx.arc(x, y, 7.5, 0, Math.PI * 2); ctx.stroke();
      if (this.hover === i || this.peeked === i || strong) continue;
      // Skip a label that would collide with one already placed; its ring still marks the city.
      const box = [x + 9, y - 9, x + 15 + CITIES[i].name.length * 6.6, y + 8];
      if (placed.some(other => box[0] < other[2] && box[2] > other[0] && box[1] < other[3] && box[3] > other[1])) continue;
      placed.push(box);
      this.label(CITIES[i].name, x + 11, y + 4, .4 + .6 * z, fg, surface, 500);
    }
    ctx.globalAlpha = 1;
  }

  private label(text: string, x: number, y: number, alpha: number, color: string, halo: string, weight: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.font = `${weight} 12px ${this.font}`;
    ctx.globalAlpha = alpha;
    ctx.lineJoin = "round";
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = halo;
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }
}
