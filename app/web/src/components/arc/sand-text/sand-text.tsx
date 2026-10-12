"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import type { CSSProperties } from "react";
import { useReducedMotion } from "motion/react";
import styles from "./sand-text.module.css";

/**
 * A headline made of sand. Grains pour in from above and pack into the letters, the pointer digs through them and
 * throws grains that tumble and pile up like real sand, and once the pointer rests the letters heal: loose grains that
 * land in a gap stick again, fresh sand pours into what is missing, and the extra drifts away. Changing the text
 * collapses the old word into sand that refills the new one. The real text stays in the heading for screen readers.
 */
export interface SandTextProps {
  /** The text to form. Keep it to one short line. */
  text: string;
  /** Grain size in CSS px. Defaults to 2. */
  grain?: number;
  /** Radius the pointer digs through, in CSS px. Defaults to 14. */
  radius?: number;
  /** Grain colors. Each grain picks one and varies it slightly. Defaults to the text color. */
  palette?: string[];
  /** Heading element. Defaults to "h2". */
  as?: "h1" | "h2" | "h3" | "p";
  className?: string;
  style?: CSSProperties;
}

const subscribe = () => () => {};
function useReducedFlag() {
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);
  return !!useReducedMotion() && hydrated;
}

const EMPTY = 0, FIXED = 1, LOOSE = 2;
const HEAL_DELAY = 650;

interface Grain { x: number; y: number; vx: number; vy: number; tone: number; target: number }

export function SandText({ text, grain = 2, radius = 14, palette, as: Tag = "h2", className, style }: SandTextProps) {
  const reduced = useReducedFlag();
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engine = useRef<{ setText: (value: string) => void } | null>(null);
  const live = useRef({ radius });
  useEffect(() => { live.current = { radius }; });
  const paletteKey = palette?.join("|") ?? "";

  useEffect(() => {
    const root = rootRef.current, canvas = canvasRef.current;
    if (!root || !canvas) return;
    const ctx = canvas.getContext("2d");
    const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    if (!ctx || !probe) return;

    // Resolve the palette to rgb and build a small spread of shades per color. Without a palette the grains take the text color.
    let shades: number[][] = [];
    const buildShades = () => {
      shades = [];
      const colors = paletteKey ? paletteKey.split("|") : [getComputedStyle(root).color];
      for (const color of colors) {
        probe.clearRect(0, 0, 1, 1);
        probe.fillStyle = "#777";
        probe.fillStyle = color;
        probe.fillRect(0, 0, 1, 1);
        const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
        for (const k of [-36, -18, 0, 18, 36]) shades.push([r + k, g + k, b + k].map(v => Math.max(0, Math.min(255, v))));
      }
    };
    buildShades();

    let cols = 0, rows = 0, dpr = 1, cell = grain;
    let state = new Uint8Array(0), target = new Uint8Array(0), tone = new Uint8Array(0), rest = new Uint8Array(0), claimed = new Uint8Array(0);
    let targets: number[] = [];
    let flying: Grain[] = [];
    let image: ImageData | null = null;
    const small = document.createElement("canvas");
    let frame = 0, cancelled = false, lastDig = -Infinity, parity = 0, current = "";
    const pointer = { x: 0, y: 0, px: 0, py: 0, inside: false };

    const randomTone = () => (Math.random() * shades.length) | 0;

    /** Rasterizes the text at grain resolution and marks the letter cells as targets. */
    const rasterize = (value: string) => {
      target.fill(0);
      targets = [];
      if (!cols || !value) return;
      const mask = document.createElement("canvas");
      mask.width = cols; mask.height = rows;
      const m = mask.getContext("2d", { willReadFrequently: true })!;
      const computed = getComputedStyle(root);
      let size = parseFloat(computed.fontSize) / cell;
      const family = computed.fontFamily;
      m.font = `500 ${size}px ${family}`;
      const measured = m.measureText(value).width;
      if (measured > cols * .94) size *= cols * .94 / measured;
      m.font = `500 ${size}px ${family}`;
      if ("letterSpacing" in m) (m as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${-size * .03}px`;
      m.textAlign = "center";
      m.textBaseline = "alphabetic";
      m.fillStyle = "#000";
      const metrics = m.measureText(value);
      const ascent = metrics.actualBoundingBoxAscent, descent = metrics.actualBoundingBoxDescent;
      const baseline = Math.round((rows - 3 - (ascent + descent)) * .42 + ascent);
      m.fillText(value, cols / 2, baseline);
      const data = m.getImageData(0, 0, cols, rows).data;
      for (let i = 0; i < cols * rows; i++) if (data[i * 4 + 3] > 120) { target[i] = 1; targets.push(i); }
      // Grains already pouring toward cells the new text no longer uses fall as loose sand instead of sticking where the old letters were.
      for (const g of flying) if (g.target >= 0 && !target[g.target]) { claimed[g.target] = 0; g.target = -1; }
    };

    /** Old letter cells that are no longer part of the text collapse into loose sand. */
    const setText = (value: string) => {
      current = value;
      if (!cols) return;
      rasterize(value);
      claimed.fill(0);
      for (let i = 0; i < state.length; i++) {
        if (state[i] === FIXED && !target[i]) { state[i] = LOOSE; rest[i] = 0; }
      }
      if (reduced) {
        state.fill(EMPTY);
        for (const i of targets) { state[i] = FIXED; tone[i] = randomTone(); }
        flying = [];
      } else {
        lastDig = -Infinity;
      }
      schedule();
    };

    const resize = () => {
      const rect = root.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      cell = Math.max(2, grain);
      const nextCols = Math.max(20, Math.floor(rect.width / cell)), nextRows = Math.max(12, Math.floor(rect.height / cell));
      if (nextCols === cols && nextRows === rows) return;
      const first = !cols;
      cols = nextCols; rows = nextRows;
      const size = cols * rows;
      state = new Uint8Array(size); target = new Uint8Array(size); tone = new Uint8Array(size); rest = new Uint8Array(size); claimed = new Uint8Array(size);
      flying = [];
      small.width = cols; small.height = rows;
      image = new ImageData(cols, rows);
      canvas.width = Math.round(cols * cell * dpr); canvas.height = Math.round(rows * cell * dpr);
      canvas.style.width = `${cols * cell}px`; canvas.style.height = `${rows * cell}px`;
      rasterize(current);
      // After a resize the letters re-form instantly; only the first build pours in.
      if (!first || reduced) for (const i of targets) { state[i] = FIXED; tone[i] = randomTone(); }
      schedule();
    };

    const settle = (g: Grain, cx: number, cy: number) => {
      let y = cy;
      while (y >= 0 && state[y * cols + cx] !== EMPTY) y--;
      if (y < 0) return;
      const i = y * cols + cx;
      state[i] = g.target === i || (target[i] && !nearPointer(cx, y)) ? FIXED : LOOSE;
      tone[i] = g.tone; rest[i] = 0;
      if (g.target >= 0) claimed[g.target] = 0;
    };

    const nearPointer = (cx: number, cy: number) => {
      if (!pointer.inside) return false;
      const reach = live.current.radius / cell * 1.25;
      const dx = cx + .5 - pointer.x, dy = cy + .5 - pointer.y;
      return dx * dx + dy * dy < reach * reach;
    };

    const dig = () => {
      const reach = live.current.radius / cell;
      const vx = pointer.x - pointer.px, vy = pointer.y - pointer.py;
      const speed = Math.hypot(vx, vy);
      pointer.px = pointer.x; pointer.py = pointer.y;
      if (speed < .15) return false;
      const x0 = Math.max(0, Math.floor(pointer.x - reach)), x1 = Math.min(cols - 1, Math.ceil(pointer.x + reach));
      const y0 = Math.max(0, Math.floor(pointer.y - reach)), y1 = Math.min(rows - 1, Math.ceil(pointer.y + reach));
      let dug = false;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const i = y * cols + x;
        if (state[i] === EMPTY) continue;
        const dx = x + .5 - pointer.x, dy = y + .5 - pointer.y;
        const d = Math.hypot(dx, dy);
        if (d > reach) continue;
        state[i] = EMPTY;
        const push = (1 - d / reach) * .9 + .25;
        flying.push({
          x: x + .5, y: y + .5, tone: tone[i], target: -1,
          vx: dx / (d || 1) * push + vx * (.25 + Math.random() * .25) + (Math.random() - .5) * .5,
          vy: dy / (d || 1) * push + vy * (.2 + Math.random() * .2) - Math.random() * 1.1,
        });
        dug = true;
      }
      return dug;
    };

    const pour = () => {
      let budget = Math.max(24, Math.round(targets.length / 55));
      // Bottom first with a little shuffle, so the letters fill like jars and the streams look loose.
      const open: number[] = [];
      for (const i of targets) if (state[i] === EMPTY && !claimed[i]) open.push(i);
      if (!open.length) return false;
      open.sort((a, b) => ((b / cols) | 0) - ((a / cols) | 0) + (Math.random() - .5) * 6);
      for (const i of open) {
        if (budget-- <= 0) break;
        const x = i % cols;
        claimed[i] = 1;
        flying.push({ x: x + .5, y: -1 - Math.random() * 10, vx: 0, vy: 1.4 + Math.random() * .8, tone: randomTone(), target: i });
      }
      return true;
    };

    const stepFlying = () => {
      const next: Grain[] = [];
      for (const g of flying) {
        g.vy = Math.min(g.target >= 0 ? 5 : 4, g.vy + .22);
        g.vx *= .96;
        const steps = Math.max(1, Math.ceil(Math.max(Math.abs(g.vx), Math.abs(g.vy))));
        let alive = true;
        for (let s = 0; s < steps; s++) {
          const nx = g.x + g.vx / steps, ny = g.y + g.vy / steps;
          const cx = Math.floor(nx), cy = Math.floor(ny);
          if (cx < 0 || cx >= cols) { alive = false; if (g.target >= 0) claimed[g.target] = 0; break; }
          if (g.target >= 0) {
            const tx = g.target % cols, ty = (g.target / cols) | 0;
            if (cy >= ty) {
              if (state[g.target] === EMPTY) { state[g.target] = FIXED; tone[g.target] = g.tone; }
              else settle(g, tx, ty);
              claimed[g.target] = 0;
              alive = false; break;
            }
            g.x = nx; g.y = ny;
            continue;
          }
          if (cy >= rows) { settle(g, Math.floor(g.x), rows - 1); alive = false; break; }
          if (cy >= 0 && state[cy * cols + cx] !== EMPTY) { settle(g, Math.floor(g.x), Math.max(0, Math.floor(g.y))); alive = false; break; }
          g.x = nx; g.y = ny;
        }
        if (alive) next.push(g);
      }
      flying = next;
    };

    /** Classic falling sand: down, else diagonally down, else rest. Resting grains inside a letter stick again. */
    const stepLoose = (healing: boolean) => {
      // A grain that just came to rest still has to stick or drift away, so the loop keeps running until no loose grain is left.
      let moved = false, settling = false;
      const excess: number[] = [];
      parity ^= 1;
      for (let y = rows - 1; y >= 0; y--) {
        for (let n = 0; n < cols; n++) {
          const x = parity ? n : cols - 1 - n;
          const i = y * cols + x;
          if (state[i] !== LOOSE) continue;
          if (y < rows - 1) {
            const below = i + cols;
            if (state[below] === EMPTY) { state[below] = LOOSE; tone[below] = tone[i]; rest[below] = 0; state[i] = EMPTY; moved = true; continue; }
            const first = Math.random() < .5 ? -1 : 1;
            let slid = false;
            for (const side of [first, -first]) {
              const sx = x + side;
              if (sx < 0 || sx >= cols) continue;
              const j = below + side;
              if (state[j] === EMPTY && state[i + side] === EMPTY) { state[j] = LOOSE; tone[j] = tone[i]; rest[j] = 0; state[i] = EMPTY; slid = true; break; }
            }
            if (slid) { moved = true; continue; }
          }
          if (rest[i] < 255) rest[i]++;
          if (target[i] && rest[i] > 4 && !nearPointer(x, y)) state[i] = FIXED;
          else if (!target[i] && rest[i] > 20) excess.push(i);
          else settling = true;
        }
      }
      let drifting = excess.length > 0;
      if (healing && excess.length) {
        const remove = Math.max(3, Math.round(excess.length * .03));
        for (let k = 0; k < remove && excess.length; k++) {
          const pick = (Math.random() * excess.length) | 0;
          state[excess[pick]] = EMPTY;
          excess[pick] = excess[excess.length - 1];
          excess.pop();
        }
        drifting = true;
      }
      return moved || drifting || settling;
    };

    const render = () => {
      if (!image) return;
      const data = image.data;
      data.fill(0);
      const paint = (i: number, t: number) => {
        const color = shades[t % shades.length];
        const o = i * 4;
        data[o] = color[0]; data[o + 1] = color[1]; data[o + 2] = color[2]; data[o + 3] = 255;
      };
      for (let i = 0; i < state.length; i++) if (state[i] !== EMPTY) paint(i, tone[i]);
      for (const g of flying) {
        const cx = Math.floor(g.x), cy = Math.floor(g.y);
        if (cx >= 0 && cx < cols && cy >= 0 && cy < rows) paint(cy * cols + cx, g.tone);
      }
      small.getContext("2d")!.putImageData(image, 0, 0);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(small, 0, 0, canvas.width, canvas.height);
    };

    const tick = (now: number) => {
      frame = 0;
      if (!cols) return;
      let busy = false;
      if (!reduced) {
        if (pointer.inside && dig()) lastDig = now;
        const healing = now - lastDig > HEAL_DELAY;
        if (healing && pour()) busy = true;
        stepFlying();
        for (let pass = 0; pass < 2; pass++) if (stepLoose(healing)) busy = true;
        if (flying.length) busy = true;
      }
      render();
      if (busy || pointer.inside) schedule();
    };
    const schedule = () => { if (!frame && !cancelled) frame = requestAnimationFrame(tick); };

    const local = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: (event.clientX - rect.left) / cell, y: (event.clientY - rect.top) / cell };
    };
    const onMove = (event: PointerEvent) => {
      const at = local(event);
      if (!pointer.inside) { pointer.px = at.x; pointer.py = at.y; }
      pointer.x = at.x; pointer.y = at.y; pointer.inside = true;
      schedule();
    };
    const onLeave = () => { pointer.inside = false; schedule(); };
    const onUp = (event: PointerEvent) => { if (event.pointerType !== "mouse") onLeave(); };

    engine.current = { setText };
    let fontsDone = false;
    resize();
    setText(current);
    document.fonts?.ready.then(() => {
      if (cancelled || fontsDone) return;
      fontsDone = true;
      rasterize(current);
      for (let i = 0; i < state.length; i++) if (state[i] === FIXED && !target[i]) { state[i] = LOOSE; rest[i] = 0; }
      schedule();
    });
    const sizeObserver = new ResizeObserver(resize);
    sizeObserver.observe(root);
    const theme = new MutationObserver(() => { buildShades(); schedule(); });
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-accent", "class", "style"] });
    root.addEventListener("pointermove", onMove);
    root.addEventListener("pointerleave", onLeave);
    root.addEventListener("pointerup", onUp);
    root.addEventListener("pointercancel", onLeave);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      engine.current = null;
      sizeObserver.disconnect(); theme.disconnect();
      root.removeEventListener("pointermove", onMove);
      root.removeEventListener("pointerleave", onLeave);
      root.removeEventListener("pointerup", onUp);
      root.removeEventListener("pointercancel", onLeave);
    };
  }, [grain, paletteKey, reduced]);

  useEffect(() => { engine.current?.setText(text); }, [text, grain, paletteKey, reduced]);

  return <div ref={rootRef} className={[styles.root, className].filter(Boolean).join(" ")} style={style}>
    <Tag className={styles.srOnly}>{text}</Tag>
    <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />
  </div>;
}
