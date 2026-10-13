"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import type { CSSProperties, ReactNode } from "react";
import { useReducedMotion } from "motion/react";
import { motionTokens } from "../lib/motion-tokens";
import styles from "./dot-grid.module.css";

/**
 * A field of dots drawn on one canvas. The dots bulge away from the pointer like a magnifying lens, wobble back on a spring,
 * and a click sends a ripple rolling outward through the field. Put content inside it and it becomes a hero background:
 * the content stays interactive and the field reacts to the pointer anywhere over it.
 */
export interface DotGridProps {
  /** Distance between dots in px. Lower is denser. Defaults to 22. */
  gap?: number;
  /** Dot radius in px at rest. Defaults to 1.4. */
  dotSize?: number;
  /** Radius of the lens around the pointer in px. Defaults to 150. */
  radius?: number;
  /** How far dots are pushed at the rim of the lens in px. Defaults to 16. */
  strength?: number;
  /** Clicks and taps send a ripple through the field. Defaults to true. */
  ripple?: boolean;
  /** Fades the field toward its edges. Defaults to true. */
  fade?: boolean;
  /** Dot color at rest. Any CSS color; defaults to the border strong token. */
  color?: string;
  /** Color the dots take on under the lens and in a ripple. Defaults to the accent token. */
  activeColor?: string;
  /** Content drawn over the field, such as a hero headline. */
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

interface Ripple { x: number; y: number; start: number }

const RIPPLE_SPEED = 0.62; // px per ms
const RIPPLE_LIFE = 1500; // ms
const RIPPLE_WIDTH = 46;
const RIPPLE_PUSH = 11;
const STIFFNESS = 0.16;
const DAMPING = 0.74;
const MAX_RIPPLES = 6;

const subscribe = () => () => {};
function useReducedFlag() {
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);
  return !!useReducedMotion() && hydrated;
}

export function DotGrid({ gap = 22, dotSize = 1.4, radius = 150, strength = 16, ripple = true, fade = true, color, activeColor, children, className, style }: DotGridProps) {
  const reduced = useReducedFlag();
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const settings = useRef({ gap, dotSize, radius, strength, ripple, reduced });
  useEffect(() => { settings.current = { gap, dotSize, radius, strength, ripple, reduced }; });
  const built = useRef(false);

  useEffect(() => {
    const root = rootRef.current, canvas = canvasRef.current;
    if (!root || !canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    let width = 0, height = 0, dpr = 1;
    let count = 0;
    let restX = new Float32Array(0), restY = new Float32Array(0);
    let offX = new Float32Array(0), offY = new Float32Array(0), velX = new Float32Array(0), velY = new Float32Array(0);
    let heat = new Float32Array(0);
    let baseColor = "", hotColor = "";
    const ripples: Ripple[] = [];
    // Pointer target, the smoothed lens center that trails it, and how present the lens is (0 to 1).
    const pointer = { x: 0, y: 0, inside: false };
    const lens = { x: 0, y: 0, power: 0 };
    let frame = 0, last = 0, visible = true;

    const readColors = () => {
      const computed = getComputedStyle(root);
      baseColor = computed.getPropertyValue("--dot-grid-color").trim() || computed.color;
      hotColor = computed.getPropertyValue("--dot-grid-active").trim() || computed.color;
    };

    const build = () => {
      const rect = root.getBoundingClientRect();
      width = rect.width; height = rect.height;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
      const step = Math.max(6, settings.current.gap);
      const cols = Math.floor(width / step) + 1, rows = Math.floor(height / step) + 1;
      const startX = (width - (cols - 1) * step) / 2, startY = (height - (rows - 1) * step) / 2;
      count = cols * rows;
      restX = new Float32Array(count); restY = new Float32Array(count);
      offX = new Float32Array(count); offY = new Float32Array(count); velX = new Float32Array(count); velY = new Float32Array(count);
      heat = new Float32Array(count);
      let i = 0;
      for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
        restX[i] = startX + col * step; restY[i] = startY + row * step; i++;
      }
      draw();
    };

    const draw = () => {
      const { dotSize: size } = settings.current;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
      context.fillStyle = baseColor;
      context.beginPath();
      for (let i = 0; i < count; i++) {
        if (heat[i] > .04) continue;
        const x = restX[i] + offX[i], y = restY[i] + offY[i];
        context.moveTo(x + size, y);
        context.arc(x, y, size, 0, Math.PI * 2);
      }
      context.fill();
      // Hot dots grow and take the active color; they are few, so each is drawn on its own.
      context.fillStyle = hotColor;
      for (let i = 0; i < count; i++) {
        const h = heat[i];
        if (h <= .04) continue;
        const x = restX[i] + offX[i], y = restY[i] + offY[i];
        const r = size * (1 + h * 1.1);
        context.globalAlpha = .35 + h * .65;
        context.beginPath();
        context.arc(x, y, r, 0, Math.PI * 2);
        context.fill();
        context.globalAlpha = 1;
        // A faint base dot underneath keeps the grid legible while the color fades in.
        if (h < .5) {
          context.fillStyle = baseColor;
          context.globalAlpha = 1 - h * 2;
          context.beginPath();
          context.arc(x, y, size, 0, Math.PI * 2);
          context.fill();
          context.globalAlpha = 1;
          context.fillStyle = hotColor;
        }
      }
    };

    const tick = (now: number) => {
      frame = 0;
      const dt = Math.min(2.5, last ? (now - last) / (1000 / 60) : 1);
      last = now;
      const { radius: R, strength: S, reduced: still } = settings.current;

      // The lens trails the pointer a little and fades in and out instead of popping.
      const follow = 1 - Math.pow(1 - .28, dt);
      lens.x += (pointer.x - lens.x) * follow;
      lens.y += (pointer.y - lens.y) * follow;
      const targetPower = pointer.inside ? 1 : 0;
      lens.power += (targetPower - lens.power) * (1 - Math.pow(1 - .12, dt));
      if (Math.abs(targetPower - lens.power) < .002) lens.power = targetPower;

      for (let r = ripples.length - 1; r >= 0; r--) if (now - ripples[r].start > RIPPLE_LIFE) ripples.splice(r, 1);

      let moving = lens.power > 0 && lens.power < 1;
      const k = STIFFNESS * dt, damp = Math.pow(DAMPING, dt);
      for (let i = 0; i < count; i++) {
        const x = restX[i], y = restY[i];
        let tx = 0, ty = 0, h = 0;
        if (lens.power > 0) {
          const dx = x - lens.x, dy = y - lens.y;
          const d = Math.hypot(dx, dy);
          if (d < R && d > .001) {
            const t = d / R;
            // Peaks a third of the way out and eases to nothing at the rim, like glass bending the field.
            const bulge = 6.75 * t * (1 - t) * (1 - t);
            const push = S * bulge * lens.power;
            tx += dx / d * push; ty += dy / d * push;
            h = Math.max(h, (1 - t) * (1 - t) * lens.power);
          }
        }
        for (let r = 0; r < ripples.length; r++) {
          const wave = ripples[r];
          const age = now - wave.start;
          const front = age * RIPPLE_SPEED;
          const dx = x - wave.x, dy = y - wave.y;
          const d = Math.hypot(dx, dy);
          const band = (d - front) / RIPPLE_WIDTH;
          if (band < -2.2 || band > 2.2 || d < .001) continue;
          const life = 1 - age / RIPPLE_LIFE;
          const amount = Math.exp(-band * band) * life * life;
          tx += dx / d * RIPPLE_PUSH * amount; ty += dy / d * RIPPLE_PUSH * amount;
          h = Math.max(h, amount * .9);
        }
        if (still) {
          offX[i] = 0; offY[i] = 0; velX[i] = 0; velY[i] = 0;
        } else {
          velX[i] = (velX[i] + (tx - offX[i]) * k) * damp;
          velY[i] = (velY[i] + (ty - offY[i]) * k) * damp;
          offX[i] += velX[i] * dt; offY[i] += velY[i] * dt;
          if (!moving && (Math.abs(velX[i]) > .01 || Math.abs(velY[i]) > .01 || Math.abs(tx - offX[i]) > .05 || Math.abs(ty - offY[i]) > .05)) moving = true;
        }
        heat[i] += (h - heat[i]) * (1 - Math.pow(1 - .25, dt));
        if (!moving && Math.abs(h - heat[i]) > .01) moving = true;
      }
      draw();
      if (ripples.length || moving || pointer.inside) schedule();
      else last = 0;
    };

    const schedule = () => { if (!frame && visible) frame = requestAnimationFrame(tick); };

    const local = (event: PointerEvent) => {
      const rect = root.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const onMove = (event: PointerEvent) => {
      const { x, y } = local(event);
      if (!pointer.inside) { lens.x = x; lens.y = y; }
      pointer.x = x; pointer.y = y; pointer.inside = true;
      schedule();
    };
    const onLeave = () => { pointer.inside = false; schedule(); };
    const onDown = (event: PointerEvent) => {
      if (!settings.current.ripple || settings.current.reduced || event.button > 0) return;
      const { x, y } = local(event);
      ripples.push({ x, y, start: performance.now() });
      if (ripples.length > MAX_RIPPLES) ripples.shift();
      // Touch has no hover, so the lens only lives while a finger is down.
      if (event.pointerType !== "mouse") { pointer.x = x; pointer.y = y; lens.x = x; lens.y = y; }
      schedule();
    };
    const onUp = (event: PointerEvent) => { if (event.pointerType !== "mouse") onLeave(); };

    readColors();
    build();
    // A new spacing or dot size redraws the whole field; the new grid fades up in place instead of snapping over the old one.
    if (built.current && !settings.current.reduced) canvas.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: motionTokens.duration.standard * 1000, easing: `cubic-bezier(${motionTokens.ease.standard.join(",")})` });
    built.current = true;
    const resize = new ResizeObserver(() => build());
    resize.observe(root);
    const theme = new MutationObserver(() => { readColors(); draw(); });
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-accent", "class", "style"] });
    const view = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; if (visible) schedule(); });
    view.observe(root);
    root.addEventListener("pointermove", onMove);
    root.addEventListener("pointerleave", onLeave);
    root.addEventListener("pointerdown", onDown);
    root.addEventListener("pointerup", onUp);
    root.addEventListener("pointercancel", onLeave);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect(); theme.disconnect(); view.disconnect();
      root.removeEventListener("pointermove", onMove);
      root.removeEventListener("pointerleave", onLeave);
      root.removeEventListener("pointerdown", onDown);
      root.removeEventListener("pointerup", onUp);
      root.removeEventListener("pointercancel", onLeave);
    };
  }, [gap, dotSize, color, activeColor]);

  const vars = { ...(color ? { "--dot-grid-color": color } : null), ...(activeColor ? { "--dot-grid-active": activeColor } : null), ...style } as CSSProperties;
  return <div ref={rootRef} className={[styles.root, className].filter(Boolean).join(" ")} style={vars} data-fade={fade || undefined}>
    <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />
    {children != null && <div className={styles.content}>{children}</div>}
  </div>;
}
