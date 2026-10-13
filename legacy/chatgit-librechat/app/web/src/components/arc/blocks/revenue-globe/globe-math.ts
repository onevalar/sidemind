import { clamp } from "../../lib/clamp";

export type Vec = [number, number, number];

export const DEG = Math.PI / 180;
export { clamp } from "../../lib/clamp";
export const smoothstep = (edge0: number, edge1: number, value: number) => {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Unit vector for a latitude and longitude in degrees. x points to 90°E, y to the north pole, z to 0°, 0°. */
export function toVec(lat: number, lon: number): Vec {
  const phi = lat * DEG, lambda = lon * DEG;
  return [Math.cos(phi) * Math.sin(lambda), Math.sin(phi), Math.cos(phi) * Math.cos(lambda)];
}

export const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function normalize(v: Vec): Vec {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}

/** Spherical interpolation between two unit vectors along their great circle. */
export function slerp(a: Vec, b: Vec, t: number, omega = Math.acos(clamp(dot(a, b), -1, 1))): Vec {
  if (omega < 1e-5) return [a[0], a[1], a[2]];
  const s = Math.sin(omega);
  const wa = Math.sin((1 - t) * omega) / s, wb = Math.sin(t * omega) / s;
  return [a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb, a[2] * wa + b[2] * wb];
}

/** A cubic-bezier easing function, matching CSS and Motion's tuple format. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const slope = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 6; i++) {
      const error = sampleX(t) - x;
      if (Math.abs(error) < 1e-5) return sampleY(t);
      const d = slope(t);
      if (Math.abs(d) < 1e-6) break;
      t -= error / d;
    }
    let lo = 0, hi = 1;
    t = x;
    for (let i = 0; i < 24; i++) {
      const value = sampleX(t);
      if (Math.abs(value - x) < 1e-5) break;
      if (value < x) lo = t; else hi = t;
      t = (lo + hi) / 2;
    }
    return sampleY(t);
  };
}

/** Apple-style rubber band: resistance grows the further a value is pulled past its limit. */
export const rubberBand = (overshoot: number, dimension: number, constant = .55) =>
  (1 - 1 / ((Math.abs(overshoot) * constant) / dimension + 1)) * dimension * Math.sign(overshoot);

/** One semi-implicit Euler step of a damped spring, sub-stepped for stability. Returns [position, velocity]. */
export function springStep(x: number, v: number, target: number, stiffness: number, damping: number, dt: number): [number, number] {
  const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
  const h = dt / steps;
  for (let i = 0; i < steps; i++) {
    v += (-stiffness * (x - target) - damping * v) * h;
    x += v * h;
  }
  return [x, v];
}
