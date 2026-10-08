import type { AnchorIntent } from '../types';

/** Intent → color mapping (🔵 main / 🟢 new branch / 🟣 existing branch) */
export const INTENT_COLORS: Record<AnchorIntent, string> = {
  main: '#3B63B8',           // blue-400
  'new-branch': '#408368',   // emerald-400
  'existing-branch': '#8163A8', // violet-400
};

export function colorForIntent(intent: AnchorIntent): string {
  return INTENT_COLORS[intent];
}
