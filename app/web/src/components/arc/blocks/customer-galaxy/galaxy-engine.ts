import { ACCOUNTS, categoriesOf, categoryOf, type GroupKey } from "./galaxy-data";

/** Canvas colors resolved from CSS variables: dot fills by health index, then the hover ring and the selection ring. */
export type Palette = { dots: string[]; ring: string; accent: string };
export type Cluster = { x: number; y: number; r: number };
export type EngineEvents = {
  hover: (index: number) => void;
  select: (index: number) => void;
  settle: (settled: boolean) => void;
  focus: (cluster: number) => void;
  view: (zoomed: boolean) => void;
  interact: () => void;
};

const N = ACCOUNTS.length;
const DT = 1 / 120;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
/** Seconds the simulation takes to cool; labels arrive a little before it ends. */
const COOL = 1.2;
const SETTLE_AT = .95;
const SPRING_K = 42;
const ZETA = .74;
const SWIRL = .85;
const PAD = 1.1;
const DENSITY = .8;
const LABEL_BAND = 48;
const CONTROLS_BAND = 34;
const DRIFT = .028;
const PERSPECTIVE = 1150;
/** The single galaxy is seen at an angle; clusters face the camera. Radians. */
const GALAXY_TILT = .82;
const LENS_SIGMA = 26;
const LENS_MAG = .85;
/** Health index drawn first to last, so status colors sit above the neutral mass. */
const DOT_ALPHA = [.72, .95, .95, .95];
const LEVELS = 7;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const rubber = (over: number, dim: number) => (1 - 1 / (over * .55 / dim + 1)) * dim;
const band = (v: number, lo: number, hi: number, dim: number) => v < lo ? lo - rubber(lo - v, dim) : v > hi ? hi + rubber(v - hi, dim) : v;
const hash = (i: number) => { let x = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b); x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35); return ((x ^ (x >>> 16)) >>> 0) / 4294967296; };

type Pointer = { x: number; y: number; type: string };
type Drag = { id: number; sx: number; sy: number; lx: number; ly: number; lt: number; moved: boolean; rawX: number; rawY: number; vx: number; vy: number; type: string };
type Pinch = { d0: number; z0: number; wx: number; wy: number };

/** Owns the simulation, the camera and the canvas. React only hears about discrete changes. */
export class GalaxyEngine {
  private ctx: CanvasRenderingContext2D | null;
  private w = 0; private h = 0; private dpr = 1;
  private base = new Float32Array(N);
  private rad = new Float32Array(N);
  private invMass = new Float32Array(N);
  private px = new Float32Array(N); private py = new Float32Array(N);
  private vx = new Float32Array(N); private vy = new Float32Array(N);
  private tx = new Float32Array(N); private ty = new Float32Array(N);
  private delay = new Float32Array(N);
  private lift = new Float32Array(N);
  private alpha = new Float32Array(N).fill(1);
  private alphaT = new Float32Array(N).fill(1);
  private cat = new Uint8Array(N);
  private health = new Uint8Array(N);
  private sx = new Float32Array(N); private sy = new Float32Array(N); private sr = new Float32Array(N);
  private visibleDot = new Uint8Array(N);
  private bucketOf = new Uint8Array(N);
  private drawOrder = new Int32Array(N);
  // Collision grid buffers, reused every step.
  private stamp = new Int32Array(N);
  private cellCount = new Int32Array(1);
  private cellItems = new Int32Array(1);
  private cellFill = new Int32Array(1);

  private group: GroupKey = "all";
  private clusters: Cluster[] = [];
  private bounds = { x0: -1, y0: -1, x1: 1, y1: 1 };
  private fitZ = 1;
  private simT = 99; private simActive = false; private swirl = 1; private settled = true; private intro = false;

  private cam = { x: 0, y: 0, lz: 0, vx: 0, vy: 0, vz: 0, tx: 0, ty: 0, tz: 0, omega: 9 };
  private anchor: { wx: number; wy: number; sx: number; sy: number } | null = null;
  private tilt = { x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0 };
  private plane = { a: 0, v: 0, t: 0 };
  private drift = 1;
  private lens = 0;
  private zoomed = false;
  private focusCluster = -1;

  private pointers = new Map<number, Pointer>();
  private drag: Drag | null = null;
  private pinch: Pinch | null = null;
  private mouse = { x: 0, y: 0, inside: false, fine: true };
  private lastTap = { t: -1, x: 0, y: 0 };
  private hovered = -1; private selected = -1; private keyboard = false;

  private cardEl: HTMLElement | null = null;
  private card = { x: 0, y: 0, vx: 0, vy: 0, w: 240, h: 150, shown: false };
  private labelEls: (HTMLElement | null)[] = [];

  private raf = 0; private last = 0; private acc = 0;
  /** True while any spring, fade or drift still has somewhere to go; the loop sleeps once everything rests. */
  private busy = true;
  private counts = new Int32Array((LEVELS + 1) * 4 + 1);
  private fillAt = new Int32Array((LEVELS + 1) * 4 + 1);
  private visible = false; private hidden = false; private introPending = true;
  private relayoutTimer: ReturnType<typeof setTimeout> | undefined;
  private reduced = false;
  private palette: Palette = { dots: ["#8a8a8a", "#1f8a4c", "#b7791f", "#c53030"], ring: "#111", accent: "#333" };

  constructor(private canvas: HTMLCanvasElement, private events: EngineEvents) {
    this.ctx = canvas.getContext("2d");
    let maxBase = 0;
    ACCOUNTS.forEach((a, i) => { this.base[i] = 10 + Math.sqrt(a.mrr); this.health[i] = a.health; maxBase = Math.max(maxBase, this.base[i]); });
    for (let i = 0; i < N; i++) this.invMass[i] = 1 / (1 + .9 * this.base[i] / maxBase);
  }

  // ---- lifecycle ----

  setReduced(reduced: boolean) { this.reduced = reduced; if (reduced) { this.introPending = false; this.snapAll(); } this.wake(); }
  setPalette(palette: Palette) { this.palette = palette; this.wake(); }
  setVisible(visible: boolean) { this.visible = visible; this.maybeIntro(); this.wake(); }
  setHidden(hidden: boolean) { this.hidden = hidden; this.wake(); }
  destroy() { cancelAnimationFrame(this.raf); this.raf = 0; clearTimeout(this.relayoutTimer); }

  resize(w: number, h: number, dpr: number) {
    if (w < 10 || h < 10) return;
    if (w === this.w && h === this.h && dpr === this.dpr) return;
    const first = this.w === 0;
    this.w = w; this.h = h; this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr);
    if (first) {
      this.layout(true);
      this.snapAll();
      this.cam.x = this.cam.tx; this.cam.y = this.cam.ty; this.cam.lz = this.cam.tz;
      this.maybeIntro();
    } else {
      // Keep the frame while the size settles, then relayout once.
      this.refit(true);
      clearTimeout(this.relayoutTimer);
      this.relayoutTimer = setTimeout(() => { this.layout(false); this.start("resize"); this.refit(false); this.wake(); }, 160);
    }
    this.render();
    this.wake();
  }

  attachCard(el: HTMLElement | null) { this.cardEl = el; if (el) { this.card.w = el.offsetWidth; this.card.h = el.offsetHeight; } }
  measureCard() { if (this.cardEl) { this.card.w = this.cardEl.offsetWidth; this.card.h = this.cardEl.offsetHeight; } this.wake(); }
  attachLabel(index: number, el: HTMLElement | null) { this.labelEls[index] = el; if (el) this.placeLabel(index, el); }

  // ---- commands ----

  setGroup(group: GroupKey, focus = -1) {
    if (group === this.group) { if (focus >= 0) this.focus(focus); return; }
    this.group = group;
    this.layout(false);
    this.start("group");
    this.setFocus(focus, false);
    if (focus < 0) this.fitCamera(this.reduced ? 0 : 5.2);
    this.wake();
  }

  /** Dim every dot outside one category of a grouping, or clear with null. */
  setHighlight(next: { group: GroupKey; cat: number } | null) {
    for (let i = 0; i < N; i++) this.alphaT[i] = !next || categoryOf(next.group, ACCOUNTS[i]) === next.cat ? 1 : .13;
    if (this.reduced) this.alpha.set(this.alphaT);
    this.wake();
  }

  focus(cluster: number) { this.setFocus(cluster, true); this.wake(); }
  resetView() { this.setFocus(-1, true); this.wake(); }
  zoomBy(factor: number) { this.zoomAt(this.w / 2, this.h / 2, factor); this.events.interact(); }

  /** Select an account from the keyboard; the card anchors to the dot instead of the pointer. */
  select(index: number, keyboard: boolean) {
    this.selected = index; this.keyboard = keyboard;
    if (index >= 0 && keyboard) {
      // Bring the dot into view if the camera has left it behind.
      const z = Math.exp(this.cam.tz), hw = this.w / 2 / z, hh = this.h / 2 / z;
      const x = this.px[index], y = this.py[index];
      if (Math.abs(x - this.cam.tx) > hw * .8 || Math.abs(y - this.cam.ty) > hh * .8) { this.anchor = null; this.cam.tx = x; this.cam.ty = y; this.cam.omega = 7; }
    }
    this.wake();
  }

  // ---- layout ----

  private radii() {
    let sum = 0;
    for (let i = 0; i < N; i++) sum += this.base[i] * this.base[i];
    const s = Math.sqrt(.26 * this.w * this.h * DENSITY / (Math.PI * sum));
    for (let i = 0; i < N; i++) this.rad[i] = Math.max(1.15, this.base[i] * s);
  }

  /** Phyllotaxis discs, biggest accounts at the core, relaxed for overlaps, then packed to the stage's shape. */
  private layout(first: boolean) {
    this.radii();
    const cats = categoriesOf(this.group).length;
    const members: number[][] = Array.from({ length: cats }, () => []);
    for (let i = 0; i < N; i++) { const c = categoryOf(this.group, ACCOUNTS[i]); this.cat[i] = c; members[c].push(i); }
    const lx = new Float32Array(N), ly = new Float32Array(N);
    const radius: number[] = [];
    const galaxy = cats === 1;
    this.plane.t = galaxy ? GALAXY_TILT : 0;
    if (first || this.reduced) { this.plane.a = this.plane.t; this.plane.v = 0; }
    members.forEach((list, c) => {
      list.sort((a, b) => this.rad[b] - this.rad[a] || a - b);
      if (galaxy) this.spiral(list, lx, ly);
      else {
        let area = 0;
        list.forEach((i, k) => {
          const own = (this.rad[i] + PAD) ** 2;
          const rr = k === 0 ? 0 : Math.sqrt((area + own * .5) / DENSITY) * (1 + (hash(i) - .5) * .08);
          const a = k * GOLDEN + c * 1.7 + (hash(i * 3 + 1) - .5) * .3;
          lx[i] = Math.cos(a) * rr; ly[i] = Math.sin(a) * rr; area += own;
        });
      }
      for (let it = 0; it < 36; it++) {
        this.collide(list, lx, ly, 1, null);
        const pull = it < 30 && !galaxy ? .006 : 0;
        for (const i of list) { lx[i] *= 1 - pull; ly[i] *= 1 - pull; }
      }
      // A galaxy's size ignores its last few stragglers so the fit frames the arms, not the halo.
      const reach = list.map(i => Math.hypot(lx[i], ly[i]) + this.rad[i]).sort((a, b) => a - b);
      radius[c] = reach[Math.min(reach.length - 1, Math.floor(reach.length * (galaxy ? .985 : 1)))];
    });
    // Two passes: the label band is in screen pixels, so it grows in world units when the fit zooms out.
    const narrow = this.w < 520;
    let scale = 1, centers: { x: number; y: number }[] = [];
    for (let pass = 0; pass < 2; pass++) {
      const gap = cats > 1 ? LABEL_BAND * scale : 0;
      centers = this.pack(radius, gap, cats > 1 ? (narrow ? 34 : 64) * scale : 0);
      this.boundsFor(centers, radius, gap, (narrow ? 50 : CONTROLS_BAND) * scale);
      this.clusters = centers.map((p, c) => ({ x: p.x, y: p.y, r: radius[c] }));
      this.fitZ = this.fitFor();
      if (this.fitZ >= .98) break;
      scale = 1 / this.fitZ;
    }
    for (let i = 0; i < N; i++) { const p = centers[this.cat[i]]; this.tx[i] = p.x + lx[i]; this.ty[i] = p.y + ly[i]; }
    if (first) { this.cam.tx = (this.bounds.x0 + this.bounds.x1) / 2; this.cam.ty = (this.bounds.y0 + this.bounds.y1) / 2; this.cam.tz = Math.log(this.fitZ); }
  }

  /** The whole book as a two arm spiral: the biggest accounts pack the core, the long tail trails out along the arms. */
  private spiral(list: number[], lx: Float32Array, ly: Float32Array) {
    const n = list.length, coreN = Math.round(n * .12);
    let area = 0;
    for (let k = 0; k < coreN; k++) area += (this.rad[list[k]] + PAD) ** 2;
    const rc = Math.sqrt(area / DENSITY), rg = rc * 2.55;
    area = 0;
    list.forEach((i, k) => {
      if (k < coreN) {
        const own = (this.rad[i] + PAD) ** 2;
        const rr = k === 0 ? 0 : Math.sqrt((area + own * .5) / DENSITY);
        lx[i] = Math.cos(k * GOLDEN) * rr; ly[i] = Math.sin(k * GOLDEN) * rr; area += own;
        return;
      }
      const t = (k - coreN) / (n - coreN);
      const g1 = Math.sqrt(-2 * Math.log(Math.max(1e-6, hash(i * 11 + 3)))), g2 = Math.PI * 2 * hash(i * 13 + 5);
      const u = clamp(.5 * t + .5 * hash(i * 17 + 7), 0, 1);
      const rr = (rc * .88 + (rg - rc * .88) * Math.pow(u, 1.15)) * (1 + g1 * Math.sin(g2) * .05);
      const arm = hash(i * 7 + 2) < .5 ? 0 : Math.PI;
      // Trailing arms: the angle falls as the radius grows, against the direction the galaxy turns.
      const a = hash(i * 5 + 9) < .08 ? hash(i * 19) * Math.PI * 2 : arm - 2.9 * Math.log(rr / rc) + g1 * Math.cos(g2) * (.12 * rg / rr + .05);
      lx[i] = Math.cos(a) * rr; ly[i] = Math.sin(a) * rr;
    });
  }

  /** Greedy circle packing toward an ellipse matching the stage; labels ride above, so each cluster claims at least half a label's width. */
  private pack(radius: number[], gap: number, labelHalf: number) {
    const aspect = clamp(this.w / this.h, .55, 2.4);
    const order = radius.map((_, i) => i).sort((a, b) => radius[b] - radius[a] || a - b);
    const placed: { x: number; y: number; r: number }[] = [];
    const out: { x: number; y: number }[] = radius.map(() => ({ x: 0, y: 0 }));
    for (const c of order) {
      const r = Math.max(radius[c], labelHalf);
      let best = { x: 0, y: 0 }, cost = Infinity;
      if (placed.length) for (const p of placed) for (let a = 0; a < 72; a++) {
        const t = a / 72 * Math.PI * 2 + .13;
        const x = p.x + Math.cos(t) * (p.r + r + gap), y = p.y + Math.sin(t) * (p.r + r + gap);
        if (placed.some(q => Math.hypot(x - q.x, y - q.y) < q.r + r + gap - .01)) continue;
        const k = (x / aspect) ** 2 + (y * 1.08) ** 2;
        if (k < cost) { cost = k; best = { x, y }; }
      }
      out[c] = best; placed.push({ ...best, r });
    }
    return out;
  }

  private boundsFor(centers: { x: number; y: number }[], radius: number[], label: number, controls: number) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    centers.forEach((p, c) => { x0 = Math.min(x0, p.x - radius[c]); x1 = Math.max(x1, p.x + radius[c]); y0 = Math.min(y0, p.y - radius[c] - label); y1 = Math.max(y1, p.y + radius[c]); });
    // Leave a band along the bottom for the zoom controls and the hint.
    y1 += controls;
    // Center the content on the world origin so the fitted camera sits at zero.
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    centers.forEach(p => { p.x -= mx; p.y -= my; });
    this.bounds = { x0: x0 - mx, y0: y0 - my, x1: x1 - mx, y1: y1 - my };
  }

  /** The largest zoom at which every cluster, seen through the plane's tilt and perspective, clears the stage edges. */
  private fitFor() {
    const m = this.w < 520 ? 14 : 28, b = this.bounds, a = this.plane.t;
    if (a < .01) return Math.min(1.35, (this.w - m * 2) / (b.x1 - b.x0), (this.h - m * 2) / (b.y1 - b.y0));
    const ca = Math.cos(a), sa = Math.sin(a), hw = this.w / 2 - m, hh = this.h / 2 - m;
    const fits = (z: number) => this.clusters.every(c => {
      for (let k = 0; k < 24; k++) {
        const t = k / 24 * Math.PI * 2, x = (c.x + Math.cos(t) * c.r) * z, y = (c.y + Math.sin(t) * c.r) * z;
        const f = PERSPECTIVE / Math.max(60, PERSPECTIVE - y * sa);
        if (Math.abs(x * f) > hw || Math.abs(y * ca * f) > hh) return false;
      }
      return b.y1 * z * ca < hh;
    });
    let lo = .02, hi = 1.35;
    if (fits(hi)) return hi;
    for (let k = 0; k < 22; k++) { const mid = (lo + hi) / 2; if (fits(mid)) lo = mid; else hi = mid; }
    return lo;
  }

  private refit(snap: boolean) {
    this.fitZ = this.fitFor();
    if (!this.zoomed || snap) {
      if (!this.zoomed) { this.cam.tx = 0; this.cam.ty = 0; this.cam.tz = Math.log(this.fitZ); }
      if (snap && !this.zoomed) { this.cam.x = 0; this.cam.y = 0; this.cam.lz = this.cam.tz; this.cam.vx = this.cam.vy = this.cam.vz = 0; }
    }
  }

  /** Position based collision on a uniform grid; big dots sit in every cell they cover so small ones find them. */
  private collide(list: ArrayLike<number>, xs: Float32Array, ys: Float32Array, strength: number, weight: Float32Array | null) {
    const n = list.length;
    if (n < 2) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, sumR = 0;
    for (let k = 0; k < n; k++) { const i = list[k], r = this.rad[i]; x0 = Math.min(x0, xs[i] - r); y0 = Math.min(y0, ys[i] - r); x1 = Math.max(x1, xs[i] + r); y1 = Math.max(y1, ys[i] + r); sumR += r; }
    let cell = Math.max(3, (sumR / n) * 2.4 + PAD);
    let cols = Math.ceil((x1 - x0) / cell) + 1, rows = Math.ceil((y1 - y0) / cell) + 1;
    while (cols * rows > 60000) { cell *= 1.5; cols = Math.ceil((x1 - x0) / cell) + 1; rows = Math.ceil((y1 - y0) / cell) + 1; }
    const cells = cols * rows;
    if (this.cellCount.length < cells + 1) this.cellCount = new Int32Array(cells + 1);
    const count = this.cellCount;
    count.fill(0, 0, cells + 1);
    const half = PAD / 2;
    let total = 0;
    for (let k = 0; k < n; k++) {
      const i = list[k], r = this.rad[i] + half;
      const ca = Math.floor((xs[i] - r - x0) / cell), cb = Math.floor((xs[i] + r - x0) / cell);
      const ra = Math.floor((ys[i] - r - y0) / cell), rb = Math.floor((ys[i] + r - y0) / cell);
      for (let row = ra; row <= rb; row++) for (let col = ca; col <= cb; col++) { count[row * cols + col + 1]++; total++; }
    }
    for (let c = 1; c <= cells; c++) count[c] += count[c - 1];
    if (this.cellItems.length < total) this.cellItems = new Int32Array(total * 1.5);
    const items = this.cellItems;
    if (this.cellFill.length < cells) this.cellFill = new Int32Array(cells);
    const fill = this.cellFill;
    fill.fill(0, 0, cells);
    for (let k = 0; k < n; k++) {
      const i = list[k], r = this.rad[i] + half;
      const ca = Math.floor((xs[i] - r - x0) / cell), cb = Math.floor((xs[i] + r - x0) / cell);
      const ra = Math.floor((ys[i] - r - y0) / cell), rb = Math.floor((ys[i] + r - y0) / cell);
      for (let row = ra; row <= rb; row++) for (let col = ca; col <= cb; col++) { const c = row * cols + col; items[count[c] + fill[c]++] = i; }
    }
    const stamp = this.stamp;
    stamp.fill(-1);
    for (let k = 0; k < n; k++) {
      const i = list[k], ri = this.rad[i], r = ri + half;
      const ca = Math.floor((xs[i] - r - x0) / cell), cb = Math.floor((xs[i] + r - x0) / cell);
      const ra = Math.floor((ys[i] - r - y0) / cell), rb = Math.floor((ys[i] + r - y0) / cell);
      const wi = weight ? 1 - weight[i] : 1;
      for (let row = Math.max(0, ra); row <= Math.min(rows - 1, rb); row++) for (let col = Math.max(0, ca); col <= Math.min(cols - 1, cb); col++) {
        const c = row * cols + col;
        for (let e = count[c], end = count[c + 1]; e < end; e++) {
          const j = items[e];
          if (j <= i || stamp[j] === i) continue;
          stamp[j] = i;
          const min = ri + this.rad[j] + PAD;
          let dx = xs[j] - xs[i], dy = ys[j] - ys[i];
          const d2 = dx * dx + dy * dy;
          if (d2 >= min * min) continue;
          let d = Math.sqrt(d2);
          if (d < 1e-4) { dx = hash(i + j) - .5; dy = hash(i * 7 + j) - .5; d = Math.hypot(dx, dy); }
          const w = wi * (weight ? 1 - weight[j] : 1);
          const push = (min - d) / d * strength * w;
          const mi = 1 / this.invMass[i], mj = 1 / this.invMass[j], share = mj / (mi + mj);
          xs[i] -= dx * push * share; ys[i] -= dy * push * share;
          xs[j] += dx * push * (1 - share); ys[j] += dy * push * (1 - share);
        }
      }
    }
  }

  // ---- simulation ----

  private snapAll() {
    this.px.set(this.tx); this.py.set(this.ty); this.vx.fill(0); this.vy.fill(0); this.lift.fill(0); this.alpha.set(this.alphaT);
    this.simActive = false; this.intro = false;
    if (!this.settled) { this.settled = true; this.events.settle(true); }
  }

  private start(kind: "group" | "intro" | "resize") {
    if (this.reduced) { this.snapAll(); return; }
    this.simT = 0; this.simActive = true; this.swirl = kind === "resize" ? 0 : kind === "intro" ? 1.15 : 1;
    this.intro = kind === "intro";
    for (let i = 0; i < N; i++) {
      const c = this.clusters[this.cat[i]];
      const depth = Math.hypot(this.tx[i] - c.x, this.ty[i] - c.y) / Math.max(1, c.r);
      // Cores fill first and the rim arrives last, so every cluster accretes from the inside out.
      this.delay[i] = kind === "resize" ? 0 : (kind === "intro" ? .5 : .26) * depth + hash(i) * .06;
    }
    if (kind !== "resize" && this.settled) { this.settled = false; this.events.settle(false); }
  }

  private maybeIntro() {
    if (!this.introPending || !this.visible || this.w === 0 || this.reduced) return;
    this.introPending = false;
    // The book forms as one galaxy: every dot starts wide and a little behind in its orbit, then spirals home.
    for (let i = 0; i < N; i++) {
      const c = this.clusters[this.cat[i]];
      const dx = this.tx[i] - c.x, dy = this.ty[i] - c.y;
      const rr = Math.hypot(dx, dy), a = Math.atan2(dy, dx) - 1.35 - hash(i) * .5;
      const reach = rr * 1.5 + c.r * (.45 + hash(i * 3) * .5);
      this.px[i] = c.x + Math.cos(a) * reach; this.py[i] = c.y + Math.sin(a) * reach;
      this.vx[i] = 0; this.vy[i] = 0; this.alpha[i] = 0;
    }
    this.start("intro");
    this.cam.lz = this.cam.tz - .22; this.cam.vz = 0; this.cam.omega = 3.6;
    this.plane.a = this.plane.t + .42; this.plane.v = 0;
  }

  private simStep(dt: number) {
    this.simT += dt;
    const t = this.simT;
    const heat = Math.exp(-t * 3.8) * this.swirl;
    let moving = 0;
    for (let i = 0; i < N; i++) {
      if (t < this.delay[i]) { this.vx[i] *= .96; this.vy[i] *= .96; this.px[i] += this.vx[i] * dt; this.py[i] += this.vy[i] * dt; continue; }
      const k = SPRING_K * this.invMass[i], c = 2 * Math.sqrt(k) * ZETA;
      const dx = this.tx[i] - this.px[i], dy = this.ty[i] - this.py[i];
      const sw = SWIRL * heat * k;
      this.vx[i] += (k * dx - sw * dy - c * this.vx[i]) * dt;
      this.vy[i] += (k * dy + sw * dx - c * this.vy[i]) * dt;
      this.px[i] += this.vx[i] * dt; this.py[i] += this.vy[i] * dt;
      const speed = Math.hypot(this.vx[i], this.vy[i]);
      this.lift[i] += (Math.min(1, speed / 900) - this.lift[i]) * .1;
      if (speed > 1.5 || dx * dx + dy * dy > .09) moving++;
    }
    // Arriving dots jostle the settled ones; dots in flight pass over each other at a different depth.
    if (t > .12 && t < COOL + .6 && this.swirl > 0) this.collide(this.allIndices(), this.px, this.py, .35, this.lift);
    if (!this.settled && t > SETTLE_AT) { this.settled = true; this.events.settle(true); }
    if ((t > COOL && moving === 0) || t > 3.2) {
      this.simActive = false; this.intro = false;
      this.px.set(this.tx); this.py.set(this.ty); this.vx.fill(0); this.vy.fill(0); this.lift.fill(0);
    }
  }

  private indices: Int32Array | null = null;
  private allIndices() { if (!this.indices) { this.indices = new Int32Array(N); for (let i = 0; i < N; i++) this.indices[i] = i; } return this.indices; }

  /** Every cluster turns slowly around its own center, positions and homes together, so nothing drifts apart. */
  private rotate(angle: number) {
    const cos = Math.cos(angle), sin = Math.sin(angle);
    for (let i = 0; i < N; i++) {
      const c = this.clusters[this.cat[i]];
      let x = this.px[i] - c.x, y = this.py[i] - c.y;
      this.px[i] = c.x + x * cos - y * sin; this.py[i] = c.y + x * sin + y * cos;
      x = this.tx[i] - c.x; y = this.ty[i] - c.y;
      this.tx[i] = c.x + x * cos - y * sin; this.ty[i] = c.y + x * sin + y * cos;
    }
  }

  // ---- camera ----

  private range(z: number) {
    const hw = this.w / 2 / z, hh = this.h / 2 / z, b = this.bounds;
    const mx = (b.x0 + b.x1) / 2, my = (b.y0 + b.y1) / 2;
    const wide = b.x1 - b.x0 > hw * 2, tall = b.y1 - b.y0 > hh * 2;
    return {
      x0: wide ? Math.min(mx, b.x0 + hw * .35) : mx, x1: wide ? Math.max(mx, b.x1 - hw * .35) : mx,
      y0: tall ? Math.min(my, b.y0 + hh * .35) : my, y1: tall ? Math.max(my, b.y1 - hh * .35) : my,
      hw, hh,
    };
  }

  private zoomLimits() { return { lo: Math.log(this.fitZ), hi: Math.log(Math.max(this.fitZ * 9, 5)) }; }

  private clampTargets() {
    const z = Math.exp(this.cam.tz), r = this.range(z);
    this.cam.tx = clamp(this.cam.tx, r.x0, r.x1); this.cam.ty = clamp(this.cam.ty, r.y0, r.y1);
  }

  private fitCamera(omega: number) {
    this.anchor = null;
    this.cam.tx = 0; this.cam.ty = 0; this.cam.tz = Math.log(this.fitZ); this.cam.omega = omega;
    if (this.reduced || omega === 0) { this.cam.x = 0; this.cam.y = 0; this.cam.lz = this.cam.tz; this.cam.vx = this.cam.vy = this.cam.vz = 0; }
  }

  private setFocus(cluster: number, move: boolean) {
    const valid = cluster >= 0 && cluster < this.clusters.length && this.clusters.length > 1;
    const next = valid ? cluster : -1;
    if (next !== this.focusCluster) { this.focusCluster = next; this.events.focus(next); }
    if (!valid) { if (move) this.fitCamera(6.5); return; }
    const c = this.clusters[cluster], lim = this.zoomLimits();
    const z = clamp(Math.min((this.w - 56) / (c.r * 2), (this.h - 104) / (c.r * 2 + LABEL_BAND)), this.fitZ * 1.2, Math.exp(lim.hi));
    this.anchor = null;
    this.cam.tx = c.x; this.cam.ty = c.y - LABEL_BAND / 2 / z; this.cam.tz = Math.log(z); this.cam.omega = 6.2;
    if (this.reduced) { this.cam.x = this.cam.tx; this.cam.y = this.cam.ty; this.cam.lz = this.cam.tz; }
  }

  private zoomAt(sx: number, sy: number, factor: number) {
    const lim = this.zoomLimits(), world = this.toWorld(sx, sy);
    this.anchor = { wx: world.x, wy: world.y, sx, sy };
    this.cam.tz = clamp(this.cam.tz + Math.log(factor), lim.lo, lim.hi);
    this.cam.omega = 11;
    if (this.reduced) { this.cam.lz = this.cam.tz; this.applyAnchor(); this.anchor = null; this.clampTargets(); this.cam.x = this.cam.tx; this.cam.y = this.cam.ty; }
    this.wake();
  }

  private applyAnchor() {
    if (!this.anchor) return;
    const z = Math.exp(this.cam.lz), p = this.onPlane(this.anchor.sx, this.anchor.sy);
    this.cam.x = this.anchor.wx - p.x / z; this.cam.y = this.anchor.wy - p.y / z;
    this.cam.tx = this.cam.x; this.cam.ty = this.cam.y; this.cam.vx = 0; this.cam.vy = 0;
  }

  private camStep(dt: number) {
    const cam = this.cam;
    if (this.drag?.moved || this.pinch) return;
    if (this.reduced) { cam.lz = cam.tz; if (this.anchor) { this.applyAnchor(); this.anchor = null; this.clampTargets(); } cam.x = cam.tx; cam.y = cam.ty; return; }
    const w = cam.omega;
    cam.vz += (w * w * (cam.tz - cam.lz) - 2 * w * cam.vz) * dt; cam.lz += cam.vz * dt;
    if (this.anchor) {
      this.applyAnchor();
      if (Math.abs(cam.tz - cam.lz) < 1e-4 && Math.abs(cam.vz) < 1e-3) { cam.lz = cam.tz; cam.vz = 0; this.anchor = null; this.clampTargets(); cam.omega = 7; }
      return;
    }
    cam.vx += (w * w * (cam.tx - cam.x) - 2 * w * cam.vx) * dt; cam.x += cam.vx * dt;
    cam.vy += (w * w * (cam.ty - cam.y) - 2 * w * cam.vy) * dt; cam.y += cam.vy * dt;
  }

  private camMoving() {
    const c = this.cam;
    return !!this.anchor || Math.abs(c.tz - c.lz) > 1e-4 || Math.abs(c.vz) > 1e-3 || Math.abs(c.tx - c.x) > .02 || Math.abs(c.ty - c.y) > .02 || Math.hypot(c.vx, c.vy) > .05;
  }

  private reportView() {
    const zoomed = this.cam.tz > Math.log(this.fitZ) + .04 || Math.hypot(this.cam.tx, this.cam.ty) > 4;
    if (zoomed !== this.zoomed) { this.zoomed = zoomed; this.events.view(zoomed); }
    // Zooming all the way back out lets go of a focused cluster.
    if (!zoomed && this.focusCluster >= 0 && !this.pinch && !this.drag) { this.focusCluster = -1; this.events.focus(-1); }
  }

  // ---- pointer input ----

  private local(e: { clientX: number; clientY: number }) { const r = this.canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  /** Undo the plane's tilt and perspective: a screen point back to zoomed plane coordinates around the camera. */
  private onPlane(sx: number, sy: number) {
    const a = this.planeAngle(), ca = Math.cos(a), sa = Math.sin(a);
    const X = sx - this.w / 2, Y = sy - this.h / 2;
    const y = Y * PERSPECTIVE / (PERSPECTIVE * ca + Y * sa), f = PERSPECTIVE / Math.max(60, PERSPECTIVE - y * sa);
    return { x: X / f, y };
  }
  private toWorld(x: number, y: number) { const z = Math.exp(this.cam.lz), p = this.onPlane(x, y); return { x: this.cam.x + p.x / z, y: this.cam.y + p.y / z }; }
  /** The galaxy's tilt, flattening toward the camera as you zoom in. */
  private planeAngle() { return this.plane.a * clamp(1 - (Math.exp(this.cam.lz) / this.fitZ - 1) / 1.8, 0, 1) + this.tilt.x; }

  pointerDown(e: PointerEvent) {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    const p = this.local(e);
    this.pointers.set(e.pointerId, { ...p, type: e.pointerType });
    if (this.pointers.size === 1) {
      this.anchor = null;
      this.drag = { id: e.pointerId, sx: p.x, sy: p.y, lx: p.x, ly: p.y, lt: e.timeStamp, moved: false, rawX: this.cam.x, rawY: this.cam.y, vx: 0, vy: 0, type: e.pointerType };
    } else if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, world = this.toWorld(mid.x, mid.y);
      this.drag = null;
      this.pinch = { d0: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)), z0: Math.exp(this.cam.lz), wx: world.x, wy: world.y };
      this.anchor = null; this.setHover(-1); this.events.interact();
    }
    this.wake();
  }

  pointerMove(e: PointerEvent) {
    const p = this.local(e);
    if (e.pointerType === "mouse") { this.mouse.x = p.x; this.mouse.y = p.y; this.mouse.inside = true; this.mouse.fine = true; }
    const tracked = this.pointers.get(e.pointerId);
    if (tracked) { tracked.x = p.x; tracked.y = p.y; }
    if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const lim = this.zoomLimits(), mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const raw = Math.log(this.pinch.z0 * Math.hypot(a.x - b.x, a.y - b.y) / this.pinch.d0);
      const lz = band(raw, lim.lo, lim.hi, .9), z = Math.exp(lz);
      this.cam.lz = this.cam.tz = lz; this.cam.vz = 0;
      this.cam.x = this.cam.tx = this.pinch.wx - (mid.x - this.w / 2) / z; this.cam.y = this.cam.ty = this.pinch.wy - (mid.y - this.h / 2) / z;
      this.wake();
      return;
    }
    const d = this.drag;
    if (d && d.id === e.pointerId) {
      if (!d.moved && Math.hypot(p.x - d.sx, p.y - d.sy) > 4) { d.moved = true; d.rawX = this.cam.x; d.rawY = this.cam.y; this.setHover(-1); this.events.interact(); }
      if (d.moved) {
        const z = Math.exp(this.cam.lz), r = this.range(z);
        const dx = p.x - d.lx, dy = p.y - d.ly, dtm = Math.max(1, e.timeStamp - d.lt);
        d.rawX -= dx / z; d.rawY -= dy / z / Math.max(.4, Math.cos(this.planeAngle()));
        this.cam.x = this.cam.tx = band(d.rawX, r.x0, r.x1, r.hw * 2); this.cam.y = this.cam.ty = band(d.rawY, r.y0, r.y1, r.hh * 2);
        this.cam.vx = this.cam.vy = 0;
        const k = Math.min(1, dtm / 40);
        d.vx += (-dx / z / dtm * 1000 - d.vx) * k; d.vy += (-dy / z / dtm * 1000 - d.vy) * k;
        // The plane leans into the drag like a sheet under a fingertip.
        this.tilt.ty = clamp(dx / dtm * .035, -.16, .16); this.tilt.tx = clamp(-dy / dtm * .035, -.16, .16);
        d.lx = p.x; d.ly = p.y; d.lt = e.timeStamp;
        this.wake();
      }
      return;
    }
    if (e.pointerType === "mouse") { this.setHover(this.hit(p.x, p.y)); this.wake(); }
  }

  pointerUp(e: PointerEvent) {
    const p = this.local(e);
    this.pointers.delete(e.pointerId);
    if (this.pinch) {
      if (this.pointers.size < 2) {
        const lim = this.zoomLimits();
        this.pinch = null; this.drag = null; this.pointers.clear();
        this.cam.tz = clamp(this.cam.lz, lim.lo, lim.hi); this.cam.omega = 9;
        if (Math.abs(this.cam.tz - this.cam.lz) > 1e-4) this.anchor = { wx: this.cam.x, wy: this.cam.y, sx: this.w / 2, sy: this.h / 2 };
        else this.clampTargets();
      }
      this.wake();
      return;
    }
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    this.drag = null;
    this.tilt.tx = 0; this.tilt.ty = 0;
    if (d.moved) {
      const idle = e.timeStamp - d.lt > 90;
      const vx = idle ? 0 : clamp(d.vx, -4000, 4000), vy = idle ? 0 : clamp(d.vy, -4000, 4000);
      if (this.reduced) { this.clampTargets(); this.cam.x = this.cam.tx; this.cam.y = this.cam.ty; }
      else {
        // Project where the throw would coast to, clamp it to the content, and spring there with the throw's velocity.
        this.cam.tx = this.cam.x + vx * .3; this.cam.ty = this.cam.y + vy * .3; this.clampTargets();
        this.cam.vx = vx; this.cam.vy = vy; this.cam.omega = 5.4;
      }
    } else {
      const now = e.timeStamp;
      if (d.type !== "mouse" && now - this.lastTap.t < 320 && Math.hypot(p.x - this.lastTap.x, p.y - this.lastTap.y) < 30) { this.lastTap.t = -1; this.doubleAt(p.x, p.y); }
      else {
        this.lastTap = { t: now, x: p.x, y: p.y };
        const i = this.hit(p.x, p.y, d.type === "mouse" ? 4 : 10);
        this.selected = i; this.keyboard = d.type !== "mouse";
        this.events.select(i);
      }
    }
    this.wake();
  }

  pointerCancel(e: PointerEvent) { this.pointers.delete(e.pointerId); if (this.drag?.id === e.pointerId) this.drag = null; if (this.pointers.size < 2) this.pinch = null; this.tilt.tx = 0; this.tilt.ty = 0; this.clampTargets(); this.wake(); }
  pointerLeave() { this.mouse.inside = false; if (!this.drag) this.setHover(-1); this.wake(); }
  doubleClick(e: MouseEvent) { const p = this.local(e); this.doubleAt(p.x, p.y); }

  private doubleAt(x: number, y: number) {
    this.events.interact();
    if (this.selected >= 0) { this.selected = -1; this.events.select(-1); }
    const w = this.toWorld(x, y), z = Math.exp(this.cam.lz);
    if (this.clusters.length < 2) { if (this.zoomed) this.resetView(); else this.zoomAt(x, y, 2.4); return; }
    let best = -1, bestD = Infinity;
    this.clusters.forEach((c, i) => { const d = Math.hypot(w.x - c.x, w.y - c.y) - c.r; if (d < 44 / z && d < bestD) { bestD = d; best = i; } });
    if (best < 0 || best === this.focusCluster) this.resetView(); else this.focus(best);
  }

  /** Wheel and trackpad pinch zoom around the pointer; a trackpad scroll pans only once zoomed, otherwise the page scrolls. */
  wheel(e: WheelEvent) {
    const p = this.local(e);
    const pinch = e.ctrlKey || e.metaKey, lines = e.deltaMode === 1;
    const mouseLike = lines || (Math.abs(e.deltaY) >= 40 && e.deltaX === 0);
    if (pinch || mouseLike) {
      e.preventDefault();
      this.zoomAt(p.x, p.y, Math.exp(-e.deltaY * (pinch ? .011 : lines ? .05 : .0022)));
      this.events.interact();
      return;
    }
    if (!this.zoomed) return;
    e.preventDefault();
    const z = Math.exp(this.cam.lz);
    this.anchor = null; this.cam.tx += e.deltaX / z; this.cam.ty += e.deltaY / z; this.clampTargets(); this.cam.omega = 14;
    this.wake();
  }

  private setHover(index: number) {
    if (index === this.hovered) return;
    this.hovered = index; this.canvas.style.cursor = index >= 0 ? "pointer" : "";
    this.events.hover(index);
  }

  private hit(x: number, y: number, slop = 4) {
    let best = -1, bestD = Infinity;
    for (let i = 0; i < N; i++) {
      if (!this.visibleDot[i] || this.alpha[i] < .5) continue;
      const dx = this.sx[i] - x, dy = this.sy[i] - y, r = this.sr[i];
      const d = Math.hypot(dx, dy) - r;
      if (d < slop && d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  // ---- loop ----

  private wake() {
    this.busy = true;
    if (this.raf || !this.visible || this.hidden || this.w === 0) return;
    this.last = performance.now(); this.acc = 0;
    this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number) => {
    this.raf = 0;
    const dt = Math.min(.05, Math.max(0, (now - this.last) / 1000));
    this.last = now; this.acc += dt;
    let steps = 0;
    while (this.acc >= DT && steps < 8) { this.step(DT); this.acc -= DT; steps++; }
    if (steps === 8) this.acc = 0;
    this.reportView();
    this.render();
    if (this.active() && this.visible && !this.hidden) this.raf = requestAnimationFrame(this.frame);
  };

  private active() {
    if (this.reduced) return this.simActive || this.camMoving() || !!this.drag;
    return this.busy || this.simActive || this.camMoving() || !!this.drag || !!this.pinch;
  }

  private step(dt: number) {
    if (this.simActive) this.simStep(dt);
    if (!this.reduced) {
      const still = this.mouse.inside || !!this.drag || !!this.pinch || this.selected >= 0;
      this.drift += ((still ? 0 : 1) - this.drift) * (1 - Math.exp(-dt * 2.5));
      if (this.drift > .002) this.rotate(DRIFT * this.drift * dt);
      let busy = !still || this.drift > .002;
      const pl = this.plane, pw = this.intro ? 2.6 : 4.4;
      pl.v += (pw * pw * (pl.t - pl.a) - 2 * pw * pl.v) * dt; pl.a += pl.v * dt;
      const t = this.tilt, w = 11, zeta = .55;
      t.vx += (w * w * (t.tx - t.x) - 2 * zeta * w * t.vx) * dt; t.x += t.vx * dt;
      t.vy += (w * w * (t.ty - t.y) - 2 * zeta * w * t.vy) * dt; t.y += t.vy * dt;
      if (this.drag?.moved) { t.tx *= .9; t.ty *= .9; }
      const zoomRatio = Math.exp(this.cam.lz) / this.fitZ;
      const lensT = this.mouse.inside && this.mouse.fine && !this.drag && !this.pinch ? clamp(1 - (zoomRatio - 1.2) / 1.6, 0, 1) : 0;
      this.lens += (lensT - this.lens) * (1 - Math.exp(-dt * 10));
      const k = 1 - Math.exp(-dt * (this.intro ? 5 : 11));
      let fading = false;
      for (let i = 0; i < N; i++) {
        if (this.intro && this.simT < this.delay[i] * .7) { fading = true; continue; }
        const gap = this.alphaT[i] - this.alpha[i];
        if (gap > .003 || gap < -.003) { this.alpha[i] += gap * k; fading = true; } else this.alpha[i] = this.alphaT[i];
      }
      busy ||= fading || Math.abs(lensT - this.lens) > .002
        || Math.abs(pl.t - pl.a) > 1e-4 || Math.abs(pl.v) > 1e-4
        || Math.abs(t.tx - t.x) > 1e-4 || Math.abs(t.ty - t.y) > 1e-4 || Math.abs(t.vx) > 1e-4 || Math.abs(t.vy) > 1e-4;
      this.busy = busy;
    } else { this.alpha.set(this.alphaT); this.plane.a = this.plane.t; }
    this.camStep(dt);
    if (this.cardStep(dt)) this.busy = true;
  }

  // ---- rendering ----

  private project(wx: number, wy: number, lift: number, out: { x: number; y: number; f: number }) {
    const z = Math.exp(this.cam.lz), a = this.planeAngle(), b = this.tilt.y;
    const x = (wx - this.cam.x) * z, y = (wy - this.cam.y) * z;
    const f = PERSPECTIVE / Math.max(60, PERSPECTIVE + x * Math.sin(b) - y * Math.sin(a) - lift * 80);
    out.x = this.w / 2 + x * Math.cos(b) * f; out.y = this.h / 2 + y * Math.cos(a) * f; out.f = f;
    return out;
  }

  private render() {
    const ctx = this.ctx;
    if (!ctx || this.w === 0) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    const z = Math.exp(this.cam.lz), w2 = this.w / 2, h2 = this.h / 2;
    const pa = this.planeAngle();
    const cyT = Math.cos(this.tilt.y), syT = Math.sin(this.tilt.y), cxT = Math.cos(pa), sxT = Math.sin(pa);
    const lens = this.lens * LENS_MAG, mx = this.mouse.x, my = this.mouse.y, s2 = LENS_SIGMA * LENS_SIGMA;
    const counts = this.counts;
    counts.fill(0);
    for (let i = 0; i < N; i++) {
      const lift = this.lift[i];
      const x = (this.px[i] - this.cam.x) * z, y = (this.py[i] - this.cam.y) * z;
      const f = PERSPECTIVE / Math.max(60, PERSPECTIVE + x * syT - y * sxT - lift * 80);
      let sx = w2 + x * cyT * f, sy = h2 + y * cxT * f, sr = this.rad[i] * z * f * (1 + lift * .3);
      if (lens > .001) {
        const dx = sx - mx, dy = sy - my, d2 = dx * dx + dy * dy;
        if (d2 < s2 * 9) { const g = Math.exp(-d2 / (2 * s2)), m = lens * g; sx = mx + dx * (1 + m); sy = my + dy * (1 + m); sr *= 1 + m * Math.max(.25, 1 - d2 / (4 * s2)); }
      }
      this.sx[i] = sx; this.sy[i] = sy; this.sr[i] = sr;
      const a = this.alpha[i];
      const on = a > .02 && sx > -sr && sx < this.w + sr && sy > -sr && sy < this.h + sr;
      this.visibleDot[i] = on ? 1 : 0;
      if (!on) continue;
      const key = Math.round(a * LEVELS) * 4 + this.health[i];
      this.bucketOf[i] = key; counts[key + 1]++;
    }
    for (let k = 1; k < counts.length; k++) counts[k] += counts[k - 1];
    const fill = this.fillAt;
    fill.set(counts);
    for (let i = 0; i < N; i++) if (this.visibleDot[i]) this.drawOrder[fill[this.bucketOf[i]]++] = i;
    for (let key = 0; key < counts.length - 1; key++) {
      const from = counts[key], to = counts[key + 1];
      if (from === to) continue;
      const level = key >> 2, h = key & 3;
      ctx.globalAlpha = level / LEVELS * DOT_ALPHA[h];
      ctx.fillStyle = this.palette.dots[h];
      ctx.beginPath();
      for (let e = from; e < to; e++) {
        const i = this.drawOrder[e], r = Math.max(.6, this.sr[i]);
        ctx.moveTo(this.sx[i] + r, this.sy[i]); ctx.arc(this.sx[i], this.sy[i], r, 0, Math.PI * 2);
      }
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    this.ring(this.selected, this.palette.accent);
    if (this.hovered !== this.selected) this.ring(this.hovered, this.palette.ring);
    this.placeLabels();
    this.placeCard();
  }

  private ring(i: number, color: string) {
    const ctx = this.ctx;
    if (!ctx || i < 0 || !this.visibleDot[i]) return;
    const r = Math.max(1.5, this.sr[i]);
    ctx.globalAlpha = DOT_ALPHA[this.health[i]];
    ctx.fillStyle = this.palette.dots[this.health[i]];
    ctx.beginPath(); ctx.arc(this.sx[i], this.sy[i], r, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = color; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(this.sx[i], this.sy[i], r + 3, 0, Math.PI * 2); ctx.stroke();
  }

  private labelPoint = { x: 0, y: 0, f: 1 };
  private placeLabel(index: number, el: HTMLElement) {
    const c = this.clusters[index];
    if (!c || this.w === 0) return;
    const p = this.project(c.x, c.y - c.r, 0, this.labelPoint);
    el.style.transform = `translate3d(${p.x.toFixed(1)}px, ${(p.y - 10).toFixed(1)}px, 0)`;
  }
  private placeLabels() { this.labelEls.forEach((el, i) => { if (el) this.placeLabel(i, el); }); }

  private cardTarget() {
    const hover = this.hovered >= 0, i = hover ? this.hovered : this.selected;
    if (i < 0) return null;
    const pad = 14, { w: cw, h: ch } = this.card;
    let ax: number, ay: number, gap: number;
    if (hover) { ax = this.mouse.x; ay = this.mouse.y; gap = 18; }
    else { ax = this.sx[i]; ay = this.sy[i]; gap = this.sr[i] + 12; }
    let x = ax + gap, y = ay - ch / 2;
    if (x + cw > this.w - pad) x = ax - gap - cw;
    x = clamp(x, pad, Math.max(pad, this.w - cw - pad));
    y = clamp(y, pad, Math.max(pad, this.h - ch - pad));
    return { x, y };
  }

  /** Returns true while the card is still travelling toward its target. */
  private cardStep(dt: number) {
    const t = this.cardTarget();
    if (!t) { this.card.shown = false; return false; }
    const c = this.card;
    if (!c.shown || this.reduced) { c.x = t.x; c.y = t.y; c.vx = c.vy = 0; c.shown = true; return false; }
    const w = 20;
    c.vx += (w * w * (t.x - c.x) - 2 * w * c.vx) * dt; c.x += c.vx * dt;
    c.vy += (w * w * (t.y - c.y) - 2 * w * c.vy) * dt; c.y += c.vy * dt;
    return Math.abs(t.x - c.x) > .1 || Math.abs(t.y - c.y) > .1 || Math.abs(c.vx) > .5 || Math.abs(c.vy) > .5;
  }

  private placeCard() {
    if (!this.cardEl || !this.card.shown) return;
    this.cardEl.style.transform = `translate3d(${this.card.x.toFixed(1)}px, ${this.card.y.toFixed(1)}px, 0)`;
  }
}
