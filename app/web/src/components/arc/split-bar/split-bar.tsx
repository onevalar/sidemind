"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion, useTransform, type MotionValue } from "motion/react";
import { motionTokens } from "../lib/motion-tokens";
import styles from "./split-bar.module.css";

export interface SplitSegment {
  /** Stable id. Segments are matched by id when the data changes. */
  id: string;
  label: string;
  value: number;
  /** Any CSS color. Defaults to the chart series colors, then two neutrals for catch-all shares such as Other. */
  color?: string;
}

export interface SplitBarProps {
  segments: readonly SplitSegment[];
  title?: string;
  description?: string;
  /** Number format for values in the readout. Shares are always shown as percentages. */
  format?: Intl.NumberFormatOptions;
  /** Word after values in the readout, such as visits. */
  unit?: string;
  /** Label for the total shown when nothing is highlighted. */
  totalLabel?: string;
  /** Ids of segments that are switched off (controlled). */
  hidden?: readonly string[];
  /** Ids switched off at first (uncontrolled). */
  defaultHidden?: readonly string[];
  onHiddenChange?: (hidden: string[]) => void;
  /** Show the legend, which also toggles segments. */
  legend?: boolean;
  locale?: string;
  /** Accessible name. Defaults to the title. */
  label?: string;
  className?: string;
  style?: CSSProperties;
}

const PALETTE = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)", "var(--text-muted)", "var(--border-strong)"];
const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const GROW = .045;
const LANE = 40;

type Part = { key: string; digit: number } | { key: string; text: string };

function partsOf(formatter: Intl.NumberFormat, value: number): Part[] {
  const parts = formatter.formatToParts(value);
  let place = parts.reduce((count, part) => count + (part.type === "integer" ? part.value.length : 0), 0);
  let fraction = 0;
  return parts.flatMap((part, index): Part[] => {
    if (part.type === "integer") return [...part.value].map(char => ({ key: `i${--place}`, digit: Number(char) }));
    if (part.type === "fraction") return [...part.value].map(char => ({ key: `f${fraction++}`, digit: Number(char) }));
    return [{ key: part.type === "group" ? `g${place}` : part.type === "literal" ? `l${index}` : part.type, text: part.value }];
  });
}

function Glyph({ position, digit }: { position: MotionValue<number>; digit: number }) {
  const offset = useTransform(position, current => ((((digit - current) % 10) + 15) % 10) - 5);
  const y = useTransform(offset, current => `${current}em`);
  const opacity = useTransform(offset, current => Math.max(0, 1 - Math.abs(current) * 1.2));
  return <motion.span className={styles.glyph} style={{ y, opacity }}>{digit}</motion.span>;
}

function Wheel({ digit, direction, reduceMotion }: { digit: number; direction: number; reduceMotion: boolean }) {
  const position = useMotionValue(digit);
  const wheel = useRef({ digit, target: digit });
  useEffect(() => {
    const state = wheel.current;
    if (state.digit === digit) return;
    state.target += direction < 0 ? -((state.digit - digit + 10) % 10) : (digit - state.digit + 10) % 10;
    state.digit = digit;
    if (reduceMotion) { position.jump(state.target); return; }
    const controls = animate(position, state.target, motionTokens.spring.smooth);
    return () => controls.stop();
  }, [digit, direction, position, reduceMotion]);
  return <span className={styles.wheel}>
    <span className={styles.sizer}>0</span>
    {DIGITS.map(item => <Glyph key={item} position={position} digit={item} />)}
  </span>;
}

const columnPresence = { initial: { width: 0, opacity: 0 }, animate: { width: "auto", opacity: 1 }, exit: { width: 0, opacity: 0 } };

function RollingNumber({ value, formatter, reduceMotion }: { value: number; formatter: Intl.NumberFormat; reduceMotion: boolean }) {
  const [state, setState] = useState({ value, direction: 1 });
  if (state.value !== value) setState({ value, direction: value >= state.value ? 1 : -1 });
  const transition = reduceMotion ? { duration: 0 } : motionTokens.spring.morph;
  return <span className={styles.number} aria-hidden="true">
    <AnimatePresence initial={false}>
      {partsOf(formatter, value).map(part => "digit" in part
        ? <motion.span key={part.key} className={styles.column} {...columnPresence} transition={transition}><Wheel digit={part.digit} direction={state.direction} reduceMotion={reduceMotion} /></motion.span>
        : <motion.span key={part.key} className={styles.symbol} {...columnPresence} transition={transition}>{part.text}</motion.span>)}
    </AnimatePresence>
  </span>;
}

type Slice = { id: string; start: number; end: number; share: number; on: boolean; mode: "full" | "short" | "outside" | "none" };

/** Label widths from canvas text metrics, cached per font, so fitting decisions never read layout. */
function createMeasurer(font: string) {
  const cache = new Map<string, number>();
  const context = typeof document !== "undefined" ? document.createElement("canvas").getContext("2d") : null;
  if (context && font) context.font = font;
  return (text: string) => {
    const hit = cache.get(text);
    if (hit !== undefined) return hit;
    const width = context && font ? context.measureText(text).width : text.length * 7;
    cache.set(text, width);
    return width;
  };
}

function useTextWidth(probe: RefObject<HTMLSpanElement | null>) {
  const [font, setFont] = useState("");
  useEffect(() => {
    const read = () => { if (probe.current) setFont(getComputedStyle(probe.current).font); };
    read();
    document.fonts?.ready.then(read).catch(() => {});
  }, [probe]);
  return useMemo(() => createMeasurer(font), [font]);
}

/** Target layout: shares, the highlighted segment widened a little (enough to fit its label when it is small), then each label fitted inside or sent outside. */
function layout(segments: readonly SplitSegment[], shares: Map<string, number>, active: string | null, width: number, measure: (text: string) => number, percent: Intl.NumberFormat): Slice[] {
  const fractions = new Map(shares);
  if (active && width > 0) {
    const base = fractions.get(active) ?? 0;
    const segment = segments.find(item => item.id === active);
    const fit = segment ? (measure(`${segment.label} ${percent.format(base)}`) + 30) / width : 0;
    const grown = Math.min(Math.max(base + GROW, Math.min(fit, .42)), .9);
    if (grown > base && base < 1) {
      const scale = (1 - grown) / (1 - base);
      for (const [id, fraction] of fractions) fractions.set(id, id === active ? grown : fraction * scale);
    }
  }
  const ends = segments.reduce<number[]>((list, segment) => [...list, (list[list.length - 1] ?? 0) + (fractions.get(segment.id) ?? 0)], []);
  return segments.map((segment, index): Slice => {
    const share = shares.get(segment.id) ?? 0;
    const start = index ? ends[index - 1] ?? 0 : 0;
    const end = Math.min(1, ends[index] ?? 0);
    const px = (end - start) * width;
    const on = end - start > 0;
    const full = measure(`${segment.label} ${percent.format(share)}`) + 30;
    const short = measure(percent.format(share)) + 26;
    const mode = !on ? "none" : px >= full ? "full" : px >= short ? "short" : "outside";
    return { id: segment.id, start, end, share, on, mode };
  });
}

function Segment({ slice, color, width, active, dimmed, text, reduceMotion }: { slice: Slice; color: string; width: MotionValue<number>; active: boolean; dimmed: boolean; text: { name: string; share: number; formatter: Intl.NumberFormat }; reduceMotion: boolean }) {
  const start = useMotionValue(slice.start);
  const end = useMotionValue(slice.end);
  useEffect(() => {
    if (reduceMotion) { start.jump(slice.start); end.jump(slice.end); return; }
    const a = animate(start, slice.start, motionTokens.spring.smooth);
    const b = animate(end, slice.end, motionTokens.spring.smooth);
    return () => { a.stop(); b.stop(); };
  }, [end, reduceMotion, slice.end, slice.start, start]);
  // Each segment is a full width layer cut to its share with clip-path, so reflow never touches layout.
  const clipPath = useTransform([start, end, width], ([s = 0, e = 0, w = 0]: number[]) => {
    const left = Math.min(1, s * w), right = Math.min(1, (1 - e) * w);
    return `inset(0 calc(${((1 - e) * 100).toFixed(3)}% + ${right.toFixed(2)}px) 0 calc(${(s * 100).toFixed(3)}% + ${left.toFixed(2)}px) round 4px)`;
  });
  const capX = useTransform([end, width], ([e = 0, w = 0]: number[]) => e * w - 3 - Math.min(1, (1 - e) * w));
  const capOpacity = useTransform([start, end, width], ([s = 0, e = 0, w = 0]: number[]) => Math.max(0, Math.min(1, ((e - s) * w - 4) / 6)));
  const labelX = useTransform([start, width], ([s = 0, w = 0]: number[]) => s * w + 10);
  const inside = slice.on && (slice.mode === "full" || slice.mode === "short");
  // The cap and the label live inside the clipped layer, so a label can never spill into its neighbour while shares reflow.
  return <motion.span className={styles.segment} data-active={active || undefined} data-dimmed={dimmed || undefined} style={{ clipPath, ["--seg" as string]: color }} aria-hidden="true">
    <motion.span className={styles.cap} style={{ x: capX, opacity: capOpacity }} />
    <motion.span className={styles.inside} style={{ x: labelX }} initial={false} animate={{ opacity: inside ? 1 : 0 }} transition={{ duration: reduceMotion ? 0 : motionTokens.duration.fast }}>
      <motion.span className={styles.insideName} initial={false} animate={{ opacity: slice.mode === "full" ? 1 : 0, width: slice.mode === "full" ? "auto" : 0, marginRight: slice.mode === "full" ? 5 : 0 }} transition={reduceMotion ? { duration: 0 } : motionTokens.spring.morph}>{text.name}</motion.span>
      <RollingNumber value={text.share} formatter={text.formatter} reduceMotion={reduceMotion} />
    </motion.span>
  </motion.span>;
}

type Callout = { id: string; name: string; anchor: number; width: number; x: number };

/** Labels that do not fit sit in a lane under the bar, pushed apart left to right, then back from the right edge, so they never overlap or overflow.
 *  When the names cannot all fit side by side (a narrow bar), the lane drops them and keeps the shares; the legend still names every segment. */
function lane(segments: readonly SplitSegment[], slices: Slice[], width: number, measure: (text: string) => number, percent: Intl.NumberFormat): Callout[] {
  const callouts = (named: boolean): Callout[] => slices.filter(slice => slice.mode === "outside").map(slice => {
    const name = named ? segments.find(item => item.id === slice.id)?.label ?? "" : "";
    const text = percent.format(slice.share);
    return { id: slice.id, name, anchor: (slice.start + slice.end) / 2 * width, width: measure(name ? `${name} ${text}` : text) + 6, x: 0 };
  });
  const span = (list: Callout[]) => list.reduce((sum, item, index) => sum + item.width + (index ? 12 : 0), 0);
  let items = callouts(true);
  if (span(items) > width) items = callouts(false);
  items.forEach((item, index) => {
    const before = items[index - 1];
    item.x = Math.max(before ? before.x + before.width + 12 : 0, item.anchor - item.width / 2);
  });
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index], after = items[index + 1];
    if (!item) continue;
    const limit = after ? after.x - 12 : width;
    if (item.x + item.width > limit) item.x = Math.max(0, limit - item.width);
  }
  return items;
}

export function SplitBar({
  segments,
  title,
  description,
  format,
  unit,
  totalLabel = "Total",
  hidden: hiddenProp,
  defaultHidden = [],
  onHiddenChange,
  legend = true,
  locale = "en-US",
  label,
  className,
  style,
}: SplitBarProps) {
  const reduceMotion = !!useReducedMotion();
  const titleId = useId();
  const [ownHidden, setOwnHidden] = useState<string[]>(() => [...defaultHidden]);
  const hiddenList = hiddenProp ?? ownHidden;
  const hidden = useMemo(() => new Set(hiddenList), [hiddenList]);
  const setHidden = (next: string[]) => { if (!hiddenProp) setOwnHidden(next); onHiddenChange?.(next); };

  const valueFormat = useMemo(() => new Intl.NumberFormat(locale, { maximumFractionDigits: 0, ...format, numberingSystem: "latn" }), [format, locale]);
  const shareFormat = useMemo(() => new Intl.NumberFormat(locale, { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1, numberingSystem: "latn" }), [locale]);

  const bar = useRef<HTMLDivElement>(null);
  const probe = useRef<HTMLSpanElement>(null);
  const width = useMotionValue(0);
  const [barWidth, setBarWidth] = useState(0);
  useLayoutEffect(() => {
    const node = bar.current;
    if (!node) return;
    const measure = () => { width.set(node.clientWidth); setBarWidth(node.clientWidth); };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [width]);
  const measureText = useTextWidth(probe);

  const [active, setActive] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [nudge, setNudge] = useState<{ id: string; key: number } | null>(null);

  const colorOf = (segment: SplitSegment, index: number) => segment.color ?? PALETTE[index % PALETTE.length] ?? "var(--text-muted)";
  const visible = segments.filter(segment => !hidden.has(segment.id) && segment.value > 0);
  const total = visible.reduce((sum, segment) => sum + segment.value, 0);
  const activeOn = active && visible.some(segment => segment.id === active) ? active : null;
  const shareOf = (segment: SplitSegment) => total > 0 && !hidden.has(segment.id) ? Math.max(0, segment.value) / total : 0;

  const shares = new Map(segments.map(segment => [segment.id, shareOf(segment)]));
  const slices = layout(segments, shares, activeOn, barWidth, measureText, shareFormat);

  // Labels that do not fit sit in a lane under the bar, pushed apart so they never overlap, with leader lines back to their segment.
  const outside = lane(segments, slices, barWidth, measureText, shareFormat);

  const toggle = (id: string) => {
    const segment = segments.find(item => item.id === id);
    if (!segment) return;
    if (!hidden.has(id)) {
      if (visible.length <= 1) {
        setNudge(current => ({ id, key: (current?.key ?? 0) + 1 }));
        setMessage(`${segment.label} is the only share shown, so it stays on.`);
        return;
      }
      setHidden([...hiddenList, id]);
      setMessage(`${segment.label} hidden.`);
    } else {
      setHidden(hiddenList.filter(item => item !== id));
      setMessage(`${segment.label} shown.`);
    }
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const at = (event.clientX - rect.left) / rect.width;
    const hit = slices.find(slice => slice.on && at >= slice.start && at < slice.end);
    if (hit && hit.id !== active) setActive(hit.id);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const ids = visible.map(segment => segment.id);
    if (!ids.length) return;
    const index = activeOn ? ids.indexOf(activeOn) : -1;
    const moves: Record<string, number> = { ArrowRight: index + 1, ArrowDown: index + 1, ArrowLeft: index <= 0 ? ids.length - 1 : index - 1, ArrowUp: index <= 0 ? ids.length - 1 : index - 1, Home: 0, End: ids.length - 1 };
    if (event.key === "Escape") { setActive(null); return; }
    if (event.key === "Enter" || event.key === " ") { if (activeOn) { event.preventDefault(); toggle(activeOn); } return; }
    if (!(event.key in moves)) return;
    event.preventDefault();
    const id = ids[(moves[event.key]! + ids.length) % ids.length];
    if (!id) return;
    setActive(id);
    const segment = segments.find(item => item.id === id);
    if (segment) setMessage(`${segment.label}, ${shareFormat.format(shareOf(segment))}, ${valueFormat.format(segment.value)}${unit ? ` ${unit}` : ""}.`);
  };

  const activeSegment = activeOn ? segments.find(segment => segment.id === activeOn) : undefined;
  const activeIndex = activeSegment ? segments.indexOf(activeSegment) : -1;
  const summary = visible.map(segment => `${segment.label} ${shareFormat.format(shareOf(segment))}`).join(", ");
  const name = label ?? title ?? "Split bar";

  return <figure className={[styles.figure, className].filter(Boolean).join(" ")} style={style} aria-labelledby={title ? titleId : undefined} aria-label={title ? undefined : name}>
    <span ref={probe} className={styles.probe} aria-hidden="true">0</span>
    <div className={styles.head}>
      {(title || description) && <div className={styles.heading}>
        {title && <p id={titleId} className={styles.title}>{title}</p>}
        {description && <p className={styles.description}>{description}</p>}
      </div>}
      <div className={styles.readout} aria-hidden="true">
        {/* The readout is right aligned, so the leaving line pops out anchored to the right edge and stays put while the new line sets the width. */}
        <AnimatePresence mode="popLayout" anchorX="right" initial={false}>
          <motion.div
            key={activeSegment ? activeSegment.id : "total"}
            className={styles.readoutLine}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6, filter: `blur(${motionTokens.blur.subtle}px)` }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6, filter: `blur(${motionTokens.blur.subtle}px)`, transition: { duration: motionTokens.duration.fast } }}
            transition={reduceMotion ? { duration: 0 } : { ...motionTokens.spring.snappy, opacity: { duration: motionTokens.duration.fast } }}
          >
            {activeSegment
              ? <>
                <span className={styles.readoutSwatch} style={{ ["--seg" as string]: colorOf(activeSegment, activeIndex) }} />
                <span className={styles.readoutName}>{activeSegment.label}</span>
                <span className={styles.readoutShare}><RollingNumber value={shareOf(activeSegment)} formatter={shareFormat} reduceMotion={reduceMotion} /></span>
                <span className={styles.readoutValue}><RollingNumber value={activeSegment.value} formatter={valueFormat} reduceMotion={reduceMotion} />{unit ? ` ${unit}` : ""}</span>
              </>
              : <>
                <span className={styles.readoutName}>{totalLabel}</span>
                <span className={styles.readoutShare}><RollingNumber value={total} formatter={valueFormat} reduceMotion={reduceMotion} /></span>
                {unit && <span className={styles.readoutValue}>{unit}</span>}
              </>}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>

    <div
      ref={bar}
      className={styles.bar}
      data-active={activeOn ? "" : undefined}
      tabIndex={0}
      role="group"
      aria-roledescription="split bar"
      aria-label={`${name}: ${summary}. Use the arrow keys to read each share.`}
      onPointerMove={onPointerMove}
      onPointerDown={onPointerMove}
      onPointerLeave={event => { if (event.pointerType === "mouse") setActive(null); }}
      onKeyDown={onKeyDown}
      onBlur={() => setActive(null)}
    >
      {segments.map((segment, index) => {
        const slice = slices[index];
        if (!slice) return null;
        return <Segment
          key={segment.id}
          slice={slice}
          color={colorOf(segment, index)}
          width={width}
          active={activeOn === segment.id}
          dimmed={!!activeOn && activeOn !== segment.id}
          text={{ name: segment.label, share: slice.share, formatter: shareFormat }}
          reduceMotion={reduceMotion}
        />;
      })}
    </div>

    <motion.div className={styles.lane} initial={false} animate={{ height: outside.length ? LANE : 0 }} transition={reduceMotion ? { duration: 0 } : motionTokens.spring.smooth} aria-hidden="true">
      <svg className={styles.leaders} width="100%" height={LANE}>
        <AnimatePresence initial={false}>
          {outside.map(item => {
            const center = item.x + item.width / 2;
            // A soft S curve from the segment's middle to the label: it leaves the bar straight down and lands straight on the label.
            const d = `M${item.anchor.toFixed(1)} 0 C${item.anchor.toFixed(1)} 10 ${center.toFixed(1)} 6 ${center.toFixed(1)} 15`;
            return <motion.path key={item.id} className={styles.leader} data-dimmed={activeOn && activeOn !== item.id || undefined} initial={{ opacity: 0, d }} animate={{ opacity: 1, d }} exit={{ opacity: 0 }} transition={reduceMotion ? { duration: 0 } : { d: motionTokens.spring.smooth, opacity: { duration: motionTokens.duration.fast } }} />;
          })}
        </AnimatePresence>
      </svg>
      <AnimatePresence initial={false}>
        {outside.map(item => {
          const slice = slices.find(entry => entry.id === item.id);
          return <motion.span key={item.id} className={styles.outside} data-dimmed={activeOn && activeOn !== item.id || undefined} initial={{ opacity: 0, x: item.x, y: -4 }} animate={{ opacity: 1, x: item.x, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={reduceMotion ? { duration: 0 } : { ...motionTokens.spring.smooth, opacity: { duration: motionTokens.duration.fast } }}>
            {item.name && <span className={styles.outsideName}>{item.name}</span>}
            <RollingNumber value={slice?.share ?? 0} formatter={shareFormat} reduceMotion={reduceMotion} />
          </motion.span>;
        })}
      </AnimatePresence>
    </motion.div>

    {legend && <ul className={styles.legend} aria-label={`${name} segments`}>
      {segments.map((segment, index) => {
        const on = !hidden.has(segment.id);
        return <li key={segment.id}>
          <button
            type="button"
            className={styles.legendItem}
            data-off={!on || undefined}
            data-active={activeOn === segment.id || undefined}
            aria-pressed={on}
            aria-label={`${segment.label}, ${on ? shareFormat.format(shareOf(segment)) : "hidden"}`}
            style={{ ["--seg" as string]: colorOf(segment, index) }}
            onClick={() => toggle(segment.id)}
            onPointerEnter={event => { if (event.pointerType === "mouse" && on) setActive(segment.id); }}
            onPointerLeave={event => { if (event.pointerType === "mouse") setActive(null); }}
          >
            {/* A refused toggle shakes its label once; the button itself stays put so focus is kept. */}
            <motion.span
              key={nudge?.id === segment.id ? nudge.key : 0}
              className={styles.legendLabel}
              initial={{ x: 0 }}
              animate={nudge?.id === segment.id && !reduceMotion ? { x: [0, -3, 3, -2, 0] } : { x: 0 }}
              transition={{ duration: .32, ease: motionTokens.ease.standard }}
            >
              <span className={styles.swatch} aria-hidden="true" />
              <span className={styles.legendName}>{segment.label}</span>
            </motion.span>
            <span className={styles.legendShare} aria-hidden="true">
              <AnimatePresence mode="popLayout" initial={false}>
                {on
                  ? <motion.span key="on" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduceMotion ? 0 : motionTokens.duration.fast }}><RollingNumber value={shareOf(segment)} formatter={shareFormat} reduceMotion={reduceMotion} /></motion.span>
                  : <motion.span key="off" className={styles.legendOff} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduceMotion ? 0 : motionTokens.duration.fast }}>Off</motion.span>}
              </AnimatePresence>
            </span>
          </button>
        </li>;
      })}
    </ul>}
    <p className={styles.srOnly} role="status" aria-live="polite" aria-atomic="true">{message}</p>
  </figure>;
}

export default SplitBar;
