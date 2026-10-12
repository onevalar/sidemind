"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { animate, useReducedMotion } from "motion/react";
import type { AnimationPlaybackControls } from "motion/react";
import { motionTokens } from "../lib/motion-tokens";
import styles from "./text-scramble.module.css";

/** Ready made glyph sets for the `glyphs` prop. Any string works. */
export const scrambleGlyphs = {
  /** Letters and digits. The default. */
  alphanumeric: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
  letters: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
  digits: "0123456789",
  hex: "0123456789ABCDEF",
  binary: "01",
  symbols: "!#$%&*+-/<=>?@[]^_{|}~",
  blocks: "░▒▓█▖▗▘▙▚▛▜▝▞▟",
} as const;

export type TextScrambleTrigger = "mount" | "inView" | "hover" | "change";
export type TextScrambleOrder = "start" | "end" | "center" | "random";

export interface TextScrambleHandle {
  /** Scrambles the current text again and decodes it back into place. */
  replay: () => void;
  /** The root element. */
  element: HTMLElement | null;
}

/**
 * Text that decodes into place one character at a time. Each character cycles through scramble glyphs, then lands on its final
 * letter in reading order (or from the end, the center, or at random). Every character sits in a cell sized by its final letter,
 * so the line never jitters while it scrambles, and numerals use tabular figures. When the text changes it morphs from the old
 * string to the new one, and a single line springs to its new width. Digits scramble through digits and capitals through capitals by
 * default, so prices and codes keep their shape. Reduced motion swaps the text instantly. Assistive technology reads the plain text.
 */
export interface TextScrambleProps {
  /** The text to show. Changing it morphs from the old text when `trigger` includes `"change"`. */
  children: string;
  /** What starts a scramble. Defaults to `["inView", "change"]`. */
  trigger?: TextScrambleTrigger | TextScrambleTrigger[];
  /** Characters to scramble through. See `scrambleGlyphs`. */
  glyphs?: string;
  /** Digits scramble through digits, capitals through capitals, and lowercase through lowercase, when the set has them. Defaults to true. */
  matchCase?: boolean;
  /** Also scramble punctuation and symbols. Spaces always stay still. Defaults to false. */
  scrambleSymbols?: boolean;
  /** Seconds until the last character lands. Defaults to a length based value between 0.5 and 1.2. */
  duration?: number;
  /** Which characters land first. Defaults to `"start"`. */
  order?: TextScrambleOrder;
  /** Milliseconds between glyph changes while a character scrambles. Defaults to 45. */
  tick?: number;
  /** With `"inView"`, play only the first time the text enters the viewport. Defaults to true. */
  once?: boolean;
  /** Let the text wrap between words. Wrapped text skips the width spring. Defaults to false, one line. */
  wrap?: boolean;
  as?: "span" | "p" | "div" | "strong" | "h1" | "h2" | "h3" | "h4";
  className?: string;
  id?: string;
  onStart?: () => void;
  onComplete?: () => void;
}

type Plan = { from: string[]; start: number[]; end: number[]; ghosts: { char: string; start: number; end: number }[] };
type Token = { text: string; space: boolean; first: number };

const subscribe = () => () => {};
const DIGIT = /\p{Nd}/u, UPPER = /\p{Lu}/u, LOWER = /\p{Ll}/u, WORD = /[\p{L}\p{N}]/u;

function tokenize(text: string) {
  const tokens: Token[] = [];
  const chars: string[] = [];
  for (const part of text.split(/(\s+)/)) {
    if (!part) continue;
    const space = /^\s+$/.test(part);
    tokens.push({ text: part, space, first: chars.length });
    if (!space) chars.push(...Array.from(part));
  }
  return { tokens, chars };
}

/** Landing rank from 0 to 1 for every cell. */
function ranks(count: number, order: TextScrambleOrder) {
  const span = Math.max(1, count - 1);
  const base = Array.from({ length: count }, (_, index) => index);
  if (order === "end") return base.map(index => (count - 1 - index) / span);
  if (order === "center") {
    const mid = (count - 1) / 2, far = Math.max(.5, mid);
    return base.map(index => Math.abs(index - mid) / far);
  }
  if (order === "random") {
    const shuffled = [...base];
    for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!]; }
    const rank: number[] = [];
    shuffled.forEach((cell, position) => { rank[cell] = position / span; });
    return rank;
  }
  return base.map(index => index / span);
}

const defaultDuration = (count: number) => Math.min(1.2, Math.max(.5, .3 + count * .03));

export const TextScramble = forwardRef<TextScrambleHandle, TextScrambleProps>(function TextScramble({
  children, trigger = ["inView", "change"], glyphs = scrambleGlyphs.alphanumeric, matchCase = true, scrambleSymbols = false, duration, order = "start",
  tick = 45, once = true, wrap = false, as = "span", className, id, onStart, onComplete,
}, ref) {
  const Tag = as;
  const text = children;
  const triggerKey = (Array.isArray(trigger) ? trigger : [trigger]).join(" ");
  const triggers = useMemo(() => new Set(triggerKey.split(" ") as TextScrambleTrigger[]), [triggerKey]);
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);
  const prefersReduced = useReducedMotion();
  const reduced = hydrated && !!prefersReduced;
  const { tokens, chars } = useMemo(() => tokenize(text), [text]);

  const rootRef = useRef<HTMLElement>(null);
  const frameRef = useRef<HTMLSpanElement>(null);
  const trackRef = useRef<HTMLSpanElement>(null);
  const ghostRef = useRef<HTMLSpanElement>(null);
  const frameWidth = useRef(0);
  const sizing = useRef<AnimationPlaybackControls | null>(null);
  const raf = useRef(0);
  const running = useRef(false);
  const previous = useRef(text);
  const played = useRef(false);
  // Chosen once: text that decodes on entry starts hidden, so it never flashes before its first run.
  const [armed] = useState(() => triggers.has("mount") || triggers.has("inView"));

  const pools = useMemo(() => {
    const all = Array.from(glyphs);
    const pick = (test: RegExp) => { const found = all.filter(char => test.test(char)); return found.length ? found : all; };
    return { all, digit: pick(DIGIT), upper: pick(UPPER), lower: pick(LOWER) };
  }, [glyphs]);

  const live = useRef({ chars, pools, matchCase, scrambleSymbols, tick, onStart, onComplete });
  useLayoutEffect(() => { live.current = { chars, pools, matchCase, scrambleSymbols, tick, onStart, onComplete }; });

  const cells = useCallback(() => Array.from(trackRef.current?.querySelectorAll<HTMLElement>("[data-cell]") ?? []), []);

  const disarm = useCallback(() => { if (rootRef.current) delete rootRef.current.dataset.armed; }, []);

  const stop = useCallback((settle: boolean) => {
    cancelAnimationFrame(raf.current);
    running.current = false;
    if (!settle) return;
    for (const cell of cells()) { cell.dataset.state = "rest"; const glyph = cell.lastElementChild as HTMLElement | null; if (glyph) glyph.textContent = ""; }
    ghostRef.current?.replaceChildren();
  }, [cells]);

  const run = useCallback((plan: Plan) => {
    const state = live.current;
    const nodes = cells();
    if (!nodes.length && !plan.ghosts.length) return;
    cancelAnimationFrame(raf.current);
    running.current = true;
    disarm();
    state.onStart?.();

    const noiseFor = (target: string) => {
      const { pools: pool } = live.current;
      if (!state.matchCase) return pool.all;
      if (DIGIT.test(target)) return pool.digit;
      if (UPPER.test(target)) return pool.upper;
      if (LOWER.test(target)) return pool.lower;
      return pool.all;
    };
    const scrambles = (char: string) => !!char && (state.scrambleSymbols || WORD.test(char));

    const ghostHost = ghostRef.current;
    const ghostNodes = plan.ghosts.map(ghost => {
      const node = document.createElement("span");
      node.className = styles.ghost ?? "";
      node.textContent = ghost.char;
      return node;
    });
    ghostHost?.replaceChildren(...ghostNodes);

    const glyphsOf = nodes.map(node => node.lastElementChild as HTMLElement);
    const shown: string[] = nodes.map(() => "");
    const phase = nodes.map(() => Math.random() * state.tick);
    const lastBeat: number[] = nodes.map(() => -1);
    const ghostBeat: number[] = plan.ghosts.map(() => -1);
    const begin = performance.now();
    const last = Math.max(0, ...plan.end, ...plan.ghosts.map(ghost => ghost.end));

    const write = (index: number, mode: "rest" | "noise" | "from", char: string) => {
      const node = nodes[index]!;
      if (node.dataset.state !== mode) node.dataset.state = mode;
      const value = mode === "rest" ? "" : char;
      if (shown[index] !== value) { glyphsOf[index]!.textContent = value; shown[index] = value; }
    };

    const frame = (now: number) => {
      const elapsed = (now - begin) / 1000;
      const target = live.current.chars;
      for (let index = 0; index < nodes.length; index++) {
        const final = target[index] ?? "";
        if (elapsed >= plan.end[index]! || !scrambles(final)) { write(index, "rest", final); continue; }
        if (elapsed < plan.start[index]!) { write(index, "from", plan.from[index] ?? ""); continue; }
        const beat = Math.floor((now + phase[index]!) / live.current.tick);
        if (beat !== lastBeat[index]) {
          lastBeat[index] = beat;
          const pool = noiseFor(final);
          let next = pool[Math.floor(Math.random() * pool.length)] ?? "";
          if (next === shown[index] && pool.length > 1) next = pool[(pool.indexOf(next) + 1) % pool.length]!;
          write(index, "noise", next);
        }
      }
      plan.ghosts.forEach((ghost, index) => {
        const node = ghostNodes[index]!;
        if (elapsed >= ghost.end) { if (node.dataset.state !== "gone") node.dataset.state = "gone"; return; }
        if (elapsed < ghost.start) return;
        const beat = Math.floor(now / live.current.tick);
        if (beat === ghostBeat[index]) return;
        ghostBeat[index] = beat;
        node.dataset.state = "noise";
        const pool = noiseFor(ghost.char);
        node.textContent = pool[Math.floor(Math.random() * pool.length)] ?? "";
      });
      if (elapsed >= last + .2) {
        running.current = false;
        ghostHost?.replaceChildren();
        live.current.onComplete?.();
        return;
      }
      raf.current = requestAnimationFrame(frame);
    };
    frame(begin);
    raf.current = requestAnimationFrame(frame);
  }, [cells, disarm]);

  /** Scrambles the current text from nothing (entry) or from itself (replay). */
  const play = useCallback((fromSelf: boolean) => {
    const { chars: target } = live.current;
    const count = target.length;
    const total = duration ?? defaultDuration(count);
    const hold = Math.min(.32, total * .4);
    const rank = ranks(count, order);
    const end = rank.map(value => hold + value * (total - hold));
    const start = fromSelf ? rank.map(value => value * (total - hold) * .45) : rank.map(() => 0);
    run({ from: fromSelf ? [...target] : target.map(() => ""), start, end, ghosts: [] });
  }, [duration, order, run]);

  // Entry: mount plays immediately, inView waits for the viewport. Reduced motion shows the text at once.
  useLayoutEffect(() => {
    if (!armed) return;
    const root = rootRef.current;
    if (!root) return;
    if (reduced) { disarm(); return; }
    if (!hydrated) return;
    if (triggers.has("mount") && !played.current) { played.current = true; play(false); return; }
    if (!triggers.has("inView") || typeof IntersectionObserver === "undefined") { disarm(); return; }
    const observer = new IntersectionObserver(entries => {
      const entry = entries[entries.length - 1];
      if (!entry?.isIntersecting) return;
      if (once && played.current) return;
      played.current = true;
      play(false);
      if (once) observer.disconnect();
    }, { threshold: .4 });
    observer.observe(root);
    return () => observer.disconnect();
  }, [armed, disarm, hydrated, once, play, reduced, triggers]);

  // A new string morphs from the old one, cell by cell; extra old letters scramble away past the end.
  useLayoutEffect(() => {
    const old = previous.current;
    if (old === text) return;
    previous.current = text;
    if (reduced || !triggers.has("change")) { stop(true); disarm(); return; }
    const from = tokenize(old).chars;
    const count = chars.length;
    const total = duration ?? defaultDuration(Math.max(count, from.length));
    const hold = Math.min(.3, total * .35);
    const rank = ranks(count, order);
    const end = rank.map(value => hold + value * (total - hold));
    const start = rank.map((value, index) => index >= from.length ? Math.max(0, end[index]! - hold) : value * (total - hold) * .35);
    const extra = from.slice(count);
    const ghosts = wrap ? [] : extra.map((char, index) => ({ char, start: 0, end: hold * .6 + (index / Math.max(1, extra.length)) * hold }));
    played.current = true;
    run({ from: chars.map((_, index) => from[index] ?? ""), start, end, ghosts });
  }, [chars, disarm, duration, order, reduced, run, stop, text, triggers, wrap]);

  // One line keeps an explicit width that springs to each new string; font loading and resizes follow at once.
  useLayoutEffect(() => {
    const frame = frameRef.current, track = trackRef.current;
    if (!frame || !track) return;
    if (wrap) { frame.style.width = ""; frameWidth.current = 0; return; }
    const next = track.getBoundingClientRect().width;
    if (frameWidth.current && Math.abs(next - frameWidth.current) > .5 && !reduced && triggers.has("change")) {
      sizing.current?.stop();
      sizing.current = animate(frame, { width: next }, motionTokens.spring.morph);
    } else { sizing.current?.stop(); frame.style.width = `${next}px`; }
    frameWidth.current = next;
  }, [text, reduced, triggers, wrap]);

  useEffect(() => {
    const frame = frameRef.current, track = trackRef.current;
    if (wrap || !frame || !track || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const next = track.getBoundingClientRect().width;
      if (Math.abs(next - frameWidth.current) < .5) return;
      sizing.current?.stop(); frame.style.width = `${next}px`; frameWidth.current = next;
    });
    observer.observe(track);
    return () => observer.disconnect();
  }, [wrap]);

  useEffect(() => () => { cancelAnimationFrame(raf.current); sizing.current?.stop(); }, []);

  useImperativeHandle(ref, () => ({
    replay: () => { if (reduced) return; played.current = true; play(true); },
    get element() { return rootRef.current; },
  }), [play, reduced]);

  const onPointerEnter = (event: ReactPointerEvent) => {
    if (!triggers.has("hover") || reduced || running.current || event.pointerType === "touch") return;
    play(true);
  };

  return <Tag ref={rootRef as never} id={id} className={[styles.root, className].filter(Boolean).join(" ")} data-wrap={wrap || undefined} data-armed={armed ? "" : undefined}
    onPointerEnter={triggers.has("hover") ? onPointerEnter : undefined}>
    <span className={styles.srOnly}>{text}</span>
    <span ref={frameRef} className={styles.frame} aria-hidden="true">
      <span ref={trackRef} className={styles.track}>
        {tokens.map((token, tokenIndex) => token.space
          ? <span key={tokenIndex} className={styles.space}>{wrap ? " " : token.text.replace(/\s/g, " ")}</span>
          : <span key={tokenIndex} className={styles.word}>{Array.from(token.text).map((char, offset) => <span key={offset} className={styles.cell} data-cell="" data-state="rest">
            <span className={styles.sizer}>{char}</span><span className={styles.glyph} />
          </span>)}</span>)}
        <span ref={ghostRef} className={styles.ghosts} />
      </span>
    </span>
  </Tag>;
});

export default TextScramble;
