"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { motion } from "motion/react";
import { Check, Copy, Download, Pipette, Plus, Shuffle, Trash2, X } from "lucide-react";
import { Button } from "../button/button";
import { Slider } from "../slider/slider";
import { Switch } from "../switch/switch";
import { motionTokens } from "../lib/motion-tokens";
import styles from "./gradient-mesh.module.css";

/** One color point of the mesh. Positions are fractions of the canvas, 0 to 1 from the top left. */
export interface MeshPoint {
  /** Stable key. Defaults to its position in the list. */
  id?: string;
  /** Hex color, such as #5b6cff. */
  color: string;
  x: number;
  y: number;
  /** Reach of the color as a fraction of the canvas, 0.15 to 1.2. */
  spread?: number;
}

export interface MeshSwatch {
  /** Name read by screen readers and used to name points of this color. */
  name: string;
  /** Hex color. */
  color: string;
}

export interface GradientMeshPointValue {
  id: string;
  /** Swatch name of the color, or its hex when it is custom. */
  name: string;
  color: string;
  x: number;
  y: number;
  spread: number;
}

/** The saved design, passed to onChange. */
export interface GradientMeshValue {
  base: string;
  grain: number;
  animate: boolean;
  /** Bottom to top: later points paint over earlier ones. */
  points: GradientMeshPointValue[];
}

/**
 * A mesh gradient editor. Color points are dragged on a live canvas and blend smoothly into each other; points can be added
 * with a double click and removed, a grain control adds film texture, the animate switch makes the mesh drift on a seamless
 * loop, and the result exports as CSS that renders the same image, or as a PNG.
 */
export interface GradientMeshProps {
  /** Starting points, bottom to top. The component owns them after mount. Three to six read best. */
  points?: readonly MeshPoint[];
  /** Starting base color behind every point (hex). */
  base?: string;
  /** Swatches offered for the selected point or the base. */
  palette?: readonly MeshSwatch[];
  /** Starting grain, 0 to 1. */
  grain?: number;
  /** Starts with the drift on. */
  animate?: boolean;
  /** Multiplies the drift speed. 0 holds it still. */
  speed?: number;
  /** Holds the drift on its current frame. Editing still works. */
  paused?: boolean;
  /** Most points allowed, 2 to 8. */
  maxPoints?: number;
  /** Any CSS color for the selection ring on handles and swatches. Defaults to the accent. */
  accent?: string;
  /** Short help on the canvas until the first edit. Pass an empty string to hide it. */
  hint?: string;
  /** Accessible name of the editor. */
  label?: string;
  /** Called with the saved design after every change. */
  onChange?: (value: GradientMeshValue) => void;
  /** Called after an export with the CSS text or the PNG blob. */
  onExport?: (format: "css" | "png", result: string | Blob) => void;
  /**
   * "editor" is the full editor. "background" renders only the mesh, filling its container: no handles, inspector, hint or
   * border. It ignores the pointer, is hidden from assistive technology, and follows points, base, grain and animate live, so
   * a new palette (a theme change, say) glides and blends into place.
   */
  mode?: "editor" | "background";
  className?: string;
  style?: CSSProperties;
}

const DEFAULT_PALETTE: MeshSwatch[] = [
  { name: "Vermillion", color: "#ff5f3a" },
  { name: "Apricot", color: "#ffb259" },
  { name: "Butter", color: "#ffe7a3" },
  { name: "Rose", color: "#f59ac0" },
  { name: "Lilac", color: "#a98bff" },
  { name: "Iris", color: "#5b6cff" },
  { name: "Lagoon", color: "#3fb6c8" },
  { name: "Ink", color: "#1b2150" },
  { name: "Cream", color: "#f8efe4" },
];

const DEFAULT_POINTS: MeshPoint[] = [
  { color: "#1b2150", x: .1, y: .92, spread: .78 },
  { color: "#5b6cff", x: .86, y: .16, spread: .72 },
  { color: "#ff5f3a", x: .2, y: .2, spread: .62 },
  { color: "#ffb259", x: .6, y: .64, spread: .5 },
  { color: "#f59ac0", x: .94, y: .9, spread: .46 },
];

const MAX_GL = 12;
const SPREAD_MIN = .15;
const SPREAD_MAX = 1.2;
/** Drift loop length in seconds at speed 1, the travel as a fraction of the canvas, and how much a point breathes. */
const PERIOD = 20;
const TRAVEL = .075;
const BREATH = .08;
/** Critically damped spring rates (rad/s): a held point, a settling point, a size change, and the drift easing in. */
const W_DRAG = 38;
const W_SETTLE = 17;
const W_SPREAD = 13;
const W_DRIFT = 3.2;
/** Alpha falls off along a smoothstep; CSS gets it as six linear stops, which is indistinguishable. */
const STOPS = [0, .2, .4, .6, .8, 1];
const EXPORT_WIDTH = 2400;

type Rgb = [number, number, number];
interface Pt { id: string; color: string; x: number; y: number; spread: number; home: [number, number] }
interface SimPt {
  id: string; ax: number; ay: number; ar: number; x: number; y: number; vx: number; vy: number; r: number; vr: number;
  w: number; vw: number; col: Rgb; tcol: Rgb; ph1: number; ph2: number; k1: number; k2: number; removing: boolean;
}
interface Gl { gl: WebGLRenderingContext; prog: WebGLProgram; u: Record<string, WebGLUniformLocation | null>; p: Float32Array; c: Float32Array }
interface Sim {
  pts: SimPt[]; base: Rgb; tbase: Rgb; grain: number; tgrain: number; t: number; drift: number; vdrift: number;
  driftOn: boolean; paused: boolean; speed: number; reduced: boolean; visible: boolean; running: boolean; frame: number; last: number;
  drag: { id: string; pointer: number; gx: number; gy: number; rect: DOMRect } | null; selected: string;
  W: number; H: number; dpr: number; gl: Gl | null; canvas: HTMLCanvasElement | null; fallback: HTMLDivElement | null;
  handles: Map<string, HTMLElement>; ellipse: SVGEllipseElement | null;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const smooth = (t: number) => t * t * (3 - 2 * t);
const pct = (v: number) => `${+(v * 100).toFixed(1)}%`;

function normHex(input: string) {
  const s = input.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(s)) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/.test(s)) return s.slice(0, 7);
  return "#888888";
}
function rgbOf(hex: string): Rgb {
  const h = normHex(hex);
  return [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
}
const hex8 = (hex: string, alpha: number) => `${normHex(hex)}${Math.round(clamp(alpha, 0, 1) * 255).toString(16).padStart(2, "0")}`;

/** FNV-1a, so each point drifts on its own deterministic loop, the same on the server, the canvas and in the exported CSS. */
function hashOf(id: string) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function driftParams(id: string) {
  const h = hashOf(id);
  return { ph1: (h % 628) / 100, ph2: ((h >>> 10) % 628) / 100, k1: 1 + ((h >>> 20) % 2), k2: 1 + ((h >>> 22) % 2) };
}
/** Offset of a point at time t (seconds into the loop). Integer frequencies make the loop seamless. */
function driftAt(d: { ph1: number; ph2: number; k1: number; k2: number }, t: number) {
  const a = (2 * Math.PI * t) / PERIOD;
  return { dx: TRAVEL * Math.sin(a * d.k1 + d.ph1), dy: TRAVEL * Math.cos(a * d.k2 + d.ph2), s: 1 + BREATH * Math.sin(a + d.ph1 * .7) };
}

function nameOf(color: string, palette: readonly MeshSwatch[]) {
  const hex = normHex(color);
  return palette.find(s => normHex(s.color) === hex)?.name ?? hex.toUpperCase();
}

/* CSS output. Each point is an elliptical radial gradient sized in percent of the box, the same falloff the canvas draws, so the
   exported CSS renders the image the editor shows. Grain is SVG noise blended with overlay. */
function gradientLayer(color: string, x: string, y: string, r: string) {
  const stops = STOPS.map(t => `${hex8(color, 1 - smooth(t))} ${Math.round(t * 100)}%`).join(", ");
  return `radial-gradient(ellipse ${r} ${r} at ${x} ${y}, ${stops})`;
}
function grainLayer(grain: number) {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><filter id='g'><feTurbulence type='fractalNoise' baseFrequency='.8' numOctaves='3' stitchTiles='stitch'/><feColorMatrix type='saturate' values='0'/></filter><rect width='100%' height='100%' filter='url(#g)' opacity='${+(grain * .8).toFixed(2)}'/></svg>`;
  return `url("data:image/svg+xml,${svg.replace(/</g, "%3C").replace(/>/g, "%3E").replace(/#/g, "%23")}")`;
}
interface Layer { color: string; x: number; y: number; r: number }
function backgroundOf(base: string, layers: Layer[], grain: number): CSSProperties {
  const top = [...layers].reverse().map(l => gradientLayer(l.color, pct(l.x), pct(l.y), pct(l.r)));
  const images = grain > .005 ? [grainLayer(grain), ...top] : top;
  return {
    backgroundColor: normHex(base),
    backgroundImage: images.join(", "),
    backgroundBlendMode: grain > .005 ? ["overlay", ...top.map(() => "normal")].join(", ") : undefined,
  };
}

function meshCss(base: string, pts: readonly Pt[], grain: number, animate: boolean, speed: number) {
  const top = [...pts].map((p, i) => ({ p, n: i + 1 })).reverse();
  const layers = top.map(({ p, n }) => animate
    ? gradientLayer(p.color, `var(--mesh-${n}-x)`, `var(--mesh-${n}-y)`, `var(--mesh-${n}-r)`)
    : gradientLayer(p.color, pct(p.x), pct(p.y), pct(p.spread)));
  const images = grain > .005 ? [grainLayer(grain), ...layers] : layers;
  const lines: string[] = [];
  if (animate) {
    pts.forEach((p, i) => {
      for (const [axis, v] of [["x", p.x], ["y", p.y], ["r", p.spread]] as const) {
        lines.push(`@property --mesh-${i + 1}-${axis} { syntax: "<percentage>"; inherits: false; initial-value: ${pct(v)}; }`);
      }
    });
    lines.push("");
  }
  lines.push(".mesh {", `  background-color: ${normHex(base)};`, `  background-image:\n    ${images.join(",\n    ")};`);
  if (grain > .005) lines.push(`  background-blend-mode: ${["overlay", ...layers.map(() => "normal")].join(", ")};`);
  if (animate && speed > 0) lines.push(`  animation: mesh-drift ${+(PERIOD / speed).toFixed(2)}s linear infinite;`);
  lines.push("}");
  if (animate && speed > 0) {
    lines.push("", "@keyframes mesh-drift {");
    const steps = 16;
    for (let k = 0; k <= steps; k++) {
      const decl = pts.map((p, i) => {
        const d = driftAt(driftParams(p.id), (k / steps) * PERIOD);
        return `--mesh-${i + 1}-x: ${pct(p.x + d.dx)}; --mesh-${i + 1}-y: ${pct(p.y + d.dy)}; --mesh-${i + 1}-r: ${pct(p.spread * d.s)};`;
      }).join(" ");
      lines.push(`  ${+((k / steps) * 100).toFixed(2)}% { ${decl} }`);
    }
    lines.push("}", "", "@media (prefers-reduced-motion: reduce) {", "  .mesh { animation: none; }", "}");
  }
  return lines.join("\n");
}

/* WebGL: one full screen triangle. Each point composites over the last with the smoothstep falloff, in sRGB like CSS does. */
const VS = `attribute vec2 a; void main() { gl_Position = vec4(a, 0.0, 1.0); }`;
const FS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 uRes;
uniform vec3 uBase;
uniform vec4 uP[${MAX_GL}];
uniform vec3 uC[${MAX_GL}];
uniform int uN;
uniform float uGrain;
uniform float uScale;
float hash(vec2 p) { vec3 q = fract(vec3(p.xyx) * .1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
void main() {
  vec2 uv = vec2(gl_FragCoord.x / uRes.x, 1.0 - gl_FragCoord.y / uRes.y);
  vec3 col = uBase;
  for (int i = 0; i < ${MAX_GL}; i++) {
    if (i >= uN) break;
    vec4 p = uP[i];
    float d = length((uv - p.xy) / max(p.z, 1e-4));
    col = mix(col, uC[i], 1.0 - smoothstep(0.0, 1.0, d));
  }
  vec2 g = floor(gl_FragCoord.xy / uScale);
  float n = hash(g) + hash(g + 19.19) - 1.0;
  float lum = dot(col, vec3(.2126, .7152, .0722));
  col += n * (uGrain * .1 * (.55 + .9 * lum * (1.0 - lum) * 2.0) + .6 / 255.0);
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

function createGl(canvas: HTMLCanvasElement): Gl | null {
  const gl = canvas.getContext("webgl", { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: "low-power" });
  if (!gl) return null;
  const shader = (type: number, src: string) => {
    const s = gl.createShader(type);
    if (!s) return null;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
  };
  const vs = shader(gl.VERTEX_SHADER, VS), fs = shader(gl.FRAGMENT_SHADER, FS), prog = gl.createProgram();
  if (!vs || !fs || !prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "a");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const u: Gl["u"] = {};
  for (const name of ["uRes", "uBase", "uP", "uC", "uN", "uGrain", "uScale"]) u[name] = gl.getUniformLocation(prog, name);
  return { gl, prog, u, p: new Float32Array(MAX_GL * 4), c: new Float32Array(MAX_GL * 3) };
}

function drawGl(g: Gl, width: number, height: number, base: Rgb, layers: { x: number; y: number; r: number; col: Rgb }[], grain: number, scale: number) {
  const { gl, u } = g;
  const n = Math.min(MAX_GL, layers.length);
  g.p.fill(0);
  g.c.fill(0);
  for (let i = 0; i < n; i++) {
    const l = layers[i];
    g.p[i * 4] = l.x; g.p[i * 4 + 1] = l.y; g.p[i * 4 + 2] = l.r;
    g.c[i * 3] = l.col[0]; g.c[i * 3 + 1] = l.col[1]; g.c[i * 3 + 2] = l.col[2];
  }
  gl.viewport(0, 0, width, height);
  gl.uniform2f(u.uRes, width, height);
  gl.uniform3f(u.uBase, base[0], base[1], base[2]);
  gl.uniform4fv(u.uP, g.p);
  gl.uniform3fv(u.uC, g.c);
  gl.uniform1i(u.uN, n);
  gl.uniform1f(u.uGrain, grain);
  gl.uniform1f(u.uScale, Math.max(1, scale));
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

/** Critically damped spring, sub-stepped so a fast rate stays stable at a long frame. */
function springTo(x: number, v: number, to: number, w: number, dt: number): [number, number] {
  const n = Math.max(1, Math.ceil(dt * 240)), h = dt / n;
  for (let i = 0; i < n; i++) { v += (w * w * (to - x) - 2 * w * v) * h; x += v * h; }
  if (Math.abs(to - x) < 1e-4 && Math.abs(v) < 1e-3) return [to, 0];
  return [x, v];
}
function approach(c: Rgb, to: Rgb, k: number) {
  let moving = false;
  for (let i = 0; i < 3; i++) {
    const d = to[i] - c[i];
    if (Math.abs(d) < 1e-3) c[i] = to[i];
    else { c[i] += d * k; moving = true; }
  }
  return moving;
}

/** Writes a style value only when it changed, so an idle frame touches nothing. */
const seen = new WeakMap<Element, Record<string, string>>();
function put(node: Element | null | undefined, key: string, value: string, attr = false) {
  if (!node) return;
  let cache = seen.get(node);
  if (!cache) { cache = {}; seen.set(node, cache); }
  if (cache[key] === value) return;
  cache[key] = value;
  if (attr) node.setAttribute(key, value);
  else (node as HTMLElement).style.setProperty(key, value);
}

function makeSim(): Sim {
  return {
    pts: [], base: [1, 1, 1], tbase: [1, 1, 1], grain: 0, tgrain: 0, t: 0, drift: 0, vdrift: 0, driftOn: false, paused: false, speed: 1,
    reduced: false, visible: true, running: false, frame: 0, last: 0, drag: null, selected: "base", W: 0, H: 0, dpr: 1, gl: null,
    canvas: null, fallback: null, handles: new Map(), ellipse: null,
  };
}

function makePt(p: Pt, bloom: boolean): SimPt {
  const col = rgbOf(p.color);
  return { id: p.id, ax: p.x, ay: p.y, ar: p.spread, x: p.x, y: p.y, vx: 0, vy: 0, r: bloom ? 0 : p.spread, vr: 0, w: bloom ? 0 : 1, vw: 0, col: [...col], tcol: col, removing: false, ...driftParams(p.id) };
}

/** Where a point is drawn this frame: its spring position plus its share of the drift. */
function shown(s: Sim, p: SimPt) {
  const d = driftAt(p, s.t);
  const k = s.drift * p.w;
  return { x: p.x + d.dx * k, y: p.y + d.dy * k, r: p.r * (1 + (d.s - 1) * k) };
}

function stepSim(s: Sim, dt: number) {
  let moving = false;
  const driftTarget = s.driftOn && !s.reduced ? 1 : 0;
  if (s.reduced) { s.drift = driftTarget; s.vdrift = 0; }
  else [s.drift, s.vdrift] = springTo(s.drift, s.vdrift, driftTarget, W_DRIFT, dt);
  if (s.drift !== driftTarget) moving = true;
  if (s.drift > 1e-4 && !s.paused && !s.reduced) s.t = (s.t + dt * s.speed) % PERIOD;
  const k = s.reduced ? 1 : 1 - Math.exp(-dt * 11);
  for (const p of s.pts) {
    if (s.reduced) {
      p.x = p.ax; p.y = p.ay; p.r = p.ar; p.w = p.removing ? 0 : 1; p.vx = p.vy = p.vr = p.vw = 0;
    } else {
      const w = s.drag?.id === p.id ? W_DRAG : W_SETTLE;
      [p.x, p.vx] = springTo(p.x, p.vx, p.ax, w, dt);
      [p.y, p.vy] = springTo(p.y, p.vy, p.ay, w, dt);
      [p.r, p.vr] = springTo(p.r, p.vr, p.ar, W_SPREAD, dt);
      const wt = s.drag?.id === p.id ? 0 : 1;
      if (s.drag?.id !== p.id) [p.w, p.vw] = springTo(p.w, p.vw, wt, W_DRIFT, dt);
      if (p.x !== p.ax || p.y !== p.ay || p.r !== p.ar || p.w !== wt) moving = true;
    }
    if (approach(p.col, p.tcol, k)) moving = true;
  }
  s.pts = s.pts.filter(p => !(p.removing && p.r < .004));
  if (approach(s.base, s.tbase, k)) moving = true;
  const dg = s.tgrain - s.grain;
  if (Math.abs(dg) < 1e-3) s.grain = s.tgrain;
  else { s.grain += dg * k; moving = true; }
  return moving;
}

/** Handles stay inside the canvas even when their point sits on or past an edge. The first paint uses container units; the loop
 *  writes pixels from the cached canvas size, so it never reads layout. */
const handleAt = (x: number, y: number) => `translate(clamp(14px, ${(x * 100).toFixed(3)}cqw, calc(100cqw - 14px)), clamp(14px, ${(y * 100).toFixed(3)}cqh, calc(100cqh - 14px)))`;
const handlePx = (x: number, y: number, w: number, h: number) =>
  `translate3d(${clamp(x * w, 14, Math.max(14, w - 14)).toFixed(2)}px, ${clamp(y * h, 14, Math.max(14, h - 14)).toFixed(2)}px, 0)`;

function renderSim(s: Sim) {
  const layers = s.pts.map(p => ({ ...shown(s, p), col: p.col }));
  if (s.gl && s.canvas && s.canvas.width > 0) {
    drawGl(s.gl, s.canvas.width, s.canvas.height, s.base, layers, s.grain, s.dpr);
  } else if (s.fallback) {
    const hex = (c: Rgb) => `#${c.map(v => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`;
    const bg = backgroundOf(hex(s.base), layers.map(l => ({ color: hex(l.col), x: l.x, y: l.y, r: l.r })), s.grain);
    put(s.fallback, "background-color", String(bg.backgroundColor));
    put(s.fallback, "background-image", String(bg.backgroundImage));
    put(s.fallback, "background-blend-mode", bg.backgroundBlendMode ?? "normal");
  }
  layers.forEach((l, i) => {
    const p = s.pts[i];
    if (s.W > 0) put(s.handles.get(p.id), "transform", handlePx(l.x, l.y, s.W, s.H));
    if (p.id === s.selected && s.ellipse) {
      put(s.ellipse, "cx", (l.x * 100).toFixed(3), true);
      put(s.ellipse, "cy", (l.y * 100).toFixed(3), true);
      put(s.ellipse, "rx", (l.r * 50).toFixed(3), true);
      put(s.ellipse, "ry", (l.r * 50).toFixed(3), true);
    }
  });
}

function initialPoints(points: readonly MeshPoint[]): Pt[] {
  return points.map((p, i) => {
    const x = clamp(p.x, 0, 1), y = clamp(p.y, 0, 1);
    return { id: p.id ?? `p${i}`, color: normHex(p.color), x, y, spread: clamp(p.spread ?? .55, SPREAD_MIN, SPREAD_MAX), home: [x, y] };
  });
}

/** The emptiest spot on the canvas, for a point added without a position. */
function emptiest(pts: readonly Pt[]): [number, number] {
  let best: [number, number] = [.5, .5], bestD = -1;
  for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) {
    const x = .1 + i * .08, y = .12 + j * .058;
    const d = pts.reduce((m, p) => Math.min(m, Math.hypot((p.x - x) * 1.6, p.y - y)), Infinity);
    if (d > bestD) { bestD = d; best = [x, y]; }
  }
  return best;
}

/** Hex from hue (degrees), saturation and lightness (0 to 1). */
function hslHex(h: number, sat: number, light: number) {
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (n: number) => light - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return `#${[f(0), f(8), f(4)].map(v => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * A whole new design that still reads as one piece: a color scheme around a random hue (analogous, complementary, triadic
 * or split), a light or dark base in the same family, three to six points spread across the canvas, and a random grain.
 */
function randomDesign(max: number, rand: () => number = Math.random): { base: string; grain: number; points: Omit<Pt, "id">[] } {
  const hue = rand() * 360;
  const schemes = [[0, 28, -28, 52], [0, 180, 24, 204], [0, 120, 240, 20], [0, 150, 210, 30]];
  const offsets = schemes[Math.floor(rand() * schemes.length)];
  const dark = rand() < .45;
  const count = Math.min(max, 3 + Math.floor(rand() * 4));
  const base = dark ? hslHex(hue + 200 + rand() * 40, .35 + rand() * .3, .08 + rand() * .07) : hslHex(hue + rand() * 30, .3 + rand() * .4, .9 + rand() * .06);
  const points: Omit<Pt, "id">[] = [];
  for (let i = 0; i < count; i++) {
    const h = hue + offsets[i % offsets.length] + (rand() - .5) * 24;
    const light = dark ? .45 + rand() * .3 : .5 + rand() * .3;
    const color = hslHex(((h % 360) + 360) % 360, .62 + rand() * .33, light);
    /* Points sit on a jittered ring around a random center, so they cover the canvas instead of clumping. */
    const angle = (i / count) * Math.PI * 2 + rand() * .9;
    const reach = .28 + rand() * .22;
    const x = clamp(.5 + Math.cos(angle) * reach * 1.1 + (rand() - .5) * .2, .04, .96);
    const y = clamp(.5 + Math.sin(angle) * reach + (rand() - .5) * .2, .04, .96);
    points.push({ color, x, y, spread: clamp(.38 + rand() * .45, SPREAD_MIN, SPREAD_MAX), home: [x, y] });
  }
  return { base, grain: Math.round(rand() * 45) / 100, points };
}

/** Follows the reduced motion setting live. False on the server. */
const REDUCE = "(prefers-reduced-motion: reduce)";
const subscribeReduced = (onChange: () => void) => {
  const query = window.matchMedia(REDUCE);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};
const useReducedFlag = () => useSyncExternalStore(subscribeReduced, () => window.matchMedia(REDUCE).matches, () => false);

export function GradientMesh({
  points: pointsProp = DEFAULT_POINTS,
  base: baseProp = "#f8efe4",
  palette = DEFAULT_PALETTE,
  grain: grainProp = .3,
  animate: animateProp = true,
  speed = 1,
  paused = false,
  maxPoints = 8,
  accent,
  hint = "Drag a point to move it. Double click to add one.",
  label = "Gradient mesh",
  onChange,
  onExport,
  mode = "editor",
  className,
  style,
}: GradientMeshProps) {
  const background = mode === "background";
  const uid = useId();
  const reduced = useReducedFlag();
  const max = clamp(Math.round(maxPoints), 2, 8);
  const [pts, setPts] = useState<Pt[]>(() => initialPoints(pointsProp).slice(0, max));
  const [base, setBase] = useState(() => normHex(baseProp));
  const [grain, setGrain] = useState(() => clamp(grainProp, 0, 1));
  const [animateOn, setAnimateOn] = useState(animateProp);
  const [target, setTarget] = useState<string>(() => pts[2]?.id ?? pts[0]?.id ?? "base");
  const [message, setMessage] = useState("");
  const [copied, setCopied] = useState<"idle" | "done" | "error">("idle");
  const [saved, setSaved] = useState<"idle" | "done" | "error">("idle");
  const [noGl, setNoGl] = useState(false);
  const [touched, setTouched] = useState(false);
  /* In background mode the props drive the mesh directly; the editor owns its design after mount. */
  const propPts = useMemo(() => initialPoints(pointsProp).slice(0, max), [pointsProp, max]);
  const livePts = background ? propPts : pts;
  const liveBase = background ? normHex(baseProp) : base;
  const liveGrain = background ? clamp(grainProp, 0, 1) : grain;
  const liveAnimate = background ? animateProp : animateOn;
  const [staticBg] = useState(() => backgroundOf(base, pts.map(p => ({ color: p.color, x: p.x, y: p.y, r: p.spread })), grain));

  const simRef = useRef<Sim | null>(null);
  const getSim = useCallback(() => (simRef.current ??= makeSim()), []);
  const stageRef = useRef<HTMLDivElement>(null);
  const planeRef = useRef<HTMLDivElement>(null);
  const counter = useRef(0);
  const focusNext = useRef<string | null>(null);
  const spreadTimer = useRef(0);
  const feedbackTimers = useRef<number[]>([]);
  const mounted = useRef(false);
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; });

  const kick = useCallback(() => {
    const s = getSim();
    if (s.running || !s.visible) return;
    s.running = true;
    s.last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(.05, Math.max(0, (now - s.last) / 1000));
      s.last = now;
      const moving = stepSim(s, dt);
      renderSim(s);
      const live = s.drift > 1e-3 && !s.paused && !s.reduced && s.speed > 0;
      if (s.visible && (moving || live || s.drag)) s.frame = requestAnimationFrame(tick);
      else s.running = false;
    };
    s.frame = requestAnimationFrame(tick);
  }, [getSim]);

  /* Mirror the saved design into the simulation; springs carry the view to it. */
  useLayoutEffect(() => {
    const s = getSim();
    const first = !mounted.current;
    const ids = new Set(livePts.map(p => p.id));
    for (const p of s.pts) if (!ids.has(p.id)) { p.removing = true; p.ar = 0; }
    for (const p of livePts) {
      const q = s.pts.find(x => x.id === p.id);
      if (!q) { s.pts.push(makePt(p, !first)); continue; }
      if (s.drag?.id !== p.id) { q.ax = p.x; q.ay = p.y; }
      q.ar = p.spread;
      q.tcol = rgbOf(p.color);
      q.removing = false;
    }
    kick();
  }, [livePts, getSim, kick]);

  useLayoutEffect(() => {
    const s = getSim();
    s.tbase = rgbOf(liveBase);
    if (!mounted.current) s.base = [...s.tbase];
    kick();
  }, [liveBase, getSim, kick]);

  useLayoutEffect(() => {
    const s = getSim();
    s.tgrain = liveGrain;
    if (!mounted.current) s.grain = liveGrain;
    kick();
  }, [liveGrain, getSim, kick]);

  useLayoutEffect(() => {
    const s = getSim();
    s.driftOn = liveAnimate;
    s.paused = paused;
    s.speed = Math.max(0, speed);
    s.reduced = reduced;
    /* The server paints every point at rest, so the drift always eases in from zero: no jump between that paint and frame one. */
    kick();
  }, [liveAnimate, paused, speed, reduced, getSim, kick]);

  useLayoutEffect(() => {
    const s = getSim();
    s.selected = target;
    kick();
    if (focusNext.current) {
      s.handles.get(focusNext.current)?.focus();
      focusNext.current = null;
    }
  }, [target, getSim, kick]);

  useEffect(() => { mounted.current = true; }, []);

  /* Report the saved design after each change. */
  const reported = useRef(false);
  useEffect(() => {
    if (!reported.current) { reported.current = true; return; }
    onChangeRef.current?.({ base, grain, animate: animateOn, points: pts.map(p => ({ id: p.id, name: nameOf(p.color, palette), color: p.color, x: p.x, y: p.y, spread: p.spread })) });
  }, [pts, base, grain, animateOn, palette]);

  /* Canvas, size, visibility, and wheel to resize a point. */
  useEffect(() => {
    const s = getSim(), stage = stageRef.current, plane = planeRef.current;
    if (!stage || !s.canvas) return;
    const canvas = s.canvas;
    s.gl = createGl(canvas);
    if (!s.gl) queueMicrotask(() => setNoGl(true));
    const onLost = (e: Event) => { e.preventDefault(); s.gl = null; setNoGl(true); };
    canvas.addEventListener("webglcontextlost", onLost);

    const resize = new ResizeObserver(entries => {
      const box = entries[0].contentRect;
      s.W = box.width; s.H = box.height;
      s.dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(box.width * s.dpr));
      canvas.height = Math.max(1, Math.round(box.height * s.dpr));
      renderSim(s);
      kick();
    });
    resize.observe(stage);

    let inView = true;
    const update = () => {
      const visible = inView && document.visibilityState === "visible";
      if (visible === s.visible) return;
      s.visible = visible;
      if (visible) kick();
      else { cancelAnimationFrame(s.frame); s.running = false; }
    };
    const io = new IntersectionObserver(([entry]) => { inView = entry.isIntersecting; update(); });
    io.observe(stage);
    document.addEventListener("visibilitychange", update);

    const onWheel = (e: WheelEvent) => {
      const handle = (e.target as Element).closest<HTMLElement>("[data-point]");
      const id = handle?.dataset.point;
      const p = id ? s.pts.find(q => q.id === id) : undefined;
      if (!id || !p) return;
      e.preventDefault();
      p.ar = clamp(p.ar * Math.exp(-e.deltaY * .0015), SPREAD_MIN, SPREAD_MAX);
      kick();
      window.clearTimeout(spreadTimer.current);
      spreadTimer.current = window.setTimeout(() => {
        setPts(prev => prev.map(q => q.id === id ? { ...q, spread: +p.ar.toFixed(3) } : q));
        setMessage(`Size ${Math.round(p.ar * 100)}%`);
      }, 220);
    };
    plane?.addEventListener("wheel", onWheel, { passive: false });
    const timers = feedbackTimers.current;

    return () => {
      canvas.removeEventListener("webglcontextlost", onLost);
      plane?.removeEventListener("wheel", onWheel);
      resize.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", update);
      cancelAnimationFrame(s.frame);
      s.running = false;
      window.clearTimeout(spreadTimer.current);
      timers.forEach(t => window.clearTimeout(t));
    };
  }, [getSim, kick]);

  const nameFor = (id: string) => {
    const i = pts.findIndex(p => p.id === id);
    return i < 0 ? "Base" : `Point ${i + 1}, ${nameOf(pts[i].color, palette)}`;
  };

  const addPoint = (at?: [number, number]) => {
    if (pts.length >= max) { setMessage(`Up to ${max} points`); return; }
    const [x, y] = at ?? emptiest(pts);
    const used = new Set(pts.map(p => normHex(p.color)));
    const color = normHex((palette.find(s => !used.has(normHex(s.color))) ?? palette[pts.length % palette.length] ?? { color: "#888888" }).color);
    let id = `n${counter.current++}`;
    while (pts.some(p => p.id === id)) id = `n${counter.current++}`;
    const next: Pt = { id, color, x: clamp(x, 0, 1), y: clamp(y, 0, 1), spread: .5, home: [clamp(x, 0, 1), clamp(y, 0, 1)] };
    setPts([...pts, next]);
    setTarget(id);
    setTouched(true);
    setMessage(`Point ${pts.length + 1}, ${nameOf(color, palette)} added`);
  };

  /** Fully randomizes the design. Existing points keep their ids, so the springs carry them to the new layout. */
  const randomize = () => {
    const next = randomDesign(max);
    const points: Pt[] = next.points.map((p, i) => {
      let id = pts[i]?.id;
      if (!id) { id = `n${counter.current++}`; while (pts.some(q => q.id === id)) id = `n${counter.current++}`; }
      return { ...p, id };
    });
    setPts(points);
    setBase(next.base);
    setGrain(next.grain);
    setTarget(points[0].id);
    setTouched(true);
    setMessage(`New random mesh with ${points.length} points`);
  };

  const removePoint = (id: string, refocus: boolean) => {
    const i = pts.findIndex(p => p.id === id);
    if (i < 0) return;
    if (pts.length <= 2) { setMessage("A mesh needs at least two points"); return; }
    const rest = pts.filter(p => p.id !== id);
    const next = rest[Math.max(0, i - 1)]?.id ?? "base";
    setPts(rest);
    if (refocus) focusNext.current = next;
    setTarget(next);
    setTouched(true);
    setMessage(`${nameFor(id)} removed`);
  };

  const recolor = (color: string) => {
    const hex = normHex(color);
    if (target === "base") setBase(hex);
    else setPts(prev => prev.map(p => p.id === target ? { ...p, color: hex } : p));
    setTouched(true);
  };

  const commitMove = (id: string, x: number, y: number) => {
    setPts(prev => prev.map(p => p.id === id ? { ...p, x, y } : p));
  };

  /* Pointer: a held point follows the finger on a stiff spring and lets go of the drift; release eases it back in. */
  const onHandleDown = (e: ReactPointerEvent<HTMLButtonElement>, id: string) => {
    if (e.button !== 0) return;
    const s = getSim(), p = s.pts.find(q => q.id === id), stage = stageRef.current;
    if (!p || !stage) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = stage.getBoundingClientRect();
    const at = shown(s, p);
    p.ax = p.x = clamp(at.x, 0, 1); p.ay = p.y = clamp(at.y, 0, 1); p.vx = p.vy = 0;
    p.w = 0; p.vw = 0;
    s.drag = { id, pointer: e.pointerId, gx: (e.clientX - rect.left) / rect.width - p.x, gy: (e.clientY - rect.top) / rect.height - p.y, rect };
    e.currentTarget.dataset.dragging = "true";
    setTarget(id);
    setTouched(true);
    kick();
  };
  const onHandleMove = (e: ReactPointerEvent<HTMLButtonElement>, id: string) => {
    const s = getSim(), d = s.drag;
    if (!d || d.id !== id || d.pointer !== e.pointerId) return;
    const p = s.pts.find(q => q.id === id);
    if (!p) return;
    p.ax = clamp((e.clientX - d.rect.left) / d.rect.width - d.gx, 0, 1);
    p.ay = clamp((e.clientY - d.rect.top) / d.rect.height - d.gy, 0, 1);
    kick();
  };
  const onHandleUp = (e: ReactPointerEvent<HTMLButtonElement>, id: string) => {
    const s = getSim(), d = s.drag;
    if (!d || d.id !== id || d.pointer !== e.pointerId) return;
    s.drag = null;
    delete e.currentTarget.dataset.dragging;
    const p = s.pts.find(q => q.id === id);
    if (p) {
      commitMove(id, +p.ax.toFixed(4), +p.ay.toFixed(4));
      setMessage(`${nameFor(id)} at ${Math.round(p.ax * 100)}% across, ${Math.round(p.ay * 100)}% down`);
    }
    kick();
  };

  const onHandleKey = (e: ReactKeyboardEvent<HTMLButtonElement>, id: string) => {
    const p = pts.find(q => q.id === id);
    if (!p) return;
    const step = e.shiftKey ? .1 : e.altKey ? .0025 : .01;
    let x = p.x, y = p.y, spread = p.spread;
    switch (e.key) {
      case "ArrowLeft": x -= step; break;
      case "ArrowRight": x += step; break;
      case "ArrowUp": y -= step; break;
      case "ArrowDown": y += step; break;
      case "+": case "=": case "]": spread += e.shiftKey && e.key !== "+" ? .15 : .05; break;
      case "-": case "_": case "[": spread -= .05; break;
      case "Delete": case "Backspace": e.preventDefault(); removePoint(id, true); return;
      case "Escape": e.preventDefault(); setTarget("base"); setMessage("Base selected"); return;
      default: return;
    }
    e.preventDefault();
    x = +clamp(x, 0, 1).toFixed(4); y = +clamp(y, 0, 1).toFixed(4); spread = +clamp(spread, SPREAD_MIN, SPREAD_MAX).toFixed(3);
    setPts(prev => prev.map(q => q.id === id ? { ...q, x, y, spread } : q));
    setTarget(id);
    setTouched(true);
    setMessage(spread !== p.spread ? `Size ${Math.round(spread * 100)}%` : `${Math.round(x * 100)}% across, ${Math.round(y * 100)}% down`);
  };

  const onStageClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if ((e.target as Element).closest("[data-point]")) return;
    if (target !== "base") { setTarget("base"); setMessage("Base selected"); }
  };
  const onStageDouble = (e: ReactMouseEvent<HTMLDivElement>) => {
    if ((e.target as Element).closest("[data-point]")) return;
    const rect = e.currentTarget.getBoundingClientRect();
    addPoint([(e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height]);
  };

  const flash = (set: (v: "idle" | "done" | "error") => void, v: "done" | "error") => {
    set(v);
    feedbackTimers.current.push(window.setTimeout(() => set("idle"), 1800));
  };

  const copyCss = async () => {
    const css = meshCss(base, pts, grain, animateOn, speed);
    try {
      await navigator.clipboard.writeText(css);
      flash(setCopied, "done");
      setMessage("CSS copied");
      onExport?.("css", css);
    } catch {
      flash(setCopied, "error");
      setMessage("Could not copy. Allow clipboard access and try again.");
    }
  };

  const savePng = () => {
    const s = getSim(), canvas = s.canvas;
    if (!s.gl || !canvas || !s.W) { flash(setSaved, "error"); return; }
    const w = EXPORT_WIDTH, h = Math.round((EXPORT_WIDTH * s.H) / s.W);
    const keep = [canvas.width, canvas.height] as const;
    canvas.width = w; canvas.height = h;
    const layers = pts.map(p => ({ x: p.x, y: p.y, r: p.spread, col: rgbOf(p.color) }));
    drawGl(s.gl, w, h, rgbOf(base), layers, grain, w / s.W);
    canvas.toBlob(blob => {
      if (!blob) { flash(setSaved, "error"); setMessage("Could not create the image"); return; }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "gradient-mesh.png";
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 4000);
      flash(setSaved, "done");
      setMessage(`Image saved, ${w} by ${h} pixels`);
      onExport?.("png", blob);
    }, "image/png");
    canvas.width = keep[0]; canvas.height = keep[1];
    renderSim(s);
  };

  const targetColor = target === "base" ? base : pts.find(p => p.id === target)?.color ?? base;
  const checkedIndex = palette.findIndex(sw => normHex(sw.color) === normHex(targetColor));
  const focusIndex = checkedIndex >= 0 ? checkedIndex : 0;
  const swatchRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const onSwatchKey = (e: ReactKeyboardEvent<HTMLButtonElement>, i: number) => {
    const n = palette.length;
    let next = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % n;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (i - 1 + n) % n;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    if (next < 0) return;
    e.preventDefault();
    recolor(palette[next].color);
    swatchRefs.current[next]?.focus();
  };

  const selectedPt = pts.find(p => p.id === target);
  const layoutTransition = reduced ? { duration: 0 } : motionTokens.spring.morph;
  const description = `Mesh gradient of ${pts.map(p => nameOf(p.color, palette)).join(", ")} on ${nameOf(base, palette)}${grain > .005 ? `, ${Math.round(grain * 100)}% grain` : ""}`;

  if (background) {
    return (
      <div aria-hidden="true" className={[styles.root, styles.background, className].filter(Boolean).join(" ")} style={style}>
        <div ref={stageRef} className={styles.stage}>
          <div ref={el => { getSim().fallback = el; }} className={styles.fallback} style={staticBg} />
          <canvas ref={el => { getSim().canvas = el; }} className={styles.canvas} data-hidden={noGl || undefined} />
        </div>
      </div>
    );
  }

  return (
    <div
      role="group"
      aria-label={label}
      className={[styles.root, className].filter(Boolean).join(" ")}
      style={{ ...(accent ? { "--mesh-accent": accent } : null), ...style } as CSSProperties}
    >
      <div className={styles.canvasWrap}>
        <div ref={stageRef} className={styles.stage} onClick={onStageClick} onDoubleClick={onStageDouble}>
          <div ref={el => { getSim().fallback = el; }} className={styles.fallback} style={staticBg} aria-hidden="true" />
          <canvas ref={el => { getSim().canvas = el; }} className={styles.canvas} data-hidden={noGl || undefined} role="img" aria-label={description} />
          <div ref={planeRef} className={styles.plane}>
            <svg className={styles.overlay} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              <ellipse ref={el => { getSim().ellipse = el; }} className={styles.reach} data-show={target !== "base" || undefined} cx="50" cy="50" rx="0" ry="0" />
            </svg>
            {pts.map((p, i) => (
              <button
                key={p.id}
                ref={el => { const s = getSim(); if (el) { s.handles.set(p.id, el); } else s.handles.delete(p.id); }}
                type="button"
                data-point={p.id}
                data-selected={target === p.id || undefined}
                className={styles.handle}
                style={{ "--c": p.color, transform: handleAt(p.home[0], p.home[1]) } as CSSProperties}
                aria-label={`Point ${i + 1}, ${nameOf(p.color, palette)}, ${Math.round(p.x * 100)}% across, ${Math.round(p.y * 100)}% down, size ${Math.round(p.spread * 100)}%`}
                aria-pressed={target === p.id}
                aria-roledescription="draggable point"
                aria-describedby={`${uid}-keys`}
                onPointerDown={e => onHandleDown(e, p.id)}
                onPointerMove={e => onHandleMove(e, p.id)}
                onPointerUp={e => onHandleUp(e, p.id)}
                onPointerCancel={e => onHandleUp(e, p.id)}
                onKeyDown={e => onHandleKey(e, p.id)}
                onClick={() => setTarget(p.id)}
                onFocus={() => setTarget(p.id)}
              >
                <span className={styles.dot} aria-hidden="true" />
              </button>
            ))}
          </div>
          {hint ? <p className={styles.hint} data-hidden={touched || undefined} aria-hidden="true">{hint}</p> : null}
        </div>

        <div className={styles.bar}>
          <button type="button" className={styles.baseButton} aria-pressed={target === "base"} onClick={() => { setTarget("base"); setMessage("Base selected"); }}>
            <span className={styles.baseDot} style={{ "--c": base } as CSSProperties} aria-hidden="true" />
            Base
          </button>
          <span className={styles.divider} aria-hidden="true" />
          <div role="radiogroup" aria-label={`Color for ${target === "base" ? "the base" : nameFor(target).replace(/, [^,]+$/, "")}`} className={styles.swatches}>
            {palette.map((sw, i) => {
              const on = i === checkedIndex;
              return (
                <button
                  key={sw.name + sw.color}
                  ref={el => { swatchRefs.current[i] = el; }}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-label={sw.name}
                  tabIndex={i === focusIndex ? 0 : -1}
                  className={styles.swatch}
                  style={{ "--c": normHex(sw.color) } as CSSProperties}
                  onClick={() => recolor(sw.color)}
                  onKeyDown={e => onSwatchKey(e, i)}
                >
                  {on ? <motion.span layoutId={`${uid}-ring`} className={styles.swatchRing} transition={layoutTransition} aria-hidden="true" /> : null}
                  <span className={styles.swatchFill} aria-hidden="true" />
                </button>
              );
            })}
          </div>
          <label className={styles.iconButton} data-on={checkedIndex < 0 || undefined}>
            <Pipette size={16} strokeWidth={1.75} aria-hidden="true" />
            <input className={styles.colorInput} type="color" value={normHex(targetColor)} onChange={e => recolor(e.target.value)} aria-label={`Custom color for ${target === "base" ? "the base" : "the point"}`} />
          </label>
          <button
            type="button"
            className={styles.iconButton}
            disabled={!selectedPt || pts.length <= 2}
            aria-label={selectedPt ? `Remove ${nameFor(selectedPt.id)}` : "Remove point"}
            onClick={() => selectedPt && removePoint(selectedPt.id, false)}
          >
            <Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className={styles.footer}>
        <div className={styles.settings}>
          <div className={styles.grain}>
            <Slider label="Grain" value={Math.round(grain * 100)} onValueChange={v => { setGrain(v / 100); setTouched(true); }} min={0} max={100} step={1} format={v => `${v}%`} showValue />
          </div>
          <Switch label="Animate" checked={animateOn && !reduced} disabled={reduced} onCheckedChange={v => { setAnimateOn(v); setMessage(v ? "Drift on" : "Drift off"); }} />
        </div>
        <div className={styles.actions}>
          <Button variant="secondary" size="sm" onClick={randomize}>
            <Shuffle size={16} strokeWidth={1.75} aria-hidden="true" />Randomize
          </Button>
          <Button variant="secondary" size="sm" onClick={() => addPoint()} disabled={pts.length >= max}>
            <Plus size={16} strokeWidth={1.75} aria-hidden="true" />Add point
          </Button>
          <Button variant="secondary" size="sm" className={styles.copyButton} onClick={copyCss}>
            {copied === "done" ? <><Check size={16} strokeWidth={1.75} aria-hidden="true" />Copied</> : copied === "error" ? <><X size={16} strokeWidth={1.75} aria-hidden="true" />Not copied</> : <><Copy size={16} strokeWidth={1.75} aria-hidden="true" />Copy CSS</>}
          </Button>
          <Button variant="primary" size="sm" className={styles.saveButton} onClick={savePng} disabled={noGl}>
            {saved === "done" ? <><Check size={16} strokeWidth={1.75} aria-hidden="true" />Saved</> : saved === "error" ? <><X size={16} strokeWidth={1.75} aria-hidden="true" />Not saved</> : <><Download size={16} strokeWidth={1.75} aria-hidden="true" />Save PNG</>}
          </Button>
        </div>
      </div>

      <p id={`${uid}-keys`} className={styles.srOnly}>Arrow keys move the point, Shift moves further. Plus and minus change its size. Delete removes it. Escape selects the base. Scroll on a point to resize it.</p>
      <p className={styles.srOnly} role="status" aria-live="polite">{message}</p>
    </div>
  );
}

export default GradientMesh;
