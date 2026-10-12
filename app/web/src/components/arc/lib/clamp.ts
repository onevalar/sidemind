/** Keeps `value` within `min` and `max`. One shared copy for every Arc item that clamps numbers. */
export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
