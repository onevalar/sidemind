"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion, useTransform, type Transition } from "motion/react";
import { ArrowLeft, ChevronRight } from "lucide-react";
import SegmentedControl from "../../segmented-control/segmented-control";
import { MorphSelect } from "../../morph-select/morph-select";
import { motionTokens } from "../../lib/motion-tokens";
import {
  choroplethCaption, choroplethMetrics, choroplethViewBox,
  type ChoroplethMap, type ChoroplethMetric, type ChoroplethRegion,
} from "./choropleth-explorer-data";
import { choroplethMaps } from "./choropleth-explorer-maps";
import styles from "./choropleth-explorer.module.css";

export type { ChoroplethFormat, ChoroplethMap, ChoroplethMetric, ChoroplethRegion, ChoroplethScale, ChoroplethSubregions } from "./choropleth-explorer-data";

export interface ChoroplethExplorerProps {
  /** Areas to switch between, such as countries. A switch appears when there is more than one. Ignored when regions is set. */
  maps?: ChoroplethMap[];
  /** Id of the area shown first. Defaults to the first one. */
  defaultMap?: string;
  /** Top level regions of a single area. Each has an SVG path in view box units, a value per metric and optional subregions to zoom into. */
  regions?: ChoroplethRegion[];
  /** Metrics in the switch, unless the area brings its own. The first one weights averages for metrics that aggregate as "weighted". */
  metrics?: ChoroplethMetric[];
  /** Id of the metric shown first. Defaults to the first metric. */
  defaultMetric?: string;
  /** Width and height of the view box the region paths are drawn in. */
  viewBox?: [number, number];
  /** Name of the whole area, shown above the map before zooming in. */
  areaName?: string;
  /** Plural noun for top level regions, such as "states". */
  regionNoun?: string;
  title?: string;
  /** Line under the title. Pass an empty string to hide it. */
  description?: string;
  /** Called after the map zooms into a region, with its id, or with null when it zooms back out. */
  onRegionOpen?: (id: string | null) => void;
  /** Called after the metric changes. */
  onMetricChange?: (id: string) => void;
  /** Called after the area changes, with its id. */
  onMapChange?: (id: string) => void;
  className?: string;
}

type Box = [number, number, number, number];
type Tone = "pos" | "neg";
interface Bin { lo: number | null; hi: number | null; tone: Tone; strength: number }
interface Item { region: ChoroplethRegion; value: number | null; bin: number; rank: number; box: Box }
type Level = "top" | "sub";
interface Pointed { level: Level; id: string; source: "map" | "list" }

const { spring, duration, ease } = motionTokens;
const enterEase = [...ease.enter] as [number, number, number, number];
const instant: Transition = { duration: 0 };
/** The camera travels on one critically damped spring: a straight, unhurried move that can be reversed at any point. */
const camera: Transition = { ...spring.smooth, visualDuration: .62 };
const MINUS = "−";
const SEQUENTIAL = [.16, .34, .54, .74, .94];
const POSITIVE = [.2, .42, .66, .9];
const NEGATIVE = [.46, .86];
const EMPTY_BOX: Box = [0, 0, 0, 0];
const NO_REGIONS: ChoroplethRegion[] = [];

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));
const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(" ");

/** Two significant digits, so legend breaks read as round numbers. */
function nice(value: number) {
  if (value === 0) return 0;
  const step = 10 ** (Math.floor(Math.log10(Math.abs(value))) - 1);
  return Math.round(value / step) * step;
}

function quantile(sorted: number[], p: number) {
  if (sorted.length === 0) return 0;
  const at = (sorted.length - 1) * p, lo = Math.floor(at), hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

/** Stepped bins from the values in view: quantile breaks rounded to two significant digits, split at zero when diverging. */
function makeBins(values: number[], metric: ChoroplethMetric): Bin[] {
  const sorted = [...values].sort((a, b) => a - b);
  const unique = (breaks: number[], above = -Infinity) => breaks.map(nice).filter((value, index, all) => value > above && (index === 0 || value > all[index - 1]))
    .filter((value, index, all) => all.indexOf(value) === index);
  const spread = (breaks: number[], strengths: number[], tone: Tone, start: number | null, end: number | null): Bin[] => {
    const edges = [start, ...breaks, end];
    const picks = strengths.length === breaks.length + 1 ? strengths
      : Array.from({ length: breaks.length + 1 }, (_, i) => strengths[Math.round((i / Math.max(1, breaks.length)) * (strengths.length - 1))]);
    return picks.map((strength, i) => ({ lo: edges[i], hi: edges[i + 1], tone, strength }));
  };
  if (metric.scale === "sequential") {
    const breaks = unique([.2, .4, .6, .8].map(p => quantile(sorted, p)));
    return spread(breaks, SEQUENTIAL, "pos", null, null);
  }
  const negative = sorted.filter(value => value < 0), positive = sorted.filter(value => value >= 0);
  const bins: Bin[] = [];
  if (negative.length >= 4) {
    const split = nice(quantile(negative, .5));
    if (split < 0) bins.push({ lo: null, hi: split, tone: "neg", strength: NEGATIVE[1] }, { lo: split, hi: 0, tone: "neg", strength: NEGATIVE[0] });
    else bins.push({ lo: null, hi: 0, tone: "neg", strength: NEGATIVE[1] });
  } else if (negative.length > 0) bins.push({ lo: null, hi: 0, tone: "neg", strength: NEGATIVE[1] });
  const breaks = unique([.25, .5, .75].map(p => quantile(positive, p)), 0);
  return [...bins, ...spread(breaks, POSITIVE, "pos", negative.length > 0 ? 0 : null, null)];
}

const binOf = (bins: Bin[], value: number | null) => value === null ? -1 : bins.findIndex(bin => (bin.lo === null || value >= bin.lo) && (bin.hi === null || value < bin.hi));

/** Full value, for the headline, tooltip and list. */
function format(value: number | null, metric: ChoroplethMetric) {
  if (value === null) return "No accounts";
  if (metric.format === "currency") {
    const size = Math.abs(value), symbol = metric.currency ?? "$";
    if (size >= 1e6) return `${symbol}${(value / 1e6).toFixed(1)}M`;
    if (size >= 1e3) return `${symbol}${Math.round(value / 1e3)}K`;
    return `${symbol}${Math.round(value)}`;
  }
  const text = `${Math.abs(value).toFixed(1)}%`;
  if (metric.format === "change") return Math.abs(value) < .05 ? "0.0%" : `${value < 0 ? MINUS : "+"}${text}`;
  return text;
}

/** Short break labels for the legend. */
function tick(value: number, metric: ChoroplethMetric) {
  const trim = (n: number) => String(Number(n.toFixed(1)));
  const symbol = metric.currency ?? "$";
  if (metric.format === "currency") return Math.abs(value) >= 1e6 ? `${symbol}${trim(value / 1e6)}M` : `${symbol}${trim(value / 1e3)}K`;
  if (metric.format === "change") return value === 0 ? "0%" : `${value < 0 ? MINUS : "+"}${trim(Math.abs(value))}%`;
  return `${trim(value)}%`;
}

function spoken(value: number | null, metric: ChoroplethMetric) {
  return format(value, metric).replace(MINUS, "minus ");
}

/** "counties" to "county", "local authorities" to "local authority". */
const singular = (noun: string) => noun.replace(/ies$/, "y").replace(/s$/, "");

function ordinal(n: number) {
  const tail = n % 100;
  if (tail >= 11 && tail <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

/** Bounding box of path data made of straight segments (M, L, H, V and Z, absolute or relative). */
function pathBox(d: string): Box {
  const tokens = d.match(/[MmLlHhVvZz]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g) ?? [];
  let x = 0, y = 0, sx = 0, sy = 0, cmd = "M", x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const see = () => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
  for (let i = 0; i < tokens.length;) {
    const token = tokens[i];
    if (/[a-z]/i.test(token)) {
      cmd = token; i++;
      if (cmd === "z" || cmd === "Z") { x = sx; y = sy; }
      continue;
    }
    const n = (k: number) => Number(tokens[i + k]);
    const rel = cmd === cmd.toLowerCase();
    if (cmd === "H" || cmd === "h") { x = rel ? x + n(0) : n(0); i += 1; }
    else if (cmd === "V" || cmd === "v") { y = rel ? y + n(0) : n(0); i += 1; }
    else {
      x = rel ? x + n(0) : n(0); y = rel ? y + n(1) : n(1); i += 2;
      if (cmd === "M" || cmd === "m") { sx = x; sy = y; cmd = rel ? "l" : "L"; }
    }
    see();
  }
  return Number.isFinite(x0) ? [x0, y0, x1 - x0, y1 - y0] : EMPTY_BOX;
}

function aggregate(items: Item[], metric: ChoroplethMetric, weightId: string) {
  let sum = 0, weight = 0;
  for (const { region, value } of items) {
    if (value === null) continue;
    if (metric.aggregate === "sum") { sum += value; continue; }
    const w = region.values[weightId] ?? 0;
    sum += value * w; weight += w;
  }
  return metric.aggregate === "sum" ? sum : weight > 0 ? sum / weight : 0;
}

/** Changing text rises into place; reduced motion crossfades. */
function Rise({ text, className }: { text: string; className?: string }) {
  const reduce = useReducedMotion();
  const hidden = reduce ? { opacity: 0 } : { opacity: 0, y: "0.4em" };
  return <span className={cx(styles.rise, className)}>
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span key={text} initial={hidden} animate={{ opacity: 1, y: 0 }} exit={reduce ? { opacity: 0 } : { opacity: 0, y: "-0.4em" }} transition={{ duration: reduce ? duration.instant : duration.standard, ease: enterEase }}>{text}</motion.span>
    </AnimatePresence>
  </span>;
}

/** The headline number counts to each new total on a motion value, without a React render per frame. A new metric jumps: counting from revenue to a percentage would pass through meaningless values. */
function Total({ value, metric, reduce }: { value: number; metric: ChoroplethMetric; reduce: boolean }) {
  const shown = useMotionValue(value);
  const text = useTransform(shown, next => format(next, metric));
  const counted = useRef(metric.id);
  useEffect(() => {
    const sameMetric = counted.current === metric.id;
    counted.current = metric.id;
    if (reduce || !sameMetric) { shown.jump(value); return; }
    const controls = animate(shown, value, { duration: duration.considered, ease: enterEase });
    return () => controls.stop();
  }, [value, metric.id, shown, reduce]);
  return <motion.span className={styles.totalValue}>{text}</motion.span>;
}

export function ChoroplethExplorer({
  maps,
  defaultMap,
  regions: regionsProp,
  metrics: metricsProp,
  defaultMetric,
  viewBox: viewBoxProp,
  areaName: areaNameProp,
  regionNoun: regionNounProp,
  title: titleProp,
  description = choroplethCaption,
  onRegionOpen,
  onMetricChange,
  onMapChange,
  className,
}: ChoroplethExplorerProps) {
  const uid = useId();
  const reduce = useReducedMotion() ?? false;

  const areas = useMemo<ChoroplethMap[]>(() => regionsProp
    ? [{ id: "area", name: areaNameProp ?? "United States", regions: regionsProp, regionNoun: regionNounProp ?? "states" }]
    : maps ?? choroplethMaps, [regionsProp, maps, areaNameProp, regionNounProp]);
  const [mapId, setMapId] = useState(() => areas.find(area => area.id === defaultMap)?.id ?? areas[0]?.id ?? "");
  const area = areas.find(item => item.id === mapId) ?? areas[0];
  /** Set once the area has been switched, so only a new area sweeps in, never the first paint. */
  const [switched, setSwitched] = useState(false);
  const regions = area?.regions ?? NO_REGIONS;
  const metrics = area?.metrics ?? metricsProp ?? choroplethMetrics;
  const [W, H] = area?.viewBox ?? viewBoxProp ?? choroplethViewBox;
  const areaName = areaNameProp ?? area?.name ?? "";
  const regionNoun = regionNounProp ?? area?.regionNoun ?? "regions";
  const title = titleProp ?? area?.title ?? `Revenue by ${singular(regionNoun)}`;
  /** What a region with subregions breaks into, for the panel shown on regions without them. */
  const detailNoun = regions.find(region => region.subregions)?.subregions?.noun ?? null;

  const [metricId, setMetricId] = useState(() => metrics.find(m => m.id === defaultMetric)?.id ?? metrics[0]?.id ?? "");
  const [openId, setOpenId] = useState<string | null>(null);
  /** The last region whose subregions were shown. It stays mounted while they fade out after zooming back. */
  const [hostId, setHostId] = useState<string | null>(null);
  const [pointed, setPointed] = useState<Pointed | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const [binHover, setBinHover] = useState<number | null>(null);
  const [binLock, setBinLock] = useState<number | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [live, setLive] = useState("");

  const metric = metrics.find(m => m.id === metricId) ?? metrics[0];
  const weightId = metrics[0]?.id ?? "";
  const open = regions.find(region => region.id === openId) ?? null;
  const host = regions.find(region => region.id === hostId) ?? null;
  const subs = open?.subregions ?? null;
  const level: Level = subs ? "sub" : "top";

  const topBoxes = useMemo(() => new Map(regions.map(region => [region.id, region.box ?? pathBox(region.path)])), [regions]);
  const hostBoxes = useMemo(() => new Map((host?.subregions?.regions ?? []).map(region => [region.id, region.box ?? pathBox(region.path)])), [host]);

  /** Ranked items for a set of regions under the current metric, with their bins computed from the same set. */
  const rank = useCallback((set: ChoroplethRegion[], boxes: Map<string, Box>) => {
    if (!metric) return { items: [] as Item[], bins: [] as Bin[], byId: new Map<string, Item>() };
    const values = set.map(region => region.values[metric.id] ?? null);
    const bins = makeBins(values.filter((value): value is number => value !== null), metric);
    const items = set.map((region, i) => ({ region, value: values[i], bin: binOf(bins, values[i]), rank: 0, box: boxes.get(region.id) ?? EMPTY_BOX }))
      .sort((a, b) => (a.value === null ? 1 : 0) - (b.value === null ? 1 : 0) || (b.value ?? 0) - (a.value ?? 0) || a.region.name.localeCompare(b.region.name, "en"));
    items.forEach((item, i) => { item.rank = item.value === null ? 0 : i + 1; });
    return { items, bins, byId: new Map(items.map(item => [item.region.id, item])) };
  }, [metric]);

  const top = useMemo(() => rank(regions, topBoxes), [rank, regions, topBoxes]);
  const sub = useMemo(() => rank(host?.subregions?.regions ?? [], hostBoxes), [rank, host, hostBoxes]);
  const view = level === "sub" ? sub : top;
  const listItems = open && !subs ? [] : view.items;
  const bins = view.bins;
  const hasEmpty = view.items.some(item => item.value === null);
  const activeBin = binHover ?? binLock;
  // An open region reports its own value, which is authoritative; the whole area aggregates its regions.
  const total = !metric ? 0 : open ? open.values[metric.id] ?? 0 : aggregate(top.items, metric, weightId);
  const noun = subs?.noun ?? regionNoun;
  const maxAbs = Math.max(1e-9, ...listItems.map(item => Math.abs(item.value ?? 0)));

  // Zooming: one translate and scale on the map group, springed as three motion values and written straight to the DOM.
  const zoomGroup = useRef<SVGGElement | null>(null);
  /** The leaving area unmounts after the new one has mounted, so a detach never clears the live group. */
  const setZoomGroup = useCallback((node: SVGGElement | null) => { if (node) zoomGroup.current = node; }, []);
  const tx = useMotionValue(0), ty = useMotionValue(0), k = useMotionValue(1);
  useEffect(() => {
    const write = () => zoomGroup.current?.setAttribute("transform", `translate(${tx.get()} ${ty.get()}) scale(${k.get()})`);
    const offs = [tx.on("change", write), ty.on("change", write), k.on("change", write)];
    return () => offs.forEach(off => off());
  }, [tx, ty, k]);
  useEffect(() => {
    let target = { x: 0, y: 0, s: 1 };
    const box = open ? topBoxes.get(open.id) : null;
    if (box && box[2] > 0 && box[3] > 0) {
      const s = clamp(Math.min((W * .8) / box[2], (H * .8) / box[3]), 1, 12);
      target = { x: W / 2 - (box[0] + box[2] / 2) * s, y: H / 2 - (box[1] + box[3] / 2) * s, s };
    }
    const move = reduce ? instant : camera;
    const controls = [animate(tx, target.x, move), animate(ty, target.y, move), animate(k, target.s, move)];
    return () => controls.forEach(control => control.stop());
  }, [open, topBoxes, W, H, reduce, tx, ty, k]);

  // Report changes after commit, never while rendering.
  const reportedOpen = useRef<string | null>(null);
  useEffect(() => {
    if (reportedOpen.current === openId) return;
    reportedOpen.current = openId;
    onRegionOpen?.(openId);
  }, [openId, onRegionOpen]);

  const openRegion = (id: string | null) => {
    const target = regions.find(region => region.id === id) ?? null;
    setOpenId(target?.id ?? null);
    if (target?.subregions) setHostId(target.id);
    setPinned(null);
    setBinHover(null);
    setBinLock(null);
    setPointed(null);
    setFocusId(null);
    if (!target) { setLive(`Showing all ${regionNoun}, ranked by ${metric?.label.toLowerCase()}.`); return; }
    const count = target.subregions?.regions.length ?? 0;
    setLive(count > 0
      ? `${target.name}, ${count} ${target.subregions?.noun ?? "areas"} ranked by ${metric?.label.toLowerCase()}. Press Escape to zoom out.`
      : `${target.name}.${detailNoun ? ` No ${singular(detailNoun)} detail.` : ""} Press Escape to zoom out.`);
  };

  const changeMetric = (next: string) => {
    const target = metrics.find(m => m.id === next);
    if (!target) return;
    setMetricId(target.id);
    setBinLock(null);
    setBinHover(null);
    onMetricChange?.(target.id);
    const set = subs?.regions ?? regions;
    const best = [...set].filter(region => region.values[target.id] != null).sort((a, b) => (b.values[target.id] ?? 0) - (a.values[target.id] ?? 0))[0];
    setLive(`Shaded by ${target.label.toLowerCase()}.${best ? ` Highest: ${best.name}, ${spoken(best.values[target.id] ?? null, target)}.` : ""}`);
  };

  const changeMap = (next: string) => {
    const target = areas.find(item => item.id === next);
    if (!target || target.id === area?.id) return;
    const nextMetrics = target.metrics ?? metricsProp ?? choroplethMetrics;
    const nextMetric = nextMetrics.find(m => m.id === metricId) ?? nextMetrics[0];
    setMapId(target.id);
    setSwitched(true);
    if (nextMetric && nextMetric.id !== metricId) setMetricId(nextMetric.id);
    setOpenId(null);
    setHostId(null);
    setPinned(null);
    setBinHover(null);
    setBinLock(null);
    setPointed(null);
    setFocusId(null);
    setTipOn(false);
    setTipFor(null);
    // The new area starts unzoomed; the old one fades out where it was.
    tx.jump(0); ty.jump(0); k.jump(1);
    onMapChange?.(target.id);
    setLive(`${target.name}, ${target.regions.length} ${target.regionNoun} ranked by ${nextMetric?.label.toLowerCase() ?? "value"}.`);
  };

  // Map pointer: one delegated listener. The tooltip follows on motion values; React only hears when the region changes.
  const frame = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const tipX = useMotionValue(0), tipY = useMotionValue(0);
  const [tipOn, setTipOn] = useState(false);
  /** The last region under the pointer. The tooltip keeps showing it while it fades out, so it never collapses to an empty box. */
  const [tipFor, setTipFor] = useState<{ level: Level; id: string } | null>(null);
  const regionAt = (target: EventTarget | null): { level: Level; id: string } | null => {
    const node = (target as Element | null)?.closest?.("[data-rid]");
    if (!node) return null;
    return { level: node.getAttribute("data-level") === "sub" ? "sub" : "top", id: node.getAttribute("data-rid") ?? "" };
  };
  const placeTip = (clientX: number, clientY: number) => {
    const box = frame.current?.getBoundingClientRect();
    if (!box) return;
    const w = tip.current?.offsetWidth ?? 200, h = tip.current?.offsetHeight ?? 100;
    const x = clientX - box.left, y = clientY - box.top, gap = 16;
    tipX.set(x + gap + w > box.width ? Math.max(0, x - gap - w) : x + gap);
    tipY.set(clamp(y - h / 2, 0, Math.max(0, box.height - h)));
  };
  const onMapMove = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") return;
    const hit = regionAt(event.target);
    setPointed(current => (hit ? (current?.id === hit.id && current.level === hit.level && current.source === "map" ? current : { ...hit, source: "map" }) : current?.source === "map" ? null : current));
    setTipOn(!!hit);
    if (hit) {
      setTipFor(current => (current?.id === hit.id && current.level === hit.level ? current : hit));
      placeTip(event.clientX, event.clientY);
    }
  };
  const onMapLeave = () => {
    setTipOn(false);
    setPointed(current => (current?.source === "map" ? null : current));
  };
  const onMapClick = (event: MouseEvent<HTMLDivElement>) => {
    const hit = regionAt(event.target);
    if (!hit) { if (openId) openRegion(null); return; }
    if (hit.level === "top") { if (hit.id !== openId) openRegion(hit.id); return; }
    choosePinned(hit.id);
  };

  const choosePinned = (id: string) => {
    const next = pinned === id ? null : id;
    setPinned(next);
    const item = sub.byId.get(id);
    if (next && item && metric) setLive(`${item.region.name}: ${spoken(item.value, metric)}${item.rank ? `, ${ordinal(item.rank)} of ${sub.items.length}` : ""}.`);
  };

  // Keep the pointed row in view when the pointer is on the map; the list scrolls inside itself, never the page.
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pointed || pointed.source !== "map" || !list.current) return;
    const row = list.current.querySelector<HTMLElement>(`[data-row="${CSS.escape(pointed.id)}"]`);
    if (!row) return;
    const container = list.current, top = row.offsetTop, bottom = top + row.offsetHeight;
    if (top >= container.scrollTop + 8 && bottom <= container.scrollTop + container.clientHeight - 8) return;
    container.scrollTo({ top: Math.max(0, top - container.clientHeight / 2 + row.offsetHeight / 2), behavior: reduce ? "auto" : "smooth" });
  }, [pointed, reduce]);

  // A new level starts at the top of its list.
  useEffect(() => { list.current?.scrollTo({ top: 0 }); }, [openId]);

  // Roving focus through the ranked list: one tab stop, arrows move, Enter opens or pins.
  const rovingId = focusId && listItems.some(item => item.region.id === focusId) ? focusId : listItems[0]?.region.id ?? null;
  const onListKey = (event: KeyboardEvent<HTMLOListElement>) => {
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!keys.includes(event.key) || listItems.length === 0) return;
    event.preventDefault();
    const index = Math.max(0, listItems.findIndex(item => item.region.id === rovingId));
    const next = event.key === "Home" ? 0 : event.key === "End" ? listItems.length - 1 : clamp(index + (event.key === "ArrowDown" ? 1 : -1), 0, listItems.length - 1);
    const id = listItems[next].region.id;
    setFocusId(id);
    list.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(id)}"] button`)?.focus();
  };
  const onRootKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;
    if (binLock !== null) { setBinLock(null); return; }
    if (openId) { event.preventDefault(); openRegion(null); }
  };

  const pointedLevel = pointed?.level ?? null;
  const highlightTop = pointedLevel === "top" ? pointed?.id ?? null : null;
  const highlightSub = pointedLevel === "sub" ? pointed?.id ?? null : null;
  const tipLive = !!pointed && pointed.source === "map";
  const tipItem = tipFor ? (tipFor.level === "sub" ? sub.byId.get(tipFor.id) : top.byId.get(tipFor.id)) : undefined;
  const tipTotal = tipFor?.level === "sub" ? sub.items.length : top.items.length;

  const hostShown = !!host && host.id === openId;
  const subOrigin = host?.subregions?.origin ?? [0, 0, 1];
  const subTransform = `translate(${subOrigin[0]} ${subOrigin[1]}) scale(${subOrigin[2]})`;

  const binLabel = (bin: Bin) => {
    if (!metric) return "";
    if (bin.lo === null && bin.hi !== null) return `below ${tick(bin.hi, metric)}`;
    if (bin.hi === null && bin.lo !== null) return `${tick(bin.lo, metric)} and above`;
    if (bin.lo !== null && bin.hi !== null) return `${tick(bin.lo, metric)} to ${tick(bin.hi, metric)}`;
    return "all values";
  };
  const binCount = (index: number) => view.items.filter(item => item.bin === index).length;
  const legendNote = activeBin === null || !metric
    ? `Shaded by ${metric?.totalLabel.toLowerCase() ?? "value"}`
    : activeBin === -1
      ? `${binCount(-1)} ${noun} with no accounts yet`
      : `${binCount(activeBin)} ${binCount(activeBin) === 1 ? noun.replace(/ies$/, "y").replace(/s$/, "") : noun} ${binLabel(bins[activeBin])}`;

  const fillOf = (item: Item | undefined): CSSProperties => {
    if (!item || item.value === null || item.bin < 0) return { "--fill": "var(--none)", "--alpha": 1 } as CSSProperties;
    const bin = sub.bins[item.bin];
    return { "--fill": bin?.tone === "neg" ? "var(--neg)" : "var(--pos)", "--alpha": bin?.strength ?? .5 } as CSSProperties;
  };
  const topFill = (item: Item | undefined): CSSProperties => {
    if (!item || item.value === null || item.bin < 0) return { "--fill": "var(--none)", "--alpha": 1 } as CSSProperties;
    const bin = top.bins[item.bin];
    return { "--fill": bin?.tone === "neg" ? "var(--neg)" : "var(--pos)", "--alpha": bin?.strength ?? .5 } as CSSProperties;
  };

  const titleId = `${uid}-title`, hintId = `${uid}-hint`, listLabel = `${uid}-list`;

  if (!metric || regions.length === 0) return <section className={cx(styles.root, className)} aria-labelledby={titleId}>
    <div className={styles.inner}><h2 id={titleId} className={styles.title}>{title}</h2><p className={styles.empty}>Add regions with values to shade the map.</p></div>
  </section>;

  return <section className={cx(styles.root, className)} aria-labelledby={titleId} onKeyDown={onRootKey}>
    <div className={styles.inner}>
      <header className={styles.header}>
        <div className={styles.heading}>
          <h2 id={titleId} className={styles.title}><Rise text={title} /></h2>
          {description ? <p>{description}</p> : null}
        </div>
        <div className={styles.controls}>
          {/* The slot fits the longest name, so the trigger springs to each label without moving the row. */}
          {areas.length > 1 && <div className={styles.areaSlot} style={{ "--slot": `${Math.max(...areas.map(item => item.name.length))}ch` } as CSSProperties}><MorphSelect
            label="Country"
            align="end"
            hideLabel
            items={areas.map(item => ({ value: item.id, label: item.name, meta: `${item.regions.length}` }))}
            value={area?.id ?? null}
            onValueChange={changeMap}
            panelWidth={248}
            maxListHeight={360}
            searchable={false}
          /></div>}
          <SegmentedControl className={styles.switch} label="Metric" options={metrics.map(m => ({ value: m.id, label: m.label }))} value={metric.id} onValueChange={changeMetric} />
        </div>
      </header>

      <div className={styles.body}>
        <div className={styles.main}>
          <div className={styles.summary}>
            <div className={styles.place}>
              <p className={styles.placeName}><Rise text={open?.name ?? areaName} /></p>
              <p className={styles.total}>
                <Total value={total} metric={metric} reduce={reduce} />
                <Rise className={styles.totalLabel} text={metric.totalLabel} />
              </p>
            </div>
            <AnimatePresence initial={false}>
              {open && <motion.button
                key="back"
                type="button"
                className={styles.back}
                onClick={() => openRegion(null)}
                initial={{ opacity: 0, x: reduce ? 0 : 8 }}
                animate={{ opacity: 1, x: 0, transition: reduce ? instant : spring.smooth }}
                exit={{ opacity: 0, x: reduce ? 0 : 8, transition: { duration: reduce ? 0 : duration.exit, ease: [...ease.exit] as [number, number, number, number] } }}
              >
                <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
                <span>All {regionNoun}</span>
              </motion.button>}
            </AnimatePresence>
          </div>

          <div
            ref={frame}
            className={styles.frame}
            data-open={open ? "" : undefined}
            data-bin={activeBin !== null ? "" : undefined}
            onPointerMove={onMapMove}
            onPointerLeave={onMapLeave}
            onClick={onMapClick}
          >
            <svg className={styles.map} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Map of ${open?.name ?? areaName} shaded by ${metric.label.toLowerCase()}. The ranked list next to it has every value.`} aria-describedby={hintId}>
              <AnimatePresence initial={false}>
              <motion.g
                key={area?.id ?? "area"}
                ref={setZoomGroup}
                className={styles.area}
                data-enter={switched ? "" : undefined}
                exit={{ opacity: 0, transition: { duration: reduce ? 0 : duration.exit } }}
              >
                <g className={styles.regions}>
                  {regions.map(region => {
                    const item = top.byId.get(region.id);
                    const box = topBoxes.get(region.id) ?? EMPTY_BOX;
                    const isOpen = region.id === openId;
                    const inBin = level === "top" && activeBin !== null ? item?.bin === activeBin : true;
                    return <path
                      key={region.id}
                      d={region.path}
                      className={styles.region}
                      data-rid={region.id}
                      data-level="top"
                      data-hidden={isOpen && !!region.subregions ? "" : undefined}
                      data-context={openId && !isOpen ? "" : undefined}
                      data-dim={!inBin ? "" : undefined}
                      style={{ ...topFill(item), "--wave": (box[0] + box[2] / 2) / W } as CSSProperties}
                    />;
                  })}
                </g>
                {highlightTop && regions.some(region => region.id === highlightTop) &&
                  <path className={styles.outline} d={regions.find(region => region.id === highlightTop)?.path} aria-hidden="true" />}
                {host?.subregions && <g className={styles.subs} transform={subTransform} data-shown={hostShown ? "" : undefined}>
                  {host.subregions.regions.map(region => {
                    const item = sub.byId.get(region.id);
                    const box = hostBoxes.get(region.id) ?? EMPTY_BOX;
                    const inBin = hostShown && activeBin !== null ? item?.bin === activeBin : true;
                    return <path
                      key={region.id}
                      d={region.path}
                      className={styles.region}
                      data-rid={region.id}
                      data-level="sub"
                      data-dim={!inBin ? "" : undefined}
                      style={{ ...fillOf(item), "--wave": (box[0] + box[2] / 2) / 1000 } as CSSProperties}
                    />;
                  })}
                  {pinned && <path className={styles.pinned} d={host.subregions.regions.find(region => region.id === pinned)?.path} aria-hidden="true" />}
                  {highlightSub && <path className={styles.outline} d={host.subregions.regions.find(region => region.id === highlightSub)?.path} aria-hidden="true" />}
                </g>}
              </motion.g>
              </AnimatePresence>
            </svg>

            <motion.div ref={tip} className={styles.tip} data-on={tipOn && tipLive && tipItem ? "" : undefined} style={{ x: tipX, y: tipY }} aria-hidden="true">
              {tipItem && <>
                <p className={styles.tipHead}>
                  <span className={styles.tipName}>{tipItem.region.name}</span>
                  {tipItem.rank > 0 && <span className={styles.tipRank}>{ordinal(tipItem.rank)} of {tipTotal}</span>}
                </p>
                <dl className={styles.tipRows}>
                  {metrics.map(m => <div key={m.id} data-current={m.id === metric.id ? "" : undefined}>
                    <dt>{m.label}</dt>
                    <dd>{format(tipItem.region.values[m.id] ?? null, m)}</dd>
                  </div>)}
                </dl>
                {tipFor?.level === "top" && tipItem.region.id !== openId && <p className={styles.tipHint}>
                  {tipItem.region.subregions ? `Select to see ${tipItem.region.subregions.regions.length} ${tipItem.region.subregions.noun}` : "Select to zoom in"}
                </p>}
              </>}
            </motion.div>
          </div>

          <div className={styles.legend}>
            <div className={styles.steps} role="group" aria-label={`Legend for ${metric.label.toLowerCase()}`}>
              <div className={styles.ramp} style={{ "--bins": bins.length } as CSSProperties}>
                {bins.map((bin, index) => <button
                  key={`${metric.id}-${level}-${index}`}
                  type="button"
                  className={styles.step}
                  aria-pressed={binLock === index}
                  aria-label={`${binCount(index)} ${noun} ${binLabel(bin)}`}
                  data-active={activeBin === index ? "" : undefined}
                  onPointerEnter={event => { if (event.pointerType !== "touch") setBinHover(index); }}
                  onPointerLeave={() => setBinHover(null)}
                  onFocus={() => setBinHover(index)}
                  onBlur={() => setBinHover(null)}
                  onClick={() => setBinLock(current => (current === index ? null : index))}
                >
                  <span className={styles.swatch} style={{ "--fill": bin.tone === "neg" ? "var(--neg)" : "var(--pos)", "--alpha": bin.strength } as CSSProperties} />
                </button>)}
                <span className={styles.ticks} aria-hidden="true">
                  {bins.slice(1).map((bin, index) => bin.lo !== null && <span key={index} style={{ left: `${((index + 1) / bins.length) * 100}%` }}>{tick(bin.lo, metric)}</span>)}
                </span>
              </div>
              {hasEmpty && <button
                type="button"
                className={cx(styles.step, styles.none)}
                aria-pressed={binLock === -1}
                aria-label={`${binCount(-1)} ${noun} with no accounts yet`}
                data-active={activeBin === -1 ? "" : undefined}
                onPointerEnter={event => { if (event.pointerType !== "touch") setBinHover(-1); }}
                onPointerLeave={() => setBinHover(null)}
                onFocus={() => setBinHover(-1)}
                onBlur={() => setBinHover(null)}
                onClick={() => setBinLock(current => (current === -1 ? null : -1))}
              >
                <span className={styles.swatch} style={{ "--fill": "var(--none)", "--alpha": 1 } as CSSProperties} />
                <span className={styles.noneLabel}>No accounts</span>
              </button>}
            </div>
            <p className={styles.legendNote}><Rise text={legendNote} /></p>
          </div>
        </div>

        <aside className={styles.side} aria-labelledby={listLabel}>
          <div className={styles.sideHead}>
            <h3 id={listLabel} className={styles.subhead}><Rise text={open && !subs ? open.name : `${listItems.length} ${noun}`} /></h3>
            <span className={styles.sideMeta}><Rise text={`Ranked by ${metric.label.toLowerCase()}`} /></span>
          </div>
          {/* layoutScroll lets the rows' layout moves account for the list's own scroll offset. */}
          <motion.div ref={list} className={styles.scroller} layoutScroll>
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.div
                key={`${area?.id}:${openId ?? "all"}`}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1, transition: { duration: reduce ? 0 : duration.standard, delay: reduce ? 0 : .12, ease: enterEase } }}
                exit={{ opacity: 0, transition: { duration: reduce ? 0 : duration.exit } }}
              >
                {open && !subs ? <div className={styles.emptyPanel}>
                  <p className={styles.emptyTitle}>{detailNoun ? `No ${singular(detailNoun)} detail for ${open.name}` : open.name}</p>
                  <p className={styles.emptyText}>
                    {detailNoun ? `${singular(detailNoun)[0].toUpperCase()}${singular(detailNoun).slice(1)} data covers the ${regions.filter(region => region.subregions).length} ${regionNoun} with a field team. ` : ""}
                    {open.name} has {format(open.values[metric.id] ?? null, metric)} in {metric.label.toLowerCase()}{top.byId.get(open.id)?.rank ? `, ${ordinal(top.byId.get(open.id)?.rank ?? 0)} of ${top.items.length} ${regionNoun}` : ""}.
                  </p>
                  <button type="button" className={styles.emptyAction} onClick={() => openRegion(null)}>
                    <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
                    Back to all {regionNoun}
                  </button>
                </div> : <ol className={styles.list} onKeyDown={onListKey} aria-labelledby={listLabel}>
                  {listItems.map(item => {
                    const id = item.region.id;
                    const on = (pointed?.id === id && pointed.level === level) || pinned === id;
                    const dim = activeBin !== null && item.bin !== activeBin;
                    const drill = level === "top";
                    const value = format(item.value, metric);
                    const bin = bins[item.bin];
                    return <motion.li
                      key={id}
                      layout="position"
                      transition={reduce ? instant : spring.smooth}
                      data-row={id}
                      className={styles.item}
                      data-dim={dim ? "" : undefined}
                    >
                      <button
                        type="button"
                        className={styles.row}
                        tabIndex={id === rovingId ? 0 : -1}
                        data-on={on ? "" : undefined}
                        aria-pressed={drill ? undefined : pinned === id}
                        aria-label={`${item.rank ? `${ordinal(item.rank)}, ` : ""}${item.region.name}, ${spoken(item.value, metric)}${drill ? item.region.subregions ? `. Open ${item.region.subregions.regions.length} ${item.region.subregions.noun}` : ". Zoom in" : ""}`}
                        onPointerEnter={event => { if (event.pointerType !== "touch") setPointed({ level, id, source: "list" }); }}
                        onPointerLeave={() => setPointed(current => (current?.source === "list" ? null : current))}
                        onFocus={() => { setFocusId(id); setPointed({ level, id, source: "list" }); }}
                        onBlur={() => setPointed(current => (current?.source === "list" && current.id === id ? null : current))}
                        onClick={() => (drill ? openRegion(id) : choosePinned(id))}
                      >
                        <span className={styles.rank}>{item.rank || ""}</span>
                        <span className={styles.name}>{item.region.name}</span>
                        <span className={styles.value}>{value}</span>
                        <span className={styles.bar} aria-hidden="true">
                          <span
                            className={styles.barFill}
                            style={{ transform: `scaleX(${item.value === null ? 0 : Math.max(.015, Math.abs(item.value) / maxAbs)})`, "--fill": bin?.tone === "neg" ? "var(--neg)" : "var(--pos)" } as CSSProperties}
                          />
                        </span>
                        <span className={styles.chevron} aria-hidden="true">{drill && item.region.subregions ? <ChevronRight size={16} strokeWidth={1.75} /> : null}</span>
                      </button>
                    </motion.li>;
                  })}
                </ol>}
              </motion.div>
            </AnimatePresence>
          </motion.div>
        </aside>
      </div>

      <p id={hintId} className={styles.srOnly}>Select a {singular(regionNoun)} on the map or in the ranked list to zoom in. In the list, use the arrow keys to move and Enter to open. Escape zooms back out.</p>
      <p className={styles.srOnly} aria-live="polite">{live}</p>
    </div>
  </section>;
}

export default ChoroplethExplorer;
