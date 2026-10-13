"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties, KeyboardEvent, ReactNode, RefObject } from "react";
import { AnimatePresence, LayoutGroup, animate, motion, useReducedMotion } from "motion/react";
import { ArrowUpRight, Check, ChevronLeft, ChevronRight, X } from "lucide-react";
import { motionTokens } from "../lib/motion-tokens";
import styles from "./orbit-logos.module.css";

export interface OrbitLogo {
  /** Stable key, used by selected and defaultSelected. Defaults to the name. */
  id?: string;
  /** Brand or integration name. */
  name: string;
  /**
   * The mark. A string is either SVG path data on a 24 by 24 viewBox (the Simple Icons format), painted in color, or an
   * image URL for a full color mark. Any ReactNode works too and inherits color as currentColor.
   */
  icon: string | ReactNode;
  /** Brand color for a path or ReactNode mark. Leave it out for black and white brands so the mark follows the text color. */
  color?: string;
  /** Groups logos under a category chip, such as Payments or Dev. */
  category?: string;
  /** One line about what the integration does, shown in the detail card. */
  description?: string;
  /** Starts the integration as connected. */
  connected?: boolean;
  /** Documentation link shown as Docs in the detail card. */
  href?: string;
}

/**
 * An integrations orbit: your product mark at the center with brand logos on two flat rings that turn slowly. The orbit holds
 * still while the pointer or keyboard focus is inside it, category chips turn the matching logos toward the detail side, and
 * choosing a logo springs its ring so it glides to a fixed focus spot, draws an accent connector from the center, and morphs
 * a detail card out of the chip with status, a Connect action, Docs, and previous and next.
 */
export interface OrbitLogosProps {
  logos: readonly OrbitLogo[];
  /** Content of the center disc, such as your product mark. */
  center?: ReactNode;
  /** Called when a logo opens or the card closes (logo is null, index is -1). */
  onSelect?: (logo: OrbitLogo | null, index: number) => void;
  /**
   * Called by the Connect button. Return a promise to hold the connecting state until it settles; a rejected promise shows a
   * retry. Without a promise the card simulates a short connection.
   */
  onConnect?: (logo: OrbitLogo, index: number) => void | Promise<unknown>;
  /** Id (or name) of the logo open on first render. */
  defaultSelected?: string | null;
  /** Controlled id (or name) of the open logo; null closes the card. Pair with onSelect. */
  selected?: string | null;
  /** Multiplies the rotation speed (one turn takes 64s on the inner ring and 88s on the outer ring). 0 holds still. */
  speed?: number;
  /** Holds the orbit still. */
  paused?: boolean;
  /** Label of the first category chip. */
  allLabel?: string;
  /** Accessible name of the logo list. */
  label?: string;
  className?: string;
  style?: CSSProperties;
}

type Status = "idle" | "connecting" | "connected" | "failed";

const subscribe = () => () => {};
function useReducedFlag() {
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);
  return !!useReducedMotion() && hydrated;
}

/** Seconds per turn, inner ring then outer ring. Both turn the same way so the field reads as one calm system. */
const PERIODS = [64, 88];
/** The stacked layout starts below this root width. */
const WIDE = 760;
const PANEL = 352;
const GAP = 48;

const TAU = Math.PI * 2;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** Wraps an angle to -PI..PI so rings always take the short way round. */
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const isUrl = (value: string) => /^(\/|\.|https?:|data:|blob:)/.test(value);
const keyOf = (logo: OrbitLogo) => logo.id ?? logo.name;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function LogoMark({ logo, className }: { logo: OrbitLogo; className: string }) {
  const { icon, color } = logo;
  if (typeof icon === "string") {
    // eslint-disable-next-line @next/next/no-img-element
    if (isUrl(icon)) return <img className={className} src={icon} alt="" draggable={false} />;
    return <svg className={className} viewBox="0 0 24 24" aria-hidden="true"><path d={icon} fill={color ?? "currentColor"} /></svg>;
  }
  return <span className={className} style={color ? { color } : undefined} aria-hidden="true">{icon}</span>;
}

const DefaultMark = () => <svg viewBox="0 0 32 32" width="46%" height="46%" aria-hidden="true">
  <circle cx="16" cy="16" r="5" fill="currentColor" />
  <circle cx="16" cy="16" r="11.5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeDasharray="4 3.2" />
</svg>;

export function OrbitLogos({
  logos,
  center,
  onSelect,
  onConnect,
  defaultSelected = null,
  selected: selectedProp,
  speed = 1,
  paused = false,
  allLabel = "All",
  label = "Integrations",
  className,
  style,
}: OrbitLogosProps) {
  const reduced = useReducedFlag();
  const uid = useId();
  const root = useRef<HTMLDivElement>(null);
  const chips = useRef<(HTMLButtonElement | null)[]>([]);
  const connector = useRef<SVGLineElement>(null);
  const [width, setWidth] = useState(0);
  const [category, setCategory] = useState<string | null>(null);
  const [inner, setInner] = useState(defaultSelected);
  const selectedKey = selectedProp !== undefined ? selectedProp : inner;
  const selectedIndex = selectedKey == null ? -1 : logos.findIndex(logo => keyOf(logo) === selectedKey);
  const [cursor, setCursor] = useState(0);
  const [hovering, setHovering] = useState(false);
  const [focused, setFocused] = useState(false);
  const [statuses, setStatuses] = useState<Record<string, Status>>({});
  const [step, setStep] = useState(0);
  const statusOf = useCallback((logo: OrbitLogo): Status => statuses[keyOf(logo)] ?? (logo.connected ? "connected" : "idle"), [statuses]);

  const categories = useMemo(() => {
    const list: string[] = [];
    for (const logo of logos) if (logo.category && !list.includes(logo.category)) list.push(logo.category);
    return list;
  }, [logos]);
  const matches = useCallback((logo: OrbitLogo) => category === null || logo.category === category, [category]);
  /** Logos that arrows, previous, and next step through: the chosen category, or every logo. */
  const visible = useMemo(() => logos.map((logo, i) => (matches(logo) ? i : -1)).filter(i => i >= 0), [logos, matches]);

  const wide = width >= WIDE;
  /** Wide layouts park the chosen logo on the right, beside the card; stacked layouts park it at the bottom, above the card. */
  const focusAngle = wide ? 0 : Math.PI / 2;

  const geometry = useMemo(() => {
    const size = Math.max(0, Math.floor(wide ? Math.min(520, width - PANEL - GAP) : Math.min(width, 460)));
    const tile = Math.round(clamp(size * .112, 40, 56));
    const core = Math.round(tile * 1.5);
    const outer = size / 2 - tile / 2 - 2;
    /** The rings stay at least a tile and a gap apart, so an inner chip never touches an outer one on a narrow stage. */
    const innerR = Math.min(outer - tile - 8, Math.max(core / 2 + tile / 2 + 20, outer * .57));
    const cap = (r: number) => Math.max(1, Math.floor((TAU * r) / (tile + 14)));
    const n = logos.length;
    let first = n < 2 ? n : clamp(Math.round((n * innerR) / (innerR + outer)), 1, cap(innerR));
    first = Math.max(first, n - cap(outer));
    const counts = [first, n - first];
    const slots = logos.map((_, i) => {
      const ring = i < first ? 0 : 1, j = ring ? i - first : i, count = counts[ring];
      return { ring, base: -Math.PI / 2 + (ring ? Math.PI / count : 0) + (j / Math.max(1, count)) * TAU };
    });
    return { size, tile, core, radii: [innerR, outer], slots, c: size / 2 };
  }, [width, wide, logos]);

  const sim = useRef({ theta: [0, 0], vel: [0, 0], goal: [NaN, NaN], rate: 0, rateV: 0, reach: 0, reachV: 0, linkTo: -1, frame: 0, running: false, visible: true });
  const hold = paused || reduced || speed === 0 || hovering || focused || selectedIndex >= 0 || category !== null;
  const live = useRef({ geometry, hold, speed, reduced, selectedIndex });
  useLayoutEffect(() => { live.current = { geometry, hold, speed, reduced, selectedIndex }; });

  const paint = useCallback(() => {
    const s = sim.current, { geometry: g } = live.current;
    if (!g.size) return;
    let lx = 0, ly = 0;
    g.slots.forEach((slot, i) => {
      const node = chips.current[i];
      const a = slot.base + s.theta[slot.ring], r = g.radii[slot.ring];
      const x = g.c + r * Math.cos(a), y = g.c + r * Math.sin(a);
      if (node) {
        node.style.transform = `translate3d(${(x - g.tile / 2).toFixed(2)}px, ${(y - g.tile / 2).toFixed(2)}px, 0)`;
        /** The name tag sits on the outer side of the ring, above for the top half and below for the bottom half. */
        const side = Math.sin(a) < 0 ? "above" : "below";
        if (node.dataset.tag !== side) node.dataset.tag = side;
      }
      if (i === s.linkTo) { lx = x; ly = y; }
    });
    /** The connector runs from the edge of the center disc to the edge of the chosen chip and draws out on a spring. */
    const line = connector.current;
    if (line) {
      const dx = lx - g.c, dy = ly - g.c, dist = Math.hypot(dx, dy) || 1;
      const start = g.core / 2 + 6, end = dist - g.tile / 2 - 6;
      const reach = clamp(s.reach, 0, 1.08);
      const visibleLine = s.linkTo >= 0 && end > start && reach > .002;
      line.style.opacity = visibleLine ? clamp(s.reach * 1.6, 0, 1).toFixed(3) : "0";
      if (visibleLine) {
        const ux = dx / dist, uy = dy / dist, stop = start + (end - start) * reach;
        line.setAttribute("x1", (g.c + ux * start).toFixed(2));
        line.setAttribute("y1", (g.c + uy * start).toFixed(2));
        line.setAttribute("x2", (g.c + ux * stop).toFixed(2));
        line.setAttribute("y2", (g.c + uy * stop).toFixed(2));
      }
    }
  }, []);

  const loop = useCallback(() => {
    const s = sim.current;
    if (s.running || !s.visible) return;
    s.running = true;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = clamp((now - last) / 1000, 0, .05);
      last = now;
      const { hold: still, speed: rate, reduced: instant, selectedIndex: current } = live.current;
      /** Pausing eases the turn to rest on a critically damped spring, so nothing jolts under the pointer. */
      const target = still ? 0 : rate;
      s.rateV += (60 * (target - s.rate) - 2 * Math.sqrt(60) * s.rateV) * dt;
      s.rate += s.rateV * dt;
      let moving = Math.abs(target - s.rate) > .0005 || Math.abs(s.rateV) > .0005 || Math.abs(s.rate) > .0005;
      for (let k = 0; k < 2; k++) {
        const goal = s.goal[k];
        if (Number.isNaN(goal)) {
          s.vel[k] = 0;
          s.theta[k] += (TAU / PERIODS[k]) * s.rate * dt;
        } else if (instant) {
          s.theta[k] = goal; s.vel[k] = 0;
        } else {
          /** A spring with a touch of overshoot, so a ring glides and settles instead of snapping. */
          s.vel[k] += (120 * (goal - s.theta[k]) - 17 * s.vel[k]) * dt;
          s.theta[k] += s.vel[k] * dt;
          if (Math.abs(goal - s.theta[k]) > .0004 || Math.abs(s.vel[k]) > .0004) moving = true;
          else { s.theta[k] = goal; s.vel[k] = 0; }
        }
      }
      /** The connector retracts before it hands over to another logo. */
      if (current >= 0 && (instant || s.linkTo < 0 || s.reach < .04)) s.linkTo = current;
      const reachGoal = current >= 0 && current === s.linkTo ? 1 : 0;
      if (instant) { s.reach = reachGoal; s.reachV = 0; s.rate = 0; s.rateV = 0; }
      else {
        s.reachV += (200 * (reachGoal - s.reach) - 24 * s.reachV) * dt;
        s.reach += s.reachV * dt;
      }
      if (Math.abs(reachGoal - s.reach) > .002 || Math.abs(s.reachV) > .002 || (current >= 0 && current !== s.linkTo)) moving = true;
      if (current < 0 && s.reach < .002) s.linkTo = -1;
      if (instant) moving = false;
      paint();
      if (!moving || !s.visible) { s.running = false; return; }
      s.frame = requestAnimationFrame(tick);
    };
    s.frame = requestAnimationFrame(tick);
  }, [paint]);

  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    const measure = () => setWidth(node.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  /**
   * Aims the rings. An open logo turns its ring the short way to the focus spot. A category turns each ring so the mean
   * direction of its matching logos faces the focus side. Otherwise the rings keep their angle and resume turning.
   */
  useLayoutEffect(() => {
    const s = sim.current, { slots } = geometry;
    const aim = (k: number) => {
      if (selectedIndex >= 0 && slots[selectedIndex]) {
        const slot = slots[selectedIndex];
        if (slot.ring === k) return s.theta[k] + wrap(focusAngle - (slot.base + s.theta[k]));
        /** An outer logo parks behind the inner ring, so the inner ring steps aside to keep the connector clear. */
        if (k === 0 && slot.ring === 1) {
          const own = slots.filter(other => other.ring === 0);
          const clearance = (geometry.tile + 10) / geometry.radii[0];
          let near = NaN, gap = Infinity;
          for (const other of own) {
            const d = wrap(other.base + s.theta[0] - focusAngle);
            if (Math.abs(d) < Math.abs(gap)) { gap = d; near = other.base + s.theta[0]; }
          }
          if (!Number.isNaN(near) && Math.abs(gap) < clearance) {
            const half = own.length > 1 ? Math.PI / own.length : Math.PI;
            return s.theta[0] + wrap(focusAngle + (gap >= 0 ? half : -half) - near);
          }
        }
      }
      if (category === null) return NaN;
      let sx = 0, sy = 0;
      slots.forEach((slot, i) => {
        if (slot.ring !== k || logos[i]?.category !== category) return;
        sx += Math.cos(slot.base + s.theta[k]); sy += Math.sin(slot.base + s.theta[k]);
      });
      if (Math.hypot(sx, sy) < 1e-3) return NaN;
      return s.theta[k] + wrap(focusAngle - Math.atan2(sy, sx));
    };
    s.goal = [aim(0), aim(1)];
  }, [selectedIndex, category, geometry, focusAngle, logos]);

  /** Repaint on layout and restart the loop whenever something that moves things changes. */
  useLayoutEffect(() => { paint(); loop(); }, [geometry, hold, speed, reduced, selectedIndex, category, focusAngle, paint, loop]);

  useEffect(() => {
    const node = root.current, s = sim.current;
    if (!node) return;
    const observer = new IntersectionObserver(([entry]) => {
      s.visible = entry.isIntersecting && !document.hidden;
      if (s.visible) loop(); else { cancelAnimationFrame(s.frame); s.running = false; }
    });
    const onVisibility = () => { s.visible = !document.hidden; if (s.visible) loop(); };
    observer.observe(node);
    document.addEventListener("visibilitychange", onVisibility);
    return () => { observer.disconnect(); document.removeEventListener("visibilitychange", onVisibility); cancelAnimationFrame(s.frame); s.running = false; };
  }, [loop]);

  const choose = useCallback((index: number, direction = 0) => {
    const logo = index >= 0 ? logos[index] : undefined;
    const key = logo ? keyOf(logo) : null;
    setStep(direction);
    if (selectedProp === undefined) setInner(key);
    if (index >= 0) setCursor(index);
    onSelect?.(logo ?? null, logo ? index : -1);
  }, [logos, onSelect, selectedProp]);

  /** The next or previous logo in the current category, in list order, wrapping at the ends. */
  const neighbor = useCallback((from: number, direction: 1 | -1) => {
    if (!visible.length) return from;
    if (direction > 0) return visible.find(i => i > from) ?? visible[0];
    return [...visible].reverse().find(i => i < from) ?? visible[visible.length - 1];
  }, [visible]);

  const stepTo = useCallback((direction: 1 | -1) => {
    const next = neighbor(selectedIndex, direction);
    if (next !== selectedIndex) choose(next, direction);
  }, [neighbor, selectedIndex, choose]);

  const pickCategory = (next: string | null) => {
    setCategory(next);
    const current = logos[selectedIndex];
    if (current && next !== null && current.category !== next) choose(-1);
    const first = logos.findIndex(logo => next === null || logo.category === next);
    if (first >= 0) setCursor(first);
  };

  const onChipKey = (event: KeyboardEvent<HTMLButtonElement>, i: number) => {
    let next = -1;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = neighbor(i, 1);
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = neighbor(i, -1);
    else if (event.key === "Home") next = visible[0] ?? -1;
    else if (event.key === "End") next = visible[visible.length - 1] ?? -1;
    else if (event.key === "Escape" && selectedIndex >= 0) { event.preventDefault(); choose(-1); return; }
    if (next < 0) return;
    event.preventDefault();
    setCursor(next);
    chips.current[next]?.focus();
    /** With a card open, arrows step the card too, and the ring follows. */
    if (selectedIndex >= 0) choose(next, event.key === "ArrowLeft" || event.key === "ArrowUp" || event.key === "Home" ? -1 : 1);
  };

  const connect = async (index: number) => {
    const logo = logos[index];
    if (!logo) return;
    const key = keyOf(logo);
    setStatuses(current => ({ ...current, [key]: "connecting" }));
    try {
      const result = onConnect?.(logo, index);
      await (result instanceof Promise ? result : wait(1400));
      setStatuses(current => ({ ...current, [key]: "connected" }));
    } catch {
      setStatuses(current => ({ ...current, [key]: "failed" }));
    }
  };

  const closeCard = () => {
    const index = selectedIndex;
    choose(-1);
    if (index >= 0) chips.current[index]?.focus();
  };

  const tabStop = visible.includes(cursor) ? cursor : visible[0] ?? 0;
  const connectedCount = logos.filter(logo => statusOf(logo) === "connected").length;
  const scope = category === null ? logos : logos.filter(logo => logo.category === category);
  const open = logos[selectedIndex];
  const { size, tile, core, radii, c } = geometry;
  const selectedRing = open ? geometry.slots[selectedIndex]?.ring : undefined;
  const announce = open ? `${open.name} open${open.description ? `, ${open.description}` : ""}` : category ? `${scope.length} in ${category}` : "";

  return <div
    ref={root}
    className={[styles.root, className].filter(Boolean).join(" ")}
    data-layout={wide ? "wide" : "stack"}
    data-ready={width > 0 || undefined}
    style={style}
    onPointerEnter={event => { if (event.pointerType === "mouse") setHovering(true); }}
    onPointerLeave={() => setHovering(false)}
    onFocus={() => setFocused(true)}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false); }}
  >
    {categories.length > 0 && <LayoutGroup id={`${uid}-categories`}>
      <div className={styles.categories} role="toolbar" aria-label="Filter by category">
        {[null, ...categories].map(name => {
          const on = category === name;
          return <button key={name ?? "all"} type="button" className={styles.category} aria-pressed={on} data-on={on || undefined} onClick={() => pickCategory(name)}>
            {on && <motion.span layoutId="pill" className={styles.pill} transition={reduced ? { duration: 0 } : motionTokens.spring.morph} />}
            <span className={styles.categoryLabel}>{name ?? allLabel}</span>
          </button>;
        })}
      </div>
    </LayoutGroup>}

    <div className={styles.body}>
      <div className={styles.stage} style={{ width: size || undefined, height: size || undefined, "--tile": `${tile}px`, "--core": `${core}px` } as CSSProperties}>
        {size > 0 && <svg className={styles.rings} width={size} height={size} aria-hidden="true">
          {radii.map((r, k) => <circle key={k} cx={c} cy={c} r={r} data-active={selectedRing === k || undefined} />)}
          <line ref={connector} className={styles.connector} x1={c} y1={c} x2={c} y2={c} />
        </svg>}
        <div className={styles.core} data-active={open ? true : undefined} style={{ left: c - core / 2, top: c - core / 2 }}>
          {center ?? <DefaultMark />}
        </div>
        <ul className={styles.list} aria-label={label}>
          {logos.map((logo, i) => {
            const status = statusOf(logo);
            return <li key={keyOf(logo)} className={styles.slot}>
              <button
                ref={node => { chips.current[i] = node; }}
                type="button"
                className={styles.chip}
                tabIndex={i === tabStop ? 0 : -1}
                aria-pressed={i === selectedIndex}
                aria-label={`${logo.name}${logo.category ? `, ${logo.category}` : ""}${status === "connected" ? ", connected" : ""}`}
                data-selected={i === selectedIndex || undefined}
                data-dim={(!matches(logo) && i !== selectedIndex) || undefined}
                data-match={(category !== null && matches(logo)) || undefined}
                data-hidden={size === 0 || undefined}
                onClick={() => choose(i === selectedIndex ? -1 : i, 0)}
                onFocus={() => setCursor(i)}
                onKeyDown={event => onChipKey(event, i)}
              >
                <span className={styles.face}>
                  <LogoMark logo={logo} className={styles.mark} />
                  {status === "connected" && <span className={styles.dot} aria-hidden="true" />}
                </span>
                <span className={styles.tag} aria-hidden="true">{logo.name}</span>
              </button>
            </li>;
          })}
        </ul>
      </div>

      <div className={styles.panel}>
        <AnimatePresence initial={false}>
          {open
            ? <DetailCard
              key="card"
              logo={open}
              index={selectedIndex}
              status={statusOf(open)}
              step={step}
              reduced={reduced}
              origin={chips}
              onPrev={() => stepTo(-1)}
              onNext={() => stepTo(1)}
              canStep={visible.length > 1 || !visible.includes(selectedIndex)}
              onClose={closeCard}
              onConnect={() => connect(selectedIndex)}
            />
            : <motion.div
              key="idle"
              className={styles.idle}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: { duration: motionTokens.duration.standard, delay: reduced ? 0 : .08 } }}
              exit={{ opacity: 0, transition: { duration: reduced ? 0 : motionTokens.duration.fast } }}
            >
              <p className={styles.idleTitle}>{category ?? label}</p>
              <p className={styles.idleMeta}>
                <span className={styles.num}>{scope.length}</span> {scope.length === 1 ? "integration" : "integrations"}, <span className={styles.num}>{scope.filter(logo => statusOf(logo) === "connected").length}</span> connected
              </p>
              <p className={styles.idleHint}>Pick a logo to see what it does and connect it.<span className={styles.keysHint}> Arrow keys step through them.</span></p>
              <span className={styles.srOnly}>{connectedCount} of {logos.length} connected in total</span>
            </motion.div>}
        </AnimatePresence>
      </div>
    </div>
    <p className={styles.srOnly} aria-live="polite">{announce}</p>
  </div>;
}

interface DetailCardProps {
  logo: OrbitLogo;
  index: number;
  status: Status;
  step: number;
  reduced: boolean;
  origin: RefObject<(HTMLButtonElement | null)[]>;
  canStep: boolean;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
  onConnect: () => void;
}

function DetailCard({ logo, index, status, step, reduced, origin, canStep, onPrev, onNext, onClose, onConnect }: DetailCardProps) {
  const shell = useRef<HTMLSpanElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const openedFrom = useRef(index);

  /**
   * The card morphs out of the chip it opened from: only its shell (border, fill, shadow) starts at the chip's box as a circle
   * and springs to its own box. The content never scales; it fades in at its final spot once the shape has mostly formed.
   */
  useLayoutEffect(() => {
    const node = shell.current, content = body.current, chip = origin.current?.[openedFrom.current];
    if (!node || !content || !chip || reduced) return;
    const a = chip.getBoundingClientRect(), b = node.getBoundingClientRect();
    if (!b.width || !b.height) return;
    const morph = animate(node, {
      x: [a.left - b.left, 0],
      y: [a.top - b.top, 0],
      scaleX: [a.width / b.width, 1],
      scaleY: [a.height / b.height, 1],
      borderRadius: [`${b.width / 2}px / ${b.height / 2}px`, "22px / 22px"],
      opacity: [.4, 1],
    }, { ...motionTokens.spring.morph, opacity: { duration: motionTokens.duration.fast } });
    const reveal = animate(content, { opacity: [0, 1] }, { duration: motionTokens.duration.standard, ease: [...motionTokens.ease.enter], delay: .14 });
    return () => { morph.stop(); reveal.stop(); };
  }, [origin, reduced]);

  const key = keyOf(logo);
  const statusText = status === "connected" ? "Connected" : status === "connecting" ? "Connecting" : status === "failed" ? "Couldn't connect" : "Not connected";

  return <motion.div
    className={styles.card}
    role="region"
    aria-label={`${logo.name} details`}
    exit={{ opacity: 0, scale: .97, transition: reduced ? { duration: 0 } : { duration: motionTokens.duration.exit, ease: [...motionTokens.ease.standard] } }}
    onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); onClose(); } }}
  >
    <span ref={shell} className={styles.cardShell} aria-hidden="true" />
    <div ref={body} className={styles.cardBody}>
      <AnimatePresence mode="popLayout" initial={false} custom={step}>
        <motion.div
          key={key}
          className={styles.cardContent}
          custom={step}
          variants={{
            enter: (dir: number) => ({ opacity: 0, x: reduced ? 0 : dir * 16 }),
            center: { opacity: 1, x: 0 },
            leave: (dir: number) => ({ opacity: 0, x: reduced ? 0 : dir * -16 }),
          }}
          initial="enter"
          animate="center"
          exit="leave"
          transition={reduced ? { duration: 0 } : { ...motionTokens.spring.smooth, opacity: { duration: motionTokens.duration.standard, delay: step === 0 ? .1 : 0 } }}
        >
          <div className={styles.cardHead}>
            <span className={styles.cardMark}><LogoMark logo={logo} className={styles.mark} /></span>
            <div className={styles.cardTitle}>
              <p className={styles.cardName}>{logo.name}</p>
              {logo.category && <p className={styles.cardCategory}>{logo.category}</p>}
            </div>
          </div>
          <p className={styles.cardText}>{logo.description ?? "Connects to your workspace."}</p>
          <div className={styles.cardFoot}>
            <span className={styles.status} data-status={status}>
              {status === "connected" ? <Check className={styles.statusIcon} size={14} strokeWidth={2} aria-hidden="true" /> : <span className={styles.statusDot} aria-hidden="true" />}
              {statusText}
            </span>
            <span className={styles.actions}>
              {logo.href && <a className={styles.docs} href={logo.href} target="_blank" rel="noreferrer noopener">
                Docs<ArrowUpRight size={14} strokeWidth={1.75} aria-hidden="true" />
              </a>}
              {status !== "connected" && <button type="button" className={styles.connect} disabled={status === "connecting"} onClick={onConnect}>
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.span
                    key={status === "connecting" ? "busy" : "idle"}
                    className={styles.connectLabel}
                    initial={{ opacity: 0, y: reduced ? 0 : 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: reduced ? 0 : -6 }}
                    transition={reduced ? { duration: 0 } : motionTokens.spring.snappy}
                  >
                    {status === "connecting" ? <><span className={styles.spinner} aria-hidden="true" /><span className={styles.srOnly}>Connecting</span></> : status === "failed" ? "Try again" : "Connect"}
                  </motion.span>
                </AnimatePresence>
              </button>}
            </span>
          </div>
        </motion.div>
      </AnimatePresence>
      <div className={styles.cardNav}>
        <button type="button" className={styles.iconButton} aria-label="Previous integration" disabled={!canStep} onClick={onPrev}><ChevronLeft size={16} strokeWidth={1.75} /></button>
        <button type="button" className={styles.iconButton} aria-label="Next integration" disabled={!canStep} onClick={onNext}><ChevronRight size={16} strokeWidth={1.75} /></button>
        <button type="button" className={styles.iconButton} aria-label="Close" onClick={onClose}><X size={16} strokeWidth={1.75} /></button>
      </div>
    </div>
  </motion.div>;
}

export default OrbitLogos;
