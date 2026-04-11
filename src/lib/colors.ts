import type { AnchorIntent } from '../types';

/** Intent → color mapping (🔵 main / 🟢 new branch / 🟣 existing branch) */
export const INTENT_COLORS: Record<AnchorIntent, string> = {
  main: '#60a5fa',           // blue-400
  'new-branch': '#34d399',   // emerald-400
  'existing-branch': '#a78bfa', // violet-400
};

export function colorForIntent(intent: AnchorIntent): string {
  return INTENT_COLORS[intent];
}
