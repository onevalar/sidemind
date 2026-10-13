"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { useReducedMotion } from "motion/react";
import { Check, Pause, Play, RotateCcw, TriangleAlert, X } from "lucide-react";
import { CopyButton } from "../copy-button/copy-button";
import styles from "./typewriter-terminal.module.css";

export type TypewriterTerminalTone = "default" | "muted" | "success" | "warning" | "danger" | "accent";

/** One line printed after a command. A plain string prints as a default line, and an empty string prints a blank line. */
export type TypewriterTerminalOutput =
  | string
  | { kind?: "text"; text: string; tone?: TypewriterTerminalTone; /** Seconds to wait before the line prints. */ delay?: number }
  | { kind: "progress"; label: string; /** Seconds the bar takes to fill. */ duration?: number }
  | { kind: "task"; label: string; /** Muted text shown once the task finishes, such as 0.4s. */ done?: string; /** Seconds the spinner runs. */ duration?: number };

export interface TypewriterTerminalStep {
  /** The command typed at the prompt. */
  command: string;
  /** Lines the command prints, streamed in order. */
  output?: readonly TypewriterTerminalOutput[];
  /** Working directory shown in this prompt and every later one. */
  cwd?: string;
  /** Seconds to rest after the output before the next prompt. */
  pause?: number;
}

/**
 * A terminal that types a scripted CLI session with a human cadence, colors the shell syntax, and streams each command's
 * output: plain lines, progress bars, and spinners that resolve to a tick. A scrubber below the window rewinds and replays
 * the whole session, so the text untypes and retypes under your finger.
 */
export interface TypewriterTerminalProps {
  /** The session, in order. */
  steps?: readonly TypewriterTerminalStep[];
  /** Window title. */
  title?: string;
  /** Working directory shown in the prompt until a step sets its own cwd. */
  cwd?: string;
  /** Prompt symbol after the working directory. */
  symbol?: string;
  /** Multiplies the playback pace. At 1 the default session takes about fifteen seconds. */
  speed?: number;
  /** Holds playback where it is, easing to rest. */
  paused?: boolean;
  /** Clears the screen and plays again after a short rest. */
  loop?: boolean;
  /** Visible terminal rows. Older lines scroll up once the session outgrows them. */
  rows?: number;
  /** Shows the copy button that copies every command. */
  copyable?: boolean;
  /** Color of the caret, progress fills, links, and the scrubber. Defaults to the accent token. */
  accent?: string;
  /** Accessible name of the terminal. */
  label?: string;
  /** Optional visible caption under the terminal. */
  caption?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

type TokenKind = "program" | "flag" | "string" | "path" | "op" | "env" | "number" | "plain";
type Char = { ch: string; kind: TokenKind };
type OutPlan =
  | { kind: "text"; text: string; tone: TypewriterTerminalTone; t0: number }
  | { kind: "progress"; label: string; t0: number; t1: number }
  | { kind: "task"; label: string; done?: string; t0: number; t1: number };
type StepPlan = { command: string; cwd: string; chars: Char[]; times: number[]; tPrompt: number; tEnter: number; outputs: OutPlan[] };
type Plan = { steps: StepPlan[]; tFinal: number; finalCwd: string; end: number; clear0: number; loopEnd: number; marks: number[] };

const DEFAULT_STEPS: readonly TypewriterTerminalStep[] = [
  {
    command: "npx create-next-app@latest acme --ts --app",
    cwd: "~",
    output: [
      { text: "Creating a new Next.js app in ~/acme", tone: "muted" },
      { kind: "progress", label: "Installing dependencies", duration: 1.7 },
      { text: "Success! Created acme in 6.4s", tone: "success" },
    ],
  },
  {
    command: "cd acme && npx shadcn@latest add @uiarc/button",
    output: [
      { kind: "task", label: "Resolving @uiarc/button", done: "0.4s", duration: 0.7 },
      { kind: "task", label: "Writing components/button.tsx", done: "0.2s", duration: 0.5 },
      { text: "Added 2 files to registry/components", tone: "success" },
    ],
  },
  {
    command: "npm run dev",
    cwd: "~/acme",
    output: [
      { text: "Next.js 16.0 with Turbopack", tone: "muted", delay: 0.4 },
      "Local: http://localhost:3000",
      { text: "Ready in 812ms", tone: "success", delay: 0.5 },
    ],
  },
];

const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const LINE_FADE = 0.22;
const HOLD = 2.6;
const CLEAR = 0.8;
/** A quiet beat on an empty screen before the first prompt, so every loop starts from rest. */
const LEAD = 0.3;

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const easeOut = (u: number) => 1 - (1 - clamp(u)) ** 3;
const easeInOut = (u: number) => { const x = clamp(u); return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2; };
const smooth = (u: number) => { const x = clamp(u); return x * x * (3 - 2 * x); };

/** A small seeded generator, so the cadence is the same on the server and in every replay. */
function rng(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let x = h;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** Splits a shell command into colored runs: programs, flags, strings, paths and packages, operators, and env assignments. */
function tokenize(command: string): Char[] {
  const out: Char[] = [];
  const re = /(\s+)|('(?:[^'\\]|\\.)*'?|"(?:[^"\\]|\\.)*"?)|(&&|\|\||[|;>]|<)|([^\s'"|;&<>]+)/g;
  let expectCmd = true;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command))) {
    const [text, space, str, op, word] = m;
    let kind: TokenKind = "plain";
    if (space) kind = "plain";
    else if (str) kind = "string";
    else if (op) { kind = "op"; expectCmd = true; }
    else if (word) {
      if (expectCmd && /^[A-Za-z_][\w]*=/.test(word)) kind = "env";
      else if (expectCmd) { kind = "program"; expectCmd = false; }
      else if (/^--?[\w-]/.test(word)) kind = "flag";
      else if (/^\d+(\.\d+)?$/.test(word)) kind = "number";
      else if (/[/@.~:]/.test(word)) kind = "path";
    }
    for (const ch of text) out.push({ ch, kind });
  }
  return out;
}

/** Human typing: a think before the first key, quick bursts inside words, small stalls on shifted keys and word breaks. */
function cadence(chars: Char[], seed: string) {
  const r = rng(seed);
  const times: number[] = [];
  let t = 0;
  let burst = 0;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i].ch, prev = chars[i - 1]?.ch ?? " ";
    let d = 0.048 * (0.6 + r() * 0.8);
    if (burst > 0) { d *= 0.55; burst--; } else if (r() < 0.14) burst = 2 + Math.floor(r() * 3);
    if (prev === " ") d += 0.045 + r() * 0.05;
    if (/[@_"'&|>A-Z:~]/.test(ch)) d += 0.035;
    if (/[-/.]/.test(ch)) d += 0.018;
    if (ch === " " && r() < 0.18) d += 0.12 + r() * 0.12;
    t += d;
    times.push(t);
  }
  return times;
}

function compile(steps: readonly TypewriterTerminalStep[], cwd: string): Plan {
  let t = LEAD;
  let dir = cwd;
  const plans: StepPlan[] = steps.map((step, index) => {
    if (step.cwd) dir = step.cwd;
    const chars = tokenize(step.command);
    const tPrompt = t;
    const think = index === 0 ? 0.7 : 0.45;
    const times = cadence(chars, step.command + index).map(v => v + tPrompt + think);
    const tEnter = (times[times.length - 1] ?? tPrompt + think) + 0.34;
    let c = tEnter + 0.16;
    const outputs: OutPlan[] = (step.output ?? []).map((raw, k) => {
      const o = typeof raw === "string" ? { kind: "text" as const, text: raw } : raw;
      if (o.kind === "progress") { const t0 = c; const t1 = t0 + (o.duration ?? 1.4); c = t1 + 0.1; return { kind: "progress", label: o.label, t0, t1 }; }
      if (o.kind === "task") { const t0 = c; const t1 = t0 + (o.duration ?? 0.8); c = t1 + 0.08; return { kind: "task", label: o.label, done: o.done, t0, t1 }; }
      const t0 = c + (o.delay ?? (k === 0 ? 0 : 0.07));
      c = t0 + 0.07;
      return { kind: "text", text: o.text, tone: o.tone ?? "default", t0 };
    });
    t = c + (step.pause ?? 0.75);
    return { command: step.command, cwd: dir, chars, times, tPrompt, tEnter, outputs };
  });
  const tFinal = plans.length ? t : 0;
  const end = tFinal + 0.2;
  return { steps: plans, tFinal, finalCwd: dir, end, clear0: end + HOLD, loopEnd: end + HOLD + CLEAR, marks: plans.map(p => p.tPrompt) };
}

/** Progress that feels real: a quick start, a stall around the middle, then a steady finish. */
function progressAt(u: number) {
  const keys = [[0, 0], [0.22, 0.34], [0.42, 0.5], [0.6, 0.55], [0.84, 0.9], [1, 1]];
  const x = clamp(u);
  for (let i = 1; i < keys.length; i++) {
    const [x0, y0] = keys[i - 1], [x1, y1] = keys[i];
    if (x <= x1) return y0 + (y1 - y0) * smooth((x - x0) / (x1 - x0));
  }
  return 1;
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

const subscribe = () => () => {};
function useReducedFlag() {
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);
  return !!useReducedMotion() && hydrated;
}

function OutputText({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/\S+)/g);
  return <>{parts.map((part, i) => i % 2 ? <span key={i} className={styles.link}>{part}</span> : part)}</>;
}

const toneIcon: Partial<Record<TypewriterTerminalTone, ReactNode>> = {
  success: <Check size={14} strokeWidth={2} />,
  warning: <TriangleAlert size={14} strokeWidth={1.75} />,
  danger: <X size={14} strokeWidth={2} />,
};

type Sim = {
  t: number; rate: number; rateV: number; last: number; frame: number; running: boolean; visible: boolean;
  scrubbing: boolean; seek: { from: number; to: number; start: number; dur: number } | null;
  scroll: number; scrollV: number; scrollGoal: number; scrollAim: number; sig: string; typing: boolean; lastTime: string; lastStep: number; ended: boolean;
};

export function TypewriterTerminal({
  steps = DEFAULT_STEPS,
  title,
  cwd = "~",
  symbol = "$",
  speed = 1,
  paused = false,
  loop = true,
  rows = 11,
  copyable = true,
  accent,
  label = "Terminal session",
  caption,
  className,
  style,
}: TypewriterTerminalProps) {
  const reduced = useReducedFlag();
  const plan = useMemo(() => compile(steps, cwd), [steps, cwd]);
  const [userPaused, setUserPaused] = useState(false);
  const [ended, setEnded] = useState(false);
  const [message, setMessage] = useState("");

  const root = useRef<HTMLElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const slider = useRef<HTMLDivElement>(null);
  const fill = useRef<HTMLSpanElement>(null);
  const thumb = useRef<HTMLSpanElement>(null);
  const clock = useRef<HTMLSpanElement>(null);
  const writes = useRef(new WeakMap<Element, Record<string, string>>());
  const sim = useRef<Sim>({
    t: 0, rate: 0, rateV: 0, last: 0, frame: 0, running: false, visible: true, scrubbing: false, seek: null,
    scroll: 0, scrollV: 0, scrollGoal: 0, scrollAim: 0, sig: "", typing: false, lastTime: "", lastStep: -2, ended: false,
  });
  const playing = !paused && !userPaused && !ended;
  const live = useRef({ playing, speed, loop, reduced, plan });
  useLayoutEffect(() => { live.current = { playing, speed, loop, reduced, plan }; });

  /** Writes a style or attribute only when it changed. */
  const put = useCallback((el: Element | null | undefined, key: string, value: string | null) => {
    if (!el) return;
    const map = writes.current;
    let cache = map.get(el);
    if (!cache) { cache = {}; map.set(el, cache); }
    const next = value ?? "\u0000";
    if (cache[key] === next) return;
    cache[key] = next;
    if (key.startsWith("@")) { (el as HTMLElement).style.setProperty(key.slice(1), value ?? ""); return; }
    if (key === "#text") { el.textContent = value ?? ""; return; }
    if (value === null) el.removeAttribute(key); else el.setAttribute(key, value);
  }, []);

  const stepAt = useCallback((t: number) => {
    const marks = live.current.plan.marks;
    let i = -1;
    for (let k = 0; k < marks.length; k++) if (t >= marks[k] - 1e-3) i = k;
    return i;
  }, []);

  const paint = useCallback((t: number, dt: number, instant: boolean) => {
    const { plan: p } = live.current;
    const s = sim.current;
    const node = content.current, view = viewport.current;
    if (!node || !view) return;
    const lines = node.querySelectorAll<HTMLElement>("[data-line]");
    const tt = t >= p.clear0 ? p.end : t;
    let li = 0, visible = 0, caretTyped = 0, typing = false;
    for (const step of p.steps) {
      const prompt = lines[li++];
      const on = tt >= step.tPrompt;
      put(prompt, "data-on", on ? "" : null);
      if (on) visible++;
      const fade = easeOut((tt - step.tPrompt) / LINE_FADE);
      put(prompt, "@opacity", fade >= 1 ? "" : fade.toFixed(3));
      let typed = 0;
      while (typed < step.times.length && step.times[typed] <= tt) typed++;
      const chars = prompt?.querySelector("[data-cmd]");
      if (chars) {
        const kids = chars.children;
        for (let k = 0; k < kids.length; k++) put(kids[k], "data-on", k < typed ? "" : null);
        const caret = on && tt < step.tEnter;
        put(chars, "data-caret", caret ? "" : null);
        if (caret) { caretTyped = typed; typing = typed > 0 && tt - step.times[typed - 1] < 0.45 && typed < step.times.length; }
      }
      for (const out of step.outputs) {
        const line = lines[li++];
        const lon = tt >= out.t0;
        put(line, "data-on", lon ? "" : null);
        if (!lon) continue;
        visible++;
        const e = easeOut((tt - out.t0) / LINE_FADE);
        put(line, "@opacity", e >= 1 ? "" : e.toFixed(3));
        put(line, "@transform", e >= 1 ? "" : `translate3d(0, ${((1 - e) * 5).toFixed(2)}px, 0)`);
        if (out.kind === "progress") {
          const u = (tt - out.t0) / (out.t1 - out.t0);
          const v = progressAt(u);
          put(line.querySelector("[data-fill]"), "@transform", `translate3d(${((v - 1) * 100).toFixed(3)}%, 0, 0)`);
          put(line.querySelector("[data-pct]"), "#text", `${Math.round(v * 100)}%`);
          put(line, "data-done", u >= 1 ? "" : null);
        } else if (out.kind === "task") {
          const done = tt >= out.t1;
          put(line, "data-done", done ? "" : null);
          if (!done) put(line.querySelector("[data-spin]"), "#text", SPINNER[Math.floor((tt - out.t0) / 0.08) % SPINNER.length]);
        }
      }
    }
    const final = lines[li];
    const finalOn = tt >= p.tFinal && p.steps.length > 0;
    put(final, "data-on", finalOn ? "" : null);
    put(final, "@opacity", finalOn && tt - p.tFinal < LINE_FADE ? easeOut((tt - p.tFinal) / LINE_FADE).toFixed(3) : "");
    if (finalOn) visible++;
    put(root.current, "data-typing", typing ? "" : null);

    /** Follow the newest line: measure only when the visible text changed, then glide on a critically damped spring. */
    const sig = `${visible}|${caretTyped}`;
    if (sig !== s.sig) {
      s.sig = sig;
      s.scrollGoal = Math.max(0, node.offsetHeight - view.clientHeight);
    }
    if (instant || t < 0.05) { s.scroll = s.scrollAim = s.scrollGoal; s.scrollV = 0; }
    else {
      /** The aim eases toward the goal first, so the spring never starts with a kick when a new line lands mid glide. */
      s.scrollAim += (s.scrollGoal - s.scrollAim) * (1 - Math.exp(-dt * 22));
      const w = 13;
      const a = w * w * (s.scrollAim - s.scroll) - 2 * w * s.scrollV;
      s.scrollV += a * dt;
      s.scroll += s.scrollV * dt;
      if (Math.abs(s.scrollGoal - s.scroll) < 0.05 && Math.abs(s.scrollV) < 0.05) { s.scroll = s.scrollAim = s.scrollGoal; s.scrollV = 0; }
    }
    const c = t >= p.clear0 ? easeInOut((t - p.clear0) / CLEAR) : 0;
    put(node, "@transform", `translate3d(0, ${(-s.scroll - c * 18).toFixed(2)}px, 0)`);
    put(node, "@opacity", c > 0 ? (1 - c).toFixed(3) : "");

    /** The scrubber rewinds to the start while the screen clears, so the loop never jumps. */
    const pos = t >= p.clear0 ? 1 - easeInOut((t - p.clear0) / CLEAR) : clamp(t / p.end);
    put(fill.current, "@transform", `scaleX(${pos.toFixed(4)})`);
    put(thumb.current, "@transform", `translate3d(${(pos * 100).toFixed(3)}%, 0, 0)`);
    const shown = pos * p.end;
    const time = `${fmt(shown)} / ${fmt(p.end)}`;
    if (time !== s.lastTime) {
      s.lastTime = time;
      put(clock.current, "#text", time);
      put(slider.current, "aria-valuenow", String(Math.round(shown)));
    }
    const si = stepAt(shown);
    if (si !== s.lastStep) {
      s.lastStep = si;
      put(slider.current, "aria-valuetext", si < 0 ? "Start" : `Step ${si + 1} of ${p.steps.length}: ${p.steps[si].command}`);
    }
  }, [put, stepAt]);

  const loopRef = useRef<() => void>(() => {});
  const run = useCallback(() => {
    const s = sim.current;
    if (s.running || !s.visible || live.current.reduced) return;
    s.running = true;
    s.last = performance.now();
    const tick = (now: number) => {
      const { playing: go, speed: rate, loop: repeat, plan: p } = live.current;
      const dt = Math.min(0.05, (now - s.last) / 1000);
      s.last = now;
      if (s.seek) {
        const u = (now - s.seek.start) / (s.seek.dur * 1000);
        s.t = s.seek.from + (s.seek.to - s.seek.from) * easeInOut(u);
        if (u >= 1) { s.t = s.seek.to; s.seek = null; }
      } else if (!s.scrubbing) {
        const goal = go ? Math.max(0, rate) : 0;
        const w = 12;
        const a = w * w * (goal - s.rate) - 2 * w * s.rateV;
        s.rateV += a * dt;
        s.rate += s.rateV * dt;
        if (Math.abs(goal - s.rate) < 1e-3 && Math.abs(s.rateV) < 1e-3) { s.rate = goal; s.rateV = 0; }
        s.t += dt * s.rate;
        if (s.t >= p.loopEnd) {
          if (repeat) { s.t -= p.loopEnd; s.scroll = 0; s.scrollAim = 0; s.scrollV = 0; s.sig = ""; }
          else { s.t = p.loopEnd; s.rate = 0; s.rateV = 0; if (!s.ended) { s.ended = true; setEnded(true); } }
        } else if (!repeat && s.t >= p.clear0) {
          s.t = p.clear0 - 1e-4; s.rate = 0; s.rateV = 0;
          if (!s.ended) { s.ended = true; setEnded(true); }
        }
      } else { s.rate = 0; s.rateV = 0; }
      paint(s.t, dt, false);
      const settled = !s.seek && !s.scrubbing && s.rate === 0 && !(go && rate > 0 && !s.ended) && s.scroll === s.scrollGoal;
      if (settled || !s.visible) { s.running = false; return; }
      s.frame = requestAnimationFrame(tick);
    };
    s.frame = requestAnimationFrame(tick);
  }, [paint]);
  useLayoutEffect(() => { loopRef.current = run; }, [run]);

  /** Paint whenever the script or mode changes, then run or rest. */
  useLayoutEffect(() => {
    const s = sim.current;
    writes.current = new WeakMap();
    s.sig = "";
    s.lastTime = "";
    s.lastStep = -2;
    if (reduced) { s.t = plan.end; s.seek = null; paint(s.t, 0, true); return; }
    if (s.t > plan.loopEnd) s.t = 0;
    paint(s.t, 0, true);
    run();
  }, [plan, reduced, paint, run]);

  useEffect(() => { if (!reduced) run(); }, [playing, speed, reduced, run]);

  useEffect(() => {
    const node = root.current, s = sim.current;
    if (!node) return;
    let inView = true;
    const sync = () => {
      s.visible = inView && !document.hidden;
      if (s.visible) loopRef.current(); else { cancelAnimationFrame(s.frame); s.running = false; }
    };
    const observer = new IntersectionObserver(([entry]) => { inView = entry.isIntersecting; sync(); });
    observer.observe(node);
    document.addEventListener("visibilitychange", sync);
    const resize = new ResizeObserver(() => { s.sig = ""; if (live.current.reduced || !s.running) paint(s.t, 0, true); });
    if (viewport.current) resize.observe(viewport.current);
    return () => { observer.disconnect(); resize.disconnect(); document.removeEventListener("visibilitychange", sync); cancelAnimationFrame(s.frame); s.running = false; };
  }, [paint]);

  const describe = useCallback((t: number) => {
    const i = stepAt(t);
    return i < 0 ? "Start of the session" : `Step ${i + 1} of ${plan.steps.length}: ${plan.steps[i].command}`;
  }, [plan, stepAt]);

  const seekTo = useCallback((to: number, dur: number) => {
    const s = sim.current;
    const target = clamp(to, 0, plan.end);
    if (s.ended && target < plan.end) { s.ended = false; setEnded(false); }
    if (live.current.reduced || dur <= 0) { s.seek = null; s.t = target; paint(s.t, 0, true); return; }
    s.seek = { from: s.t >= plan.clear0 ? plan.end : s.t, to: target, start: performance.now(), dur };
    s.rate = 0; s.rateV = 0;
    run();
  }, [paint, plan, run]);

  const togglePlay = () => {
    if (ended) { replay(); return; }
    setUserPaused(v => !v);
    setMessage(playing ? "Paused" : "Playing");
  };

  function replay() {
    const s = sim.current;
    const from = s.t >= plan.clear0 ? plan.end : s.t;
    s.ended = false;
    setEnded(false);
    setUserPaused(false);
    setMessage("Replaying from the start");
    seekTo(0, Math.min(1.1, 0.35 + from * 0.05));
  }

  /** Scrubbing is direct: the session follows the finger, and a release near a command start settles onto it. */
  const drag = useRef<{ left: number; width: number; id: number } | null>(null);
  const scrubTo = (clientX: number) => {
    const d = drag.current, s = sim.current;
    if (!d) return;
    const u = clamp((clientX - d.left) / d.width);
    s.t = u * plan.end;
    s.seek = null;
    if (s.ended && s.t < plan.end) { s.ended = false; setEnded(false); }
    paint(s.t, 1 / 60, false);
    run();
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !track.current) return;
    const rect = track.current.getBoundingClientRect();
    drag.current = { left: rect.left, width: Math.max(1, rect.width), id: e.pointerId };
    e.currentTarget.setPointerCapture(e.pointerId);
    sim.current.scrubbing = true;
    root.current?.setAttribute("data-scrubbing", "");
    slider.current?.focus({ preventScroll: true });
    scrubTo(e.clientX);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => { if (drag.current?.id === e.pointerId) scrubTo(e.clientX); };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current, s = sim.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    s.scrubbing = false;
    root.current?.removeAttribute("data-scrubbing");
    const px = (s.t / plan.end) * d.width;
    let snap: number | null = null;
    for (const m of [...plan.marks, plan.end]) if (Math.abs((m / plan.end) * d.width - px) < 12) snap = m;
    if (snap !== null && Math.abs(snap - s.t) > 1e-3) seekTo(snap, 0.28);
    else run();
    setMessage(describe(snap ?? s.t));
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const s = sim.current;
    const now = s.t >= plan.clear0 ? plan.end : s.seek ? s.seek.to : s.t;
    const stops = [...plan.marks, plan.end];
    let to: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "PageDown") to = stops.find(m => m > now + 0.05) ?? plan.end;
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown" || e.key === "PageUp") to = [...stops].reverse().find(m => m < now - 0.3) ?? 0;
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = plan.end;
    else if (e.key === " " || e.key === "k") { e.preventDefault(); togglePlay(); return; }
    if (to === null) return;
    e.preventDefault();
    seekTo(to, 0.42);
    setMessage(describe(to));
  };

  const commands = steps.map(step => step.command).join("\n");
  const windowTitle = title ?? "zsh";
  const rootStyle = { ...style, ...(accent ? { "--tt-accent": accent } : null), "--tt-rows": rows } as CSSProperties;

  const prompt = (dir: string) => <>
    <span className={styles.cwd}>{dir}</span><span className={styles.symbol}>{symbol}</span>
  </>;

  return <figure ref={root} className={[styles.root, className].filter(Boolean).join(" ")} style={rootStyle} aria-label={label} data-reduced={reduced ? "" : undefined}>
    <div className={styles.window}>
      <div className={styles.bar}>
        <span className={styles.lights} aria-hidden="true"><i /><i /><i /></span>
        <span className={styles.title}>{windowTitle}</span>
        <span className={styles.barEnd}>{copyable && steps.length > 0 && <CopyButton value={commands} label="Copy commands" iconOnly variant="plain" />}</span>
      </div>
      <div ref={viewport} className={styles.viewport} aria-hidden="true">
        <div ref={content} className={styles.content}>
          {plan.steps.map((step, i) => <div key={`s${i}`} className={styles.group}>
            <div data-line className={styles.promptLine}>
              {prompt(step.cwd)}
              <span data-cmd className={styles.cmd}>{step.chars.map((c, k) => <span key={k} className={styles[c.kind]}>{c.ch}</span>)}</span>
            </div>
            {step.outputs.map((out, k) => {
              if (out.kind === "progress") return <div key={k} data-line className={`${styles.out} ${styles.progress}`}>
                <span className={styles.progressLabel}>{out.label}</span>
                <span className={styles.bar2}><span data-fill className={styles.fill} /></span>
                <span data-pct className={styles.pct}>0%</span>
              </div>;
              if (out.kind === "task") return <div key={k} data-line className={`${styles.out} ${styles.task}`}>
                <span className={styles.glyph}><span data-spin className={styles.spin}>{SPINNER[0]}</span><Check className={styles.tick} size={14} strokeWidth={2} /></span>
                <span>{out.label}</span>
                {out.done && <span className={styles.took}>{out.done}</span>}
              </div>;
              return <div key={k} data-line className={styles.out} data-tone={out.tone}>
                {toneIcon[out.tone] && <span className={styles.glyph}>{toneIcon[out.tone]}</span>}
                <span className={styles.text}>{out.text === "" ? " " : <OutputText text={out.text} />}</span>
              </div>;
            })}
          </div>)}
          <div className={styles.group}>
            <div data-line className={styles.promptLine}>{prompt(plan.finalCwd)}<span data-cmd data-caret className={styles.cmd} /></div>
          </div>
        </div>
      </div>
    </div>

    <div className={styles.controls}>
      {!reduced && <button type="button" className={styles.button} onClick={togglePlay} aria-label={ended ? "Replay session" : playing ? "Pause typing" : "Play typing"}>
        <span className={styles.icon} data-show={playing ? "" : undefined}><Pause size={16} strokeWidth={1.75} aria-hidden="true" /></span>
        <span className={styles.icon} data-show={!playing ? "" : undefined}><Play size={16} strokeWidth={1.75} aria-hidden="true" /></span>
      </button>}
      <div
        ref={slider}
        className={styles.scrubber}
        role="slider"
        tabIndex={0}
        aria-label="Session position"
        aria-valuemin={0}
        aria-valuemax={Math.round(plan.end)}
        aria-valuenow={0}
        aria-valuetext="Start"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
      >
        <div ref={track} className={styles.track}>
          <span ref={fill} className={styles.trackFill} />
          {plan.marks.slice(1).map((m, i) => <span key={i} className={styles.mark} style={{ left: `${(m / plan.end) * 100}%` }} />)}
          <span ref={thumb} className={styles.thumbRail}><span className={styles.thumb} /></span>
        </div>
      </div>
      <span ref={clock} className={styles.clock} aria-hidden="true">{`0:00 / ${fmt(plan.end)}`}</span>
      {!reduced && <button type="button" className={styles.button} onClick={replay} aria-label="Replay from the start">
        <RotateCcw size={16} strokeWidth={1.75} aria-hidden="true" />
      </button>}
    </div>

    {caption && <figcaption className={styles.caption}>{caption}</figcaption>}

    <ol className={styles.srOnly}>
      {plan.steps.map((step, i) => <li key={i}>
        {`Command: ${step.command}. `}
        {step.outputs.map(o => o.kind === "text" ? o.text : o.kind === "progress" ? `${o.label}, complete.` : `${o.label}, done.`).filter(Boolean).join(" ")}
      </li>)}
    </ol>
    <span className={styles.srOnly} role="status" aria-live="polite">{message}</span>
  </figure>;
}

export default TypewriterTerminal;
