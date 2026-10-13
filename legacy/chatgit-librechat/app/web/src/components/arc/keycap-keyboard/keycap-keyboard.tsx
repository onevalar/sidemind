"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { ArrowBigUp, CornerDownLeft, Delete } from "lucide-react";
import styles from "./keycap-keyboard.module.css";

/** A named wide key, or any single character. */
export type KeycapName = "space" | "backspace" | "enter" | "shift" | "tab" | "caps";
export type KeycapKey = string;
export type KeycapLayout = "compact" | "letters";

/**
 * A board of sculpted mechanical keycaps. Type on your own keyboard or press the caps: each one travels down into its
 * housing, a faint light blooms under it, and it snaps back up. The text you type appears above the board, wraps, and keeps
 * the newest line in view. Presses never re-render the caps; they flip one data attribute on one element.
 */
export interface KeycapKeyboardProps {
  /** Controlled text. */
  value?: string;
  /** Initial text when uncontrolled. */
  defaultValue?: string;
  /** Called with the new text after every key. */
  onValueChange?: (value: string) => void;
  /** Built-in layout. "compact" is a full 60% board with numbers and modifiers; "letters" is three letter rows and a space bar. */
  layout?: KeycapLayout;
  /** Custom rows. Single characters, or "space", "backspace", "enter", "shift", "tab", and "caps". Overrides layout. */
  rows?: KeycapKey[][];
  /** Longest text kept. Older characters drop off the start. */
  maxLength?: number;
  /**
   * Where physical keys are heard. "focus" listens while focus is inside the board. "window" listens anywhere on the page,
   * except inside other text fields, and never swallows shortcuts with Command, Control, or Alt.
   */
  listen?: "focus" | "window";
  /** Shown while the text is empty. */
  placeholder?: string;
  /** Hides the typed text area, for when you render the value yourself. */
  showOutput?: boolean;
  /** Accessible name for the board. */
  label?: string;
  className?: string;
  style?: CSSProperties;
}

interface KeyDef {
  /** Stable id. Physical keys match on KeyboardEvent.code. */
  code: string;
  /** Codes that light this cap too, such as the right shift. */
  also?: string[];
  legend: ReactNode;
  name: string;
  /** Character inserted, and its shifted form. */
  value?: string;
  shifted?: string;
  action?: "backspace" | "shift";
  units: number;
  /** Modifier legends sit in the corner, like on a real board. */
  corner?: boolean;
  /** An accent colored cap, like the one colored key on a custom board. */
  accent?: boolean;
}

const SHIFTED: Record<string, string> = { "`": "~", "1": "!", "2": "@", "3": "#", "4": "$", "5": "%", "6": "^", "7": "&", "8": "*", "9": "(", "0": ")", "-": "_", "=": "+", "[": "{", "]": "}", "\\": "|", ";": ":", "'": "\"", ",": "<", ".": ">", "/": "?" };
const PUNCT_CODES: Record<string, string> = { "`": "Backquote", "-": "Minus", "=": "Equal", "[": "BracketLeft", "]": "BracketRight", "\\": "Backslash", ";": "Semicolon", "'": "Quote", ",": "Comma", ".": "Period", "/": "Slash" };
const ICON = { size: 15, strokeWidth: 1.75, "aria-hidden": true } as const;

function charKey(char: string, units = 1): KeyDef {
  const lower = char.toLowerCase();
  const code = /[a-z]/.test(lower) ? `Key${lower.toUpperCase()}` : /\d/.test(char) ? `Digit${char}` : PUNCT_CODES[char] ?? `Char${char.charCodeAt(0)}`;
  const shifted = /[a-z]/.test(lower) ? lower.toUpperCase() : SHIFTED[char];
  return { code, legend: lower, name: lower, value: lower, shifted, units };
}

function namedKey(name: string, units?: number): KeyDef {
  switch (name) {
    case "space": return { code: "Space", legend: null, name: "Space", value: " ", units: units ?? 5 };
    case "backspace": return { code: "Backspace", legend: <Delete {...ICON} />, name: "Delete", action: "backspace", units: units ?? 1.6, corner: true };
    case "enter": return { code: "Enter", legend: <CornerDownLeft {...ICON} />, name: "Return", value: "\n", units: units ?? 2.25, corner: true, accent: true };
    case "shift": return { code: "ShiftLeft", also: ["ShiftRight"], legend: <ArrowBigUp {...ICON} />, name: "Shift", action: "shift", units: units ?? 2.25, corner: true };
    case "tab": return { code: "Tab", legend: "tab", name: "Tab", units: units ?? 1.5, corner: true };
    case "caps": return { code: "CapsLock", legend: "caps", name: "Caps lock", units: units ?? 1.75, corner: true };
    default: return charKey(name);
  }
}

function toDefs(rows: KeycapKey[][]) {
  return rows.map(row => row.map(key => key.length === 1 ? charKey(key) : namedKey(key)));
}

const LETTERS: KeyDef[][] = toDefs([
  ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
  ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
  ["shift", "z", "x", "c", "v", "b", "n", "m", "backspace"],
  ["space"],
]).map((row, r) => r === 2 ? row.map(key => key.action ? { ...key, units: 1.5 } : key) : r === 3 ? row.map(key => ({ ...key, units: 6, accent: true })) : row);

const COMPACT: KeyDef[][] = [
  [..."`1234567890-=".split("").map(c => charKey(c)), namedKey("backspace", 2)],
  [namedKey("tab", 1.5), ..."qwertyuiop[]".split("").map(c => charKey(c)), charKey("\\", 1.5)],
  [namedKey("caps", 1.75), ..."asdfghjkl;'".split("").map(c => charKey(c)), namedKey("enter", 2.25)],
  [{ ...namedKey("shift", 2.25), also: [] }, ..."zxcvbnm,./".split("").map(c => charKey(c)), { ...namedKey("shift", 2.75), code: "ShiftRight", also: [] }],
  [
    { code: "ControlLeft", legend: "ctrl", name: "Control", units: 1.25, corner: true },
    { code: "AltLeft", legend: "opt", name: "Option", units: 1.25, corner: true },
    { code: "MetaLeft", legend: "cmd", name: "Command", units: 1.5, corner: true },
    { ...namedKey("space"), units: 7 },
    { code: "MetaRight", legend: "cmd", name: "Command", units: 1.5, corner: true },
    { code: "AltRight", legend: "opt", name: "Option", units: 1.25, corner: true },
    { code: "ControlRight", legend: "ctrl", name: "Control", units: 1.25, corner: true },
  ],
];

/** Toggles a boolean data attribute straight on the element, outside React. */
function setFlag(node: HTMLElement | undefined, name: string, on: boolean) {
  if (!node) return;
  if (on) node.setAttribute(name, ""); else node.removeAttribute(name);
}

/** Reads a CSS time such as "580ms" or ".58s" in milliseconds. */
function toMs(value: string, fallback: number) {
  const n = parseFloat(value);
  if (!Number.isFinite(n)) return fallback;
  return /ms\s*$/.test(value) ? n : n * 1000;
}

function isEditable(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName);
}

interface CapProps {
  def: KeyDef;
  register: (code: string, node: HTMLButtonElement | null) => void;
  onDown: (def: KeyDef, event: ReactPointerEvent<HTMLButtonElement>) => void;
  onUp: (def: KeyDef) => void;
  onActivate: (def: KeyDef, event: ReactMouseEvent<HTMLButtonElement>) => void;
}

/** One keycap. Memoized with stable props, so typing never re-renders it; press state lives in a data attribute. */
const Cap = memo(function Cap({ def, register, onDown, onUp, onActivate }: CapProps) {
  return <button
    ref={node => register(def.code, node)}
    type="button"
    className={styles.key}
    style={{ "--w": def.units } as CSSProperties}
    data-keycap=""
    data-corner={def.corner ? "" : undefined}
    data-accent={def.accent ? "" : undefined}
    aria-label={def.name}
    onPointerDown={event => onDown(def, event)}
    onPointerUp={() => onUp(def)}
    onPointerCancel={() => onUp(def)}
    onLostPointerCapture={() => onUp(def)}
    onClick={event => onActivate(def, event)}
  >
    <span className={styles.glow} aria-hidden="true" />
    <span className={styles.housing} aria-hidden="true" />
    <span className={styles.cap} aria-hidden="true">
      <span className={styles.face}><span className={styles.legend}>{def.legend}</span></span>
    </span>
  </button>;
});

export function KeycapKeyboard({
  value,
  defaultValue = "",
  onValueChange,
  layout = "compact",
  rows,
  maxLength = 280,
  listen = "focus",
  placeholder = "Start typing",
  showOutput = true,
  label = "Keyboard",
  className,
  style,
}: KeycapKeyboardProps) {
  const [inner, setInner] = useState(defaultValue);
  const text = value ?? inner;
  const root = useRef<HTMLDivElement>(null);
  const output = useRef<HTMLDivElement>(null);
  const caps = useRef(new Map<string, HTMLButtonElement>());
  const latest = useRef({ text, controlled: value !== undefined, onValueChange, maxLength });
  const shiftLatched = useRef(false);
  const idle = useRef(0);
  useEffect(() => { latest.current = { text, controlled: value !== undefined, onValueChange, maxLength }; });

  // Keyed by content, so an inline rows array from a re-rendering parent never rebuilds (and re-renders) the caps.
  const rowsKey = rows ? JSON.stringify(rows) : "";
  const board = useMemo(() => rowsKey ? toDefs(JSON.parse(rowsKey) as KeycapKey[][]) : layout === "letters" ? LETTERS : COMPACT, [rowsKey, layout]);
  const units = useMemo(() => Math.max(...board.map(row => row.reduce((sum, key) => sum + key.units, 0))), [board]);
  /** Physical code to cap: each cap by its own code, plus codes that light it too. */
  const byCode = useMemo(() => {
    const map = new Map<string, KeyDef>();
    for (const def of board.flat()) { map.set(def.code, def); def.also?.forEach(code => { if (!map.has(code)) map.set(code, def); }); }
    return map;
  }, [board]);

  const register = useCallback((code: string, node: HTMLButtonElement | null) => {
    if (node) caps.current.set(code, node); else caps.current.delete(code);
  }, []);

  /** Press state is a data attribute on one element: no React render, no layout read. */
  const light = useCallback((code: string, down: boolean) => {
    setFlag(caps.current.get(code), "data-pressed", down);
  }, []);

  const setLatch = useCallback((on: boolean) => {
    shiftLatched.current = on;
    for (const code of ["ShiftLeft", "ShiftRight"]) setFlag(caps.current.get(code), "data-latched", on);
  }, []);

  const commit = useCallback((next: string) => {
    const { controlled, onValueChange: notify, maxLength: max } = latest.current;
    const chars = Array.from(next);
    const clipped = chars.length > max ? chars.slice(chars.length - max).join("") : next;
    latest.current.text = clipped;
    if (!controlled) setInner(clipped);
    notify?.(clipped);
    // The caret holds still while typing and blinks again once idle.
    const node = output.current;
    if (node) {
      node.dataset.typing = "";
      window.clearTimeout(idle.current);
      idle.current = window.setTimeout(() => { delete node.dataset.typing; }, 600);
    }
  }, []);

  const insert = useCallback((chars: string) => commit(latest.current.text + chars), [commit]);
  const erase = useCallback(() => commit(Array.from(latest.current.text).slice(0, -1).join("")), [commit]);

  /** A virtual press from a cap: shift latches for the next character, like a sticky key. */
  const activate = useCallback((def: KeyDef) => {
    if (def.action === "shift") { setLatch(!shiftLatched.current); return; }
    if (def.action === "backspace") { erase(); return; }
    if (def.value === undefined) return;
    const shifted = shiftLatched.current && def.shifted ? def.shifted : def.value;
    if (shiftLatched.current) setLatch(false);
    insert(shifted);
  }, [erase, insert, setLatch]);

  const onDown = useCallback((def: KeyDef, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    light(def.code, true);
    activate(def);
  }, [light, activate]);
  const onUp = useCallback((def: KeyDef) => light(def.code, false), [light]);
  const onActivate = useCallback((def: KeyDef, event: ReactMouseEvent<HTMLButtonElement>) => {
    // Pointer clicks already acted on pointerdown; this handles Enter and Space on a focused cap.
    if (event.detail !== 0) return;
    light(def.code, true);
    activate(def);
    window.setTimeout(() => light(def.code, false), 90);
  }, [light, activate]);

  // One native listener pair: on the window, or on the board itself in focus mode.
  useEffect(() => {
    const node = root.current;
    const target: HTMLElement | Window | null = listen === "window" ? window : node;
    if (!target || !node) return;
    const down = (event: Event) => {
      const e = event as KeyboardEvent;
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const inside = node.contains(e.target as Node);
      if (!inside && isEditable(e.target)) return;
      // A focused cap answers Enter and Space as a button.
      if (inside && e.target instanceof HTMLElement && e.target.dataset.keycap !== undefined && (e.key === "Enter" || e.key === " ")) return;
      const def = byCode.get(e.code);
      if (def && !e.repeat) light(def.code, true);
      if (e.key === "Backspace") { e.preventDefault(); erase(); return; }
      if (e.key === "Enter") { e.preventDefault(); insert("\n"); return; }
      if (e.key.length === 1) { e.preventDefault(); if (shiftLatched.current) setLatch(false); insert(e.key); }
    };
    const up = (event: Event) => {
      const def = byCode.get((event as KeyboardEvent).code);
      if (def) light(def.code, false);
    };
    const release = () => { for (const code of caps.current.keys()) light(code, false); };
    target.addEventListener("keydown", down);
    target.addEventListener("keyup", up);
    window.addEventListener("blur", release);
    if (listen === "focus") node.addEventListener("focusout", release);
    return () => {
      target.removeEventListener("keydown", down);
      target.removeEventListener("keyup", up);
      window.removeEventListener("blur", release);
      node.removeEventListener("focusout", release);
    };
  }, [listen, byCode, light, erase, insert, setLatch]);

  useEffect(() => () => window.clearTimeout(idle.current), []);

  // Switching boards morphs the plate from its old size to the new one while the new rows fade in, instead of snapping.
  const plate = useRef<HTMLDivElement>(null);
  const plateSize = useRef<{ w: number; h: number } | null>(null);
  const morph = useRef<Animation[]>([]);
  useEffect(() => {
    const node = plate.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => { plateSize.current = { w: node.offsetWidth, h: node.offsetHeight }; });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const node = plate.current;
    const from = plateSize.current;
    if (!node || !from || typeof node.animate !== "function") return;
    morph.current.forEach(animation => animation.cancel());
    morph.current = [];
    delete node.dataset.morphing;
    const to = { w: node.offsetWidth, h: node.offsetHeight };
    plateSize.current = to;
    if ((from.w === to.w && from.h === to.h) || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const css = getComputedStyle(node);
    const easing = css.getPropertyValue("--ease-spring").trim() || "cubic-bezier(.22, 1, .36, 1)";
    const duration = toMs(css.getPropertyValue("--duration-spring"), 580);
    const fade = toMs(css.getPropertyValue("--duration-standard"), 240);
    const size = node.animate([{ width: `${from.w}px`, height: `${from.h}px` }, { width: `${to.w}px`, height: `${to.h}px` }], { duration, easing });
    node.dataset.morphing = "";
    size.onfinish = size.oncancel = () => { if (morph.current[0] === size) delete node.dataset.morphing; };
    morph.current = [size, ...Array.from(node.children, row => row.animate([{ opacity: 0 }, { opacity: 1 }], { duration: fade, delay: 60, easing: "cubic-bezier(.22, 1, .36, 1)", fill: "backwards" }))];
  }, [board]);

  const chars = Array.from(text);

  return <div ref={root} className={[styles.root, className].filter(Boolean).join(" ")} style={{ ...style, "--units": units } as CSSProperties}>
    {showOutput && <div ref={output} className={styles.output} role="textbox" aria-readonly="true" aria-multiline="true" aria-label="Typed text" tabIndex={0}>
      <p className={styles.text}>
        {chars.map((char, i) => char === "\n" ? <br key={i} /> : <span key={i} className={styles.char}>{char}</span>)}
        <span className={styles.caret} aria-hidden="true" />
        {chars.length === 0 && <span className={styles.placeholder}>{placeholder}</span>}
      </p>
    </div>}
    <div ref={plate} className={styles.plate} role="group" aria-label={label}>
      {board.map((row, r) => <div key={r} className={styles.row}>
        {row.map(def => <Cap key={def.code} def={def} register={register} onDown={onDown} onUp={onUp} onActivate={onActivate} />)}
      </div>)}
    </div>
  </div>;
}

export default KeycapKeyboard;
