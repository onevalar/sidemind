"use client";

import { Children, useEffect, useRef, useSyncExternalStore } from "react";
import type { CSSProperties, ReactNode } from "react";
import { useReducedMotion } from "motion/react";
import styles from "./gravity-well.module.css";

/**
 * A grid of tiles that bends toward the pointer like spacetime around a mass. Tiles near the well lean in, shrink and
 * dim as if pulled into depth, each on its own spring, so a fast pointer leaves a jelly wake behind it. A click drops a
 * shockwave that rolls outward through the grid and rings every tile it passes in the accent. Arrow keys move the well from tile to
 * tile and Enter or Space sends a wave.
 */
export interface GravityWellProps {
  /** One tile per child. Any content works: photos, avatars, icons. */
  children: ReactNode;
  /** Fixed column count. Leave it out to fit as many columns as `minTileSize` allows. */
  columns?: number;
  /** Smallest tile width in px when `columns` is not set. Defaults to 56. */
  minTileSize?: number;
  /** Gap between tiles in px. Defaults to 8. */
  gap?: number;
  /** Reach of the well in px. Defaults to 150. */
  radius?: number;
  /** Pull strength from 0 to about 1.5. Defaults to 1. */
  strength?: number;
  /** Called when a click or key sends a shockwave, with its origin in px from the top left of the grid. */
  onPulse?: (origin: { x: number; y: number }) => void;
  /** Accessible name for the grid. Defaults to "Gravity well". */
  label?: string;
  className?: string;
  style?: CSSProperties;
}

const subscribe = () => () => {};
function useReducedFlag() {
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);
  return !!useReducedMotion() && hydrated;
}

const WAVE_SPEED = 900;
const TILE_K = 190, TILE_C = 15;
const MASS_K = 320, MASS_C = 2 * Math.sqrt(MASS_K);

interface Wave { x: number; y: number; start: number; hit: Uint8Array }

export function GravityWell({ children, columns, minTileSize = 56, gap = 8, radius = 150, strength = 1, onPulse, label = "Gravity well", className, style }: GravityWellProps) {
  const reduced = useReducedFlag();
  const rootRef = useRef<HTMLDivElement>(null);
  const tileRefs = useRef<(HTMLDivElement | null)[]>([]);
  const live = useRef({ radius, strength, onPulse });
  useEffect(() => { live.current = { radius, strength, onPulse }; });
  const items = Children.toArray(children);
  const count = items.length;

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const tiles = tileRefs.current.slice(0, count).filter((tile): tile is HTMLDivElement => !!tile);
    const n = tiles.length;
    const rx = new Float32Array(n), ry = new Float32Array(n);
    const dx = new Float32Array(n), dy = new Float32Array(n), vx = new Float32Array(n), vy = new Float32Array(n);
    const sc = new Float32Array(n).fill(1), vs = new Float32Array(n);
    // How brightly each tile rings in the accent after a shockwave passes it.
    const glow = new Float32Array(n);
    let waves: Wave[] = [];
    let frame = 0, last = 0, cancelled = false;
    const mass = { x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0, presence: 0, target: 0, placed: false };
    let keyIndex = Math.floor(n / 2);

    const measure = () => {
      for (let i = 0; i < n; i++) {
        const tile = tiles[i];
        rx[i] = tile.offsetLeft + tile.offsetWidth / 2;
        ry[i] = tile.offsetTop + tile.offsetHeight / 2;
      }
    };

    const schedule = () => { if (!frame && !cancelled) frame = requestAnimationFrame(tick); };

    const tick = (now: number) => {
      frame = 0;
      const dt = Math.min(1 / 30, last ? (now - last) / 1000 : 1 / 60);
      last = now;
      const { radius: reach, strength: pull } = live.current;
      const sigma2 = reach * reach;

      // The well itself rides a critically damped spring, so a quick flick of the pointer drags a wake.
      mass.vx += ((mass.tx - mass.x) * MASS_K - mass.vx * MASS_C) * dt;
      mass.vy += ((mass.ty - mass.y) * MASS_K - mass.vy * MASS_C) * dt;
      mass.x += mass.vx * dt; mass.y += mass.vy * dt;
      mass.presence += (mass.target - mass.presence) * (1 - Math.exp(-dt * 7));
      if (Math.abs(mass.target - mass.presence) < .002) mass.presence = mass.target;

      let busy = mass.presence !== mass.target || Math.hypot(mass.tx - mass.x, mass.ty - mass.y) > .1;
      waves = waves.filter(wave => (now - wave.start) / 1000 * WAVE_SPEED < reach * 12);
      if (waves.length) busy = true;

      for (let i = 0; i < n; i++) {
        const ox = mass.x - rx[i], oy = mass.y - ry[i];
        const r2 = ox * ox + oy * oy;
        // Reduced motion keeps the shockwave ring as feedback but drops the pull, the travel and the depth.
        const field = reduced ? 0 : Math.exp(-r2 / (2 * sigma2)) * mass.presence * pull;
        const depth = reduced ? 0 : Math.exp(-r2 / sigma2) * mass.presence * Math.min(1.2, pull);
        const tx = ox * .36 * field, ty = oy * .36 * field;
        const ts = 1 - .46 * depth;

        for (const wave of waves) {
          if (wave.hit[i]) continue;
          const wx = rx[i] - wave.x, wy = ry[i] - wave.y;
          const d = Math.hypot(wx, wy) || 1;
          if (!reduced && (now - wave.start) / 1000 * WAVE_SPEED < d) continue;
          wave.hit[i] = 1;
          const falloff = Math.exp(-d / (reach * 3.2));
          if (!reduced) {
            const kick = 720 * falloff;
            vx[i] += wx / d * kick; vy[i] += wy / d * kick;
            vs[i] -= 3.2 * falloff;
          }
          glow[i] = Math.max(glow[i], Math.min(1, falloff * 1.4));
        }

        vx[i] += ((tx - dx[i]) * TILE_K - vx[i] * TILE_C) * dt;
        vy[i] += ((ty - dy[i]) * TILE_K - vy[i] * TILE_C) * dt;
        vs[i] += ((ts - sc[i]) * TILE_K - vs[i] * TILE_C) * dt;
        dx[i] += vx[i] * dt; dy[i] += vy[i] * dt; sc[i] += vs[i] * dt;
        if (Math.abs(vx[i]) + Math.abs(vy[i]) > .02 || Math.abs(tx - dx[i]) + Math.abs(ty - dy[i]) > .02 || Math.abs(vs[i]) > .001 || Math.abs(ts - sc[i]) > .0005) busy = true;
        tiles[i].style.transform = `translate3d(${dx[i].toFixed(2)}px, ${dy[i].toFixed(2)}px, 0) scale(${sc[i].toFixed(4)})`;
        tiles[i].style.opacity = (1 - .38 * depth).toFixed(3);
        // Tiles deeper in the well slide under their neighbours.
        tiles[i].style.zIndex = String(10 - Math.round(depth * 9));
        if (glow[i] > 0) {
          glow[i] = glow[i] < .01 ? 0 : glow[i] * Math.exp(-dt * 5);
          tiles[i].style.setProperty("--gravity-well-ring", glow[i].toFixed(3));
          if (glow[i]) busy = true;
        }
      }
      if (busy) schedule();
      else last = 0;
    };

    const local = (event: PointerEvent) => {
      const rect = root.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const place = (x: number, y: number, jump: boolean) => {
      mass.tx = x; mass.ty = y;
      if (jump || !mass.placed) { mass.x = x; mass.y = y; mass.vx = 0; mass.vy = 0; mass.placed = true; }
    };
    const pulse = (x: number, y: number) => {
      waves.push({ x, y, start: performance.now(), hit: new Uint8Array(n) });
      if (waves.length > 4) waves.shift();
      live.current.onPulse?.({ x, y });
      schedule();
    };
    const onMove = (event: PointerEvent) => {
      const at = local(event);
      place(at.x, at.y, mass.presence < .02);
      mass.target = 1;
      schedule();
    };
    const onLeave = () => { mass.target = 0; schedule(); };
    const onDown = (event: PointerEvent) => {
      const at = local(event);
      place(at.x, at.y, mass.presence < .02);
      mass.target = 1;
      pulse(at.x, at.y);
    };
    const onUp = (event: PointerEvent) => { if (event.pointerType !== "mouse") onLeave(); };
    const focusTile = (index: number) => {
      keyIndex = Math.max(0, Math.min(n - 1, index));
      place(rx[keyIndex], ry[keyIndex], mass.presence < .02);
      mass.target = 1;
      schedule();
    };
    const perRow = () => {
      let row = 0;
      while (row < n && ry[row] === ry[0]) row++;
      return Math.max(1, row);
    };
    const onKey = (event: KeyboardEvent) => {
      const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -perRow(), ArrowDown: perRow(), Home: -n, End: n }[event.key];
      if (step !== undefined) { event.preventDefault(); focusTile(keyIndex + step); return; }
      if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        if (mass.presence < .02) focusTile(keyIndex);
        pulse(rx[keyIndex], ry[keyIndex]);
      }
    };
    const onFocus = (event: FocusEvent) => { if (event.target === root && root.matches(":focus-visible")) focusTile(keyIndex); };
    const onBlur = () => { mass.target = 0; schedule(); };

    measure();
    const sizeObserver = new ResizeObserver(() => { measure(); schedule(); });
    sizeObserver.observe(root);
    root.addEventListener("pointermove", onMove);
    root.addEventListener("pointerleave", onLeave);
    root.addEventListener("pointerdown", onDown);
    root.addEventListener("pointerup", onUp);
    root.addEventListener("pointercancel", onLeave);
    root.addEventListener("keydown", onKey);
    root.addEventListener("focus", onFocus);
    root.addEventListener("blur", onBlur);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      sizeObserver.disconnect();
      root.removeEventListener("pointermove", onMove);
      root.removeEventListener("pointerleave", onLeave);
      root.removeEventListener("pointerdown", onDown);
      root.removeEventListener("pointerup", onUp);
      root.removeEventListener("pointercancel", onLeave);
      root.removeEventListener("keydown", onKey);
      root.removeEventListener("focus", onFocus);
      root.removeEventListener("blur", onBlur);
      for (const tile of tiles) { tile.style.transform = ""; tile.style.opacity = ""; tile.style.zIndex = ""; tile.style.removeProperty("--gravity-well-ring"); }
    };
  }, [count, reduced]);

  const layout = { "--gravity-well-min": `${minTileSize}px`, gap, ...(columns ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } : {}) } as CSSProperties;
  return <div ref={rootRef} className={[styles.root, className].filter(Boolean).join(" ")} style={{ ...layout, ...style }}
    role="group" aria-label={label} aria-roledescription="gravity well" tabIndex={0}>
    {items.map((child, i) => <div key={i} ref={node => { tileRefs.current[i] = node; }} className={styles.tile}>{child}</div>)}
  </div>;
}
