"use client";

import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type PointerEvent, type Ref } from "react";
import { AnimatePresence, animate, motion, useInView, useMotionValue, useReducedMotion, useSpring, type Variants } from "motion/react";
import { motionTokens } from "../lib/motion-tokens";
import styles from "./sunburst.module.css";

export interface SunburstNode {
  /** Stable identity, unique in the tree. A node that survives a data change keeps its arc, so switching datasets morphs it. */
  id: string;
  label: string;
  /** Leaf value. A branch's value is the sum of its children. */
  value?: number;
  children?: SunburstNode[];
}

/** Use a sunburst for a hierarchy of parts, such as spend by team, service, and resource, when people explore by drilling down. */
export interface SunburstProps {
  /** The root. Its label names the whole in the centre and the first breadcrumb. */
  data: SunburstNode;
  /** What the whole is, such as "Cloud spend". Names the chart for assistive technology. */
  label: string;
  formatValue?: (value: number) => string;
  /** Rings shown around the centre at once. */
  depth?: number;
  /** Largest diameter in pixels. The chart scales down to fit narrower containers. */
  size?: number;
  /** Controlled id of the node in the centre. */
  focus?: string;
  defaultFocus?: string;
  onFocusChange?: (id: string) => void;
  /** Children of the node in the centre, with values and shares. Hover and focus stay in sync with the arcs. */
  legend?: boolean;
  emptyLabel?: string;
  ref?: Ref<HTMLElement>;
  className?: string;
}

type Flat = { id: string; label: string; value: number; depth: number; x0: number; x1: number; parent: string | null; children: string[]; branch: number; path: string[] };
type Geo = { a0: number; a1: number; d: number };

const { spring, ease, blur } = motionTokens;
const physical = ({ visualDuration, bounce }: { visualDuration: number; bounce: number }, restDelta = .0005) => { const root = (2 * Math.PI) / (visualDuration * 1.2); return { type: "spring" as const, stiffness: root * root, damping: 2 * (1 - bounce) * root, restDelta, restSpeed: restDelta * 2 }; };
const zoom = physical({ visualDuration: .62, bounce: .06 });
const reveal = physical({ visualDuration: .9, bounce: 0 });
const glide = physical(spring.snappy, .01);
const follow = { stiffness: glide.stiffness, damping: glide.damping, restDelta: .01 };
/** Each top level branch takes the next chart series (the first in the accent), and its descendants step toward the surface, so a branch reads as one family. Past four branches fall back to ink. */
const hueOf = (node: Flat) => node.branch < 4 ? `var(--series-${node.branch + 1})` : "color-mix(in oklab, var(--foreground) 34%, var(--surface))";
const shadeOf = (node: Flat) => `color-mix(in oklab, ${hueOf(node)} ${Math.round(100 * Math.pow(.7, Math.max(0, node.depth - 1)))}%, var(--surface))`;
const GAP = 2, TIP = 14;
const grouped = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const percent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 });
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const TAU = Math.PI * 2;

/** Angles as shares of the full turn and depth from the root, for every node. */
function partition(root: SunburstNode) {
  const flat = new Map<string, Flat>();
  const total = (node: SunburstNode): number => node.children?.length ? node.children.reduce((sum, child) => sum + total(child), 0) : Math.max(0, node.value ?? 0);
  const visit = (node: SunburstNode, depth: number, x0: number, span: number, parent: string | null, branch: number, path: string[]) => {
    const value = total(node);
    const item: Flat = { id: node.id, label: node.label, value, depth, x0, x1: x0 + span, parent, children: (node.children ?? []).map(child => child.id), branch, path: [...path, node.label] };
    flat.set(node.id, item);
    let at = x0;
    (node.children ?? []).forEach((child, index) => { const share = value ? (total(child) / value) * span : 0; visit(child, depth + 1, at, share, node.id, depth === 0 ? index : branch, depth === 0 ? [] : item.path); at += share; });
  };
  visit(root, 0, 0, 1, null, 0, []);
  return flat;
}

/** An annular sector with parallel sided gaps: each edge is pulled in by the same distance at every radius. */
function sector(c: number, inner: number, outer: number, a0: number, a1: number) {
  if (outer - inner < .5) return "";
  const pi = GAP / 2 / Math.max(inner, 1) / TAU, po = GAP / 2 / outer / TAU;
  const full = a1 - a0 >= .9999;
  const s0 = full ? a0 : a0 + po, e0 = full ? a1 : a1 - po, s1 = full ? a0 : a0 + pi, e1 = full ? a1 : a1 - pi;
  if (e0 - s0 <= 1e-4 || (!full && e1 - s1 <= 0)) return "";
  const point = (radius: number, turn: number) => { const angle = turn * TAU - Math.PI / 2; return `${(c + radius * Math.cos(angle)).toFixed(2)} ${(c + radius * Math.sin(angle)).toFixed(2)}`; };
  if (full) return `M${point(outer, 0)}A${outer} ${outer} 0 1 1 ${point(outer, .49999)}A${outer} ${outer} 0 1 1 ${point(outer, .99999)}ZM${point(inner, 0)}A${inner} ${inner} 0 1 0 ${point(inner, .50001)}A${inner} ${inner} 0 1 0 ${point(inner, 0.00001)}Z`;
  return `M${point(outer, s0)}A${outer.toFixed(2)} ${outer.toFixed(2)} 0 ${e0 - s0 > .5 ? 1 : 0} 1 ${point(outer, e0)}L${point(inner, e1)}A${inner.toFixed(2)} ${inner.toFixed(2)} 0 ${e1 - s1 > .5 ? 1 : 0} 0 ${point(inner, s1)}Z`;
}

const rise: Variants = {
  hidden: (direction: number) => ({ opacity: 0, y: `${.35 * direction}em`, filter: `blur(${blur.soft}px)` }),
  shown: { opacity: 1, y: 0, filter: "blur(0px)", transition: { duration: .24, ease: [...ease.enter] } },
  gone: (direction: number) => ({ opacity: 0, y: `${-.35 * direction}em`, filter: `blur(${blur.subtle}px)`, transition: { duration: .14, ease: [...ease.standard] } }),
};
const fade: Variants = { hidden: { opacity: 0 }, shown: { opacity: 1, transition: { duration: .15 } }, gone: { opacity: 0, transition: { duration: .1 } } };

function Swap({ text, reduced }: { text: string; reduced: boolean }) {
  return <span className={styles.swap}><AnimatePresence mode="popLayout" initial={false} custom={1}>
    <motion.span key={text} className={styles.swapText} custom={1} variants={reduced ? fade : rise} initial="hidden" animate="shown" exit="gone">{text}</motion.span>
  </AnimatePresence></span>;
}

const amountIn = (text: string) => Number(text.replace(/[^\d.-]/g, "")) || 0;
/** Digits roll by place from the right, so unchanged ones hold still; the width springs to fit. */
function Roll({ text, reduced }: { text: string; reduced: boolean }) {
  const sizer = useRef<HTMLSpanElement>(null);
  const width = useMotionValue<number | "auto">("auto");
  const [seen, setSeen] = useState({ text, direction: 1 });
  if (seen.text !== text) setSeen({ text, direction: amountIn(text) < amountIn(seen.text) ? -1 : 1 });
  useLayoutEffect(() => {
    const node = sizer.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    let measured: string | null = null;
    const observer = new ResizeObserver(() => {
      const next = node.offsetWidth;
      if (measured !== null && measured !== node.textContent && !reduced) animate(width, next, spring.morph);
      else width.jump(next);
      measured = node.textContent;
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [reduced, width]);
  const chars = [...text];
  const variants = reduced ? fade : rise;
  return <motion.span className={styles.roll} style={{ width }}>
    <span ref={sizer} className={styles.sizer} aria-hidden="true">{text}</span>
    <span className={styles.digits}><AnimatePresence mode="popLayout" initial={false} custom={seen.direction} anchorX="right">
      {chars.map((char, index) => <motion.span key={`p${chars.length - index}`} className={styles.digit} custom={seen.direction} variants={variants} initial="hidden" animate="shown" exit="gone">
        <AnimatePresence mode="popLayout" initial={false} custom={seen.direction} anchorX="right">
          <motion.span key={char} className={styles.digit} custom={seen.direction} variants={variants} initial="hidden" animate="shown" exit="gone">{char}</motion.span>
        </AnimatePresence>
      </motion.span>)}
    </AnimatePresence></span>
  </motion.span>;
}

const subscribeNothing = () => () => {};
function useReducedMotionSafe() {
  const hydrated = useSyncExternalStore(subscribeNothing, () => true, () => false);
  return !!useReducedMotion() && hydrated;
}

export function Sunburst({ data, label, formatValue = value => grouped.format(value), depth = 3, size = 340, focus, defaultFocus, onFocusChange, legend = true, emptyLabel = "No data yet", ref, className }: SunburstProps) {
  const reduced = useReducedMotionSafe();
  const figure = useRef<HTMLElement>(null);
  const ring = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const paths = useRef(new Map<string, SVGPathElement>());
  const texts = useRef(new Map<string, SVGTextElement>());
  useImperativeHandle(ref, () => figure.current as HTMLElement);
  const inView = useInView(figure, { once: true, amount: .3 });
  // Arc labels stay 11px on screen however far the ring scales down.
  const [ringWidth, setRingWidth] = useState(0);
  useLayoutEffect(() => {
    const node = ring.current;
    if (!node) return;
    setRingWidth(node.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setRingWidth(node.clientWidth));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const signature = JSON.stringify(data);
  const flat = useMemo(() => partition(data), [signature]); // eslint-disable-line react-hooks/exhaustive-deps
  const root = flat.get(data.id)!;
  const [ownFocus, setOwnFocus] = useState(defaultFocus ?? data.id);
  const wanted = focus ?? ownFocus;
  const center = flat.get(wanted) && flat.get(wanted)!.children.length ? flat.get(wanted)! : root;
  const zoomTo = (id: string) => { if (focus === undefined) setOwnFocus(id); onFocusChange?.(id); };
  const [active, setActive] = useState<string | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const activeNode = active ? flat.get(active) ?? null : null;
  const shownActive = activeNode && activeNode.depth > center.depth && activeNode.depth <= center.depth + depth && activeNode.x0 >= center.x0 - 1e-9 && activeNode.x1 <= center.x1 + 1e-9 ? activeNode : null;

  // Every node ever drawn keeps its on screen geometry; the painter reads it each frame.
  const drawn = useMemo(() => [...flat.values()].filter(node => node.depth > 0), [flat]);
  const geo = useRef(new Map<string, Geo>());
  const c = size / 2, outer = c - 2, hole = outer * .36;
  // Rings share the radius between the levels actually below the centre, so zooming into a shallow branch fills the chart.
  const levelsBelow = (node: Flat): number => node.children.length ? 1 + Math.max(...node.children.map(id => levelsBelow(flat.get(id)!))) : 0;
  const levels = Math.max(1, Math.min(depth, levelsBelow(center)));
  const levelsNow = useRef(levels);
  const radiusAt = useCallback((d: number, count = levelsNow.current) => hole + (d - 1) * ((outer - hole) / count), [hole, outer]);
  const targetOf = useCallback((node: Flat, focusNode: Flat): Geo => {
    const span = focusNode.x1 - focusNode.x0 || 1;
    return { a0: clamp((node.x0 - focusNode.x0) / span, 0, 1), a1: clamp((node.x1 - focusNode.x0) / span, 0, 1), d: node.depth - focusNode.depth };
  }, []);
  const lineage = useMemo(() => { const set = new Set<string>(); let at: Flat | undefined = shownActive ?? undefined; while (at && at.depth > center.depth) { set.add(at.id); at = at.parent ? flat.get(at.parent) : undefined; } return set; }, [shownActive, center, flat]);

  const paint = useCallback(() => {
    for (const node of drawn) {
      const path = paths.current.get(node.id), g = geo.current.get(node.id);
      if (!path || !g) continue;
      const opacity = clamp(g.d, 0, 1) * clamp(levelsNow.current + 1 - g.d, 0, 1);
      const inner = Math.max(hole, radiusAt(g.d)), outerR = Math.max(inner, Math.min(outer, radiusAt(g.d + 1)));
      path.setAttribute("d", opacity > .01 ? sector(c, inner + GAP / 2, outerR - GAP / 2, g.a0, g.a1) : "");
      path.style.opacity = String(opacity);
      path.style.pointerEvents = opacity > .6 && g.a1 - g.a0 > .002 ? "auto" : "none";
      // Names follow the arc's tangent, turned upright on the lower half, and show only where the arc can hold them.
      const text = texts.current.get(node.id);
      if (!text) continue;
      const turn = (g.a0 + g.a1) / 2, mid = turn * TAU - Math.PI / 2, r = (inner + outerR) / 2;
      const x = c + r * Math.cos(mid), y = c + r * Math.sin(mid), degrees = turn * 360;
      text.setAttribute("x", x.toFixed(1));
      text.setAttribute("y", y.toFixed(1));
      text.setAttribute("transform", `rotate(${(degrees > 90 && degrees < 270 ? degrees - 180 : degrees).toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)})`);
      const room = (g.a1 - g.a0) * TAU * r, need = (text.getComputedTextLength?.() ?? 40) + 14;
      text.style.opacity = opacity > .9 && room >= need && outerR - inner >= 18 ? "1" : "0";
    }
  }, [c, drawn, hole, outer, radiusAt]);

  // Zooming or new data interpolates every arc from where it is on screen to where it belongs around the new centre.
  const flight = useRef<{ stop: () => void } | null>(null);
  const shown = inView || reduced;
  useEffect(() => {
    if (!shown) return;
    const targets = new Map(drawn.map(node => [node.id, targetOf(node, center)]));
    const first = geo.current.size === 0;
    const from = new Map(drawn.map(node => { const now = geo.current.get(node.id); const to = targets.get(node.id)!; return [node.id, now ?? (first ? { a0: 0, a1: 0, d: to.d } : { a0: to.a0, a1: to.a0, d: to.d })]; }));
    for (const id of [...geo.current.keys()]) if (!flat.has(id)) geo.current.delete(id);
    flight.current?.stop();
    const fromLevels = levelsNow.current;
    const finish = () => { levelsNow.current = levels; for (const [id, to] of targets) geo.current.set(id, to); paint(); };
    if (reduced) { finish(); return; }
    flight.current = animate(0, 1, { ...(first ? reveal : zoom), onUpdate: t => {
      levelsNow.current = fromLevels + (levels - fromLevels) * t;
      for (const [id, to] of targets) { const f = from.get(id)!; geo.current.set(id, { a0: f.a0 + (to.a0 - f.a0) * t, a1: f.a1 + (to.a1 - f.a1) * t, d: f.d + (to.d - f.d) * t }); }
      paint();
    }, onComplete: finish });
    return () => flight.current?.stop();
  }, [shown, center.id, flat, reduced, levels]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(paint);

  // The tooltip trails the pointer, or sits by the arc in focus, and stays inside the chart.
  const tipX = useMotionValue(0), tipY = useMotionValue(0);
  const tipSpringX = useSpring(tipX, follow), tipSpringY = useSpring(tipY, follow);
  const wasOn = useRef(false);
  useLayoutEffect(() => {
    const bubble = tip.current, box = ring.current;
    if (!bubble || !box || !shownActive) { wasOn.current = false; return; }
    const w = box.clientWidth, h = box.clientHeight, scale = w / size;
    let ax = pointer?.x, ay = pointer?.y;
    if (ax === undefined || ay === undefined) { const g = targetOf(shownActive, center), mid = (g.a0 + g.a1) / 2 * TAU - Math.PI / 2, r = (radiusAt(g.d, levels) + radiusAt(g.d + 1, levels)) / 2; ax = (c + r * Math.cos(mid)) * scale; ay = (c + r * Math.sin(mid)) * scale; }
    const tw = bubble.offsetWidth, th = bubble.offsetHeight;
    let left = ax + TIP;
    if (left + tw > w) left = ax - TIP - tw;
    let top = ay - th - TIP;
    if (top < 0) top = ay + TIP;
    tipX.set(clamp(left, 0, Math.max(0, w - tw))); tipY.set(clamp(top, 0, Math.max(0, h - th)));
    if (!wasOn.current || reduced) { tipSpringX.jump(tipX.get()); tipSpringY.jump(tipY.get()); }
    wasOn.current = true;
  });

  const onPointerMove = (event: PointerEvent<SVGPathElement>, id: string) => {
    if (event.pointerType !== "mouse") return;
    const rect = ring.current?.getBoundingClientRect();
    if (rect) setPointer({ x: event.clientX - rect.left, y: event.clientY - rect.top });
    setActive(id);
  };
  const children = center.children.map(id => flat.get(id)!).filter(Boolean);
  const empty = !root.value;

  // When the legend sits under the ring, its height follows the rows on a spring, so the content below never snaps.
  const legendBox = useRef<HTMLDivElement>(null);
  const legendList = useRef<HTMLUListElement>(null);
  const legendHeight = useMotionValue<number | "auto">("auto");
  useLayoutEffect(() => {
    const list = legendList.current, box = legendBox.current;
    if (!list || !box || typeof ResizeObserver === "undefined") return;
    let measured = false;
    const observer = new ResizeObserver(() => {
      const next = list.offsetHeight, stacked = !!ring.current && box.offsetLeft < ring.current.offsetLeft + ring.current.offsetWidth;
      if (!stacked) legendHeight.jump("auto");
      else if (measured && !reduced && legendHeight.get() !== "auto") animate(legendHeight, next, spring.smooth);
      else legendHeight.jump(next);
      measured = true;
    });
    observer.observe(list);
    return () => observer.disconnect();
  }, [reduced, legendHeight, legend, empty]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const node = shownActive;
    const siblings = node?.parent ? flat.get(node.parent)!.children.map(id => flat.get(id)!) : children;
    const at = node ? siblings.findIndex(item => item.id === node.id) : -1;
    const move = (id: string | undefined) => { if (!id) return; event.preventDefault(); setPointer(null); setActive(id); };
    if (event.key === "ArrowRight") move(siblings[(at + 1) % siblings.length]?.id ?? children[0]?.id);
    else if (event.key === "ArrowLeft") move(siblings[(at - 1 + siblings.length) % siblings.length]?.id ?? children[children.length - 1]?.id);
    else if (event.key === "ArrowDown") move(node && node.children.length && node.depth < center.depth + depth ? node.children[0] : node ? undefined : children[0]?.id);
    else if (event.key === "ArrowUp") move(node?.parent && node.parent !== center.id ? node.parent : undefined);
    else if (event.key === "Enter" || event.key === " ") { if (node?.children.length) { event.preventDefault(); zoomTo(node.id); setActive(node.children[0]); } }
    else if (event.key === "Escape" || event.key === "Backspace") { if (center.parent) { event.preventDefault(); zoomTo(center.parent); setActive(center.id); } else if (active) { event.preventDefault(); setActive(null); } }
  };

  const trail: Flat[] = [];
  for (let at: Flat | undefined = center; at; at = at.parent ? flat.get(at.parent) : undefined) trail.unshift(at);
  const reading = shownActive ?? center;
  const parentOf = (node: Flat) => node.parent ? flat.get(node.parent)! : node;
  const share = (node: Flat, of: Flat) => of.value ? node.value / of.value : 0;
  const describe = (node: Flat) => `${node.path.join(", ")}, ${formatValue(node.value)}, ${percent.format(share(node, parentOf(node)))} of ${parentOf(node).label}`;

  return <figure ref={figure} className={[styles.figure, className].filter(Boolean).join(" ")} aria-label={label} data-legend={legend || undefined}>
    <nav className={styles.crumbs} aria-label={`${label} path`}>
      <ol className={styles.crumbList}>
        <AnimatePresence initial={false} mode="popLayout">
          {trail.map((node, index) => <motion.li key={node.id} className={styles.crumb} layout={reduced ? false : "position"} initial={{ opacity: 0, x: reduced ? 0 : -6 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: reduced ? 0 : -6, transition: { duration: .12 } }} transition={{ ...spring.smooth }}>
            {index > 0 && <span className={styles.crumbSep} aria-hidden="true">/</span>}
            {index < trail.length - 1 ? <button type="button" className={styles.crumbButton} onClick={() => zoomTo(node.id)}>{node.label}</button> : <span className={styles.crumbCurrent} aria-current="location">{node.label}</span>}
          </motion.li>)}
        </AnimatePresence>
      </ol>
    </nav>
    <div className={styles.body}>
      <div ref={ring} className={styles.ring} style={{ width: size }} data-active={shownActive ? true : undefined} role="group" tabIndex={empty ? -1 : 0} aria-roledescription="sunburst" aria-label={`${label}, ${center.label}. Arrow keys move between segments, Enter zooms in, Escape zooms out.`}
        onKeyDown={onKeyDown} onBlur={() => setActive(null)} onPointerLeave={() => { setActive(null); setPointer(null); }} onFocus={event => { if (event.currentTarget.matches(":focus-visible") && !active) setActive(children[0]?.id ?? null); }}>
        <svg className={styles.svg} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" focusable="false">
          <circle className={styles.track} cx={c} cy={c} r={(hole + outer) / 2} strokeWidth={outer - hole} />
          {drawn.map(node => <path key={node.id} ref={element => { if (element) paths.current.set(node.id, element); else paths.current.delete(node.id); }} className={styles.arc}
            data-active={shownActive?.id === node.id || undefined} data-lineage={lineage.has(node.id) && shownActive?.id !== node.id || undefined} data-dim={shownActive !== null && !lineage.has(node.id) || undefined}
            style={{ "--fill": shadeOf(node), "--hue": hueOf(node) } as CSSProperties}
            onPointerMove={event => onPointerMove(event, node.id)} onClick={() => { if (node.children.length) zoomTo(node.id); else if (node.parent && node.parent !== center.id) zoomTo(node.parent); }} />)}
          {drawn.map(node => <text key={node.id} ref={element => { if (element) texts.current.set(node.id, element); else texts.current.delete(node.id); }} className={styles.arcLabel} data-dim={shownActive !== null && !lineage.has(node.id) || undefined} fontSize={ringWidth ? (11 * size) / ringWidth : 11} textAnchor="middle" dominantBaseline="central">{node.label}</text>)}
        </svg>
        <button type="button" className={styles.center} style={{ width: `${(hole * 2 - 8) / size * 100}%` }} disabled={!center.parent} onClick={() => center.parent && zoomTo(center.parent)} aria-label={center.parent ? `Back to ${flat.get(center.parent)!.label}` : center.label} tabIndex={-1}>
          <span className={styles.centerLabel}><Swap text={empty ? emptyLabel : reading.label} reduced={reduced} /></span>
          {!empty && <span className={styles.centerValue}><Roll text={formatValue(reading.value)} reduced={reduced} /></span>}
          {!empty && <span className={styles.centerMeta}><Swap text={shownActive ? `${percent.format(share(shownActive, center))} of ${center.parent ? center.label : "total"}` : center.parent ? `${percent.format(share(center, root))} of total` : `${children.length} ${children.length === 1 ? "group" : "groups"}`} reduced={reduced} /></span>}
        </button>
        <motion.div ref={tip} className={styles.tooltip} style={{ x: reduced ? tipX : tipSpringX, y: reduced ? tipY : tipSpringY }} aria-hidden="true">
          {shownActive && <>
            <p className={styles.tipTitle}>{shownActive.path.slice(0, -1).join(" / ") || root.label}</p>
            <p className={styles.tipValue}><span className={styles.tipName}>{shownActive.label}</span><span className={styles.tipAmount}>{formatValue(shownActive.value)}</span></p>
            <p className={styles.tipNote}>{parentOf(shownActive).id === root.id ? `${percent.format(share(shownActive, root))} of total` : `${percent.format(share(shownActive, parentOf(shownActive)))} of ${parentOf(shownActive).label}, ${percent.format(share(shownActive, root))} of total`}</p>
          </>}
        </motion.div>
      </div>
      {legend && !empty && <motion.div ref={legendBox} className={styles.legendBox} style={{ height: legendHeight }}><ul ref={legendList} className={styles.legend} aria-label={`${center.label}, parts`}>
        <AnimatePresence initial={false} mode="popLayout">
          {children.map((node, index) => <motion.li key={node.id} layout={reduced ? false : "position"} initial={{ opacity: 0, y: reduced ? 0 : 6 }} animate={{ opacity: 1, y: 0, transition: { delay: reduced ? 0 : index * .03, duration: .24, ease: [...ease.enter] } }} exit={{ opacity: 0, transition: { duration: .1 } }}>
            <button type="button" className={styles.row} data-active={lineage.has(node.id) || undefined} data-dim={shownActive !== null && !lineage.has(node.id) || undefined} aria-label={`${describe(node)}${node.children.length ? ". Zoom in" : ""}`}
              onClick={() => { if (node.children.length) zoomTo(node.id); }} onPointerEnter={event => { if (event.pointerType === "mouse") { setPointer(null); setActive(node.id); } }} onPointerLeave={() => setActive(null)}
              onFocus={event => { if (event.currentTarget.matches(":focus-visible")) { setPointer(null); setActive(node.id); } }} onBlur={() => setActive(null)} style={{ "--fill": shadeOf(node), "--hue": hueOf(node) } as CSSProperties}>
              <span className={styles.dot} aria-hidden="true" />
              <span className={styles.rowLabel}>{node.label}</span>
              <span className={styles.rowValue} aria-hidden="true"><Roll text={formatValue(node.value)} reduced={reduced} /></span>
              <span className={styles.rowShare} aria-hidden="true">{percent.format(share(node, center))}</span>
            </button>
          </motion.li>)}
        </AnimatePresence>
      </ul></motion.div>}
    </div>
    <p className={styles.srOnly} aria-live="polite" aria-atomic="true">{shownActive ? describe(shownActive) : `${center.label}, ${formatValue(center.value)}`}</p>
    {!empty && <div className={styles.srOnly}><table>
      <caption>{label}</caption>
      <thead><tr><th scope="col">Path</th><th scope="col">Value</th><th scope="col">Share of parent</th></tr></thead>
      <tbody>{drawn.map(node => <tr key={node.id}><th scope="row">{node.path.join(" / ")}</th><td>{formatValue(node.value)}</td><td>{percent.format(share(node, parentOf(node)))}</td></tr>)}</tbody>
    </table></div>}
  </figure>;
}

export default Sunburst;
