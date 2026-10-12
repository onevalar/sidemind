"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { AnimatePresence, LayoutGroup, animate, motion, useIsPresent, useMotionValue, useReducedMotion } from "motion/react";
import type { AnimationPlaybackControls, MotionValue, TargetAndTransition } from "motion/react";
import { Check, Plus, RotateCw, TriangleAlert } from "lucide-react";
import { Avatar } from "../../avatar/avatar";
import { Badge } from "../../badge/badge";
import { Button } from "../../button/button";
import { Checkbox } from "../../checkbox/checkbox";
import { CopyButton } from "../../copy-button/copy-button";
import { Input } from "../../input/input";
import { motionTokens } from "../../lib/motion-tokens";
import { SLOTS, clockAfter, currentUser, eventOptions, failed, headersFor, payloadFor, phrases, sampleEndpoints, secretFor, seriesFor, slotLabel, testObjects, tokenFrom } from "./webhooks-data";
import type { Delivery, Endpoint, EventType } from "./webhooks-data";
import styles from "./webhooks.module.css";

/**
 * A webhooks console. Endpoints list their events and a delivery rate that rolls; the selected one shows 24 hours of events as a bar strip,
 * its recent deliveries, and an inspector for the request body and headers. Retrying a failed delivery morphs the button through Sending, a new
 * 200 attempt slides in at the top, the failed sliver in the chart melts into the bar, and the rate rolls up. "Add endpoint" grows into its own
 * form and reveals the signing secret once. Everything is simulated and deterministic.
 */

type Tab = "payload" | "headers";
const easeEnter = [...motionTokens.ease.enter] as [number, number, number, number];
const easeStandard = [...motionTokens.ease.standard] as [number, number, number, number];
const instant = { duration: 0 };
const rest: TargetAndTransition = { opacity: 1, y: "0em", filter: "blur(0px)" };
const rise: TargetAndTransition = { opacity: 0, y: "0.35em", filter: `blur(${motionTokens.blur.soft}px)` };
const lift: TargetAndTransition = { opacity: 0, y: "-0.3em", filter: `blur(${motionTokens.blur.subtle}px)`, transition: { duration: motionTokens.duration.fast, ease: easeStandard } };
const roll = {
  enter: (direction: number) => ({ opacity: 0, y: `${direction * .6}em`, filter: `blur(${motionTokens.blur.subtle}px)` }),
  center: { opacity: 1, y: "0em", filter: "blur(0px)" },
  exit: (direction: number) => ({ opacity: 0, y: `${direction * -.6}em`, filter: `blur(${motionTokens.blur.subtle}px)` }),
};
/** Rows open from zero height and clip only while they move, so a highlight gliding in from a neighbour is never cut off. */
const grow = (reduced: boolean) => ({
  initial: reduced ? { opacity: 0 } : { opacity: 0, height: 0, overflow: "hidden" },
  animate: { opacity: 1, height: "auto", transitionEnd: { overflow: "visible" } },
  exit: reduced ? { opacity: 0, transition: instant } : { opacity: 0, height: 0, overflow: "hidden", transition: { height: motionTokens.spring.smooth, opacity: { duration: motionTokens.duration.fast } } },
  transition: reduced ? instant : { height: motionTokens.spring.smooth, opacity: { duration: motionTokens.duration.standard, ease: easeEnter, delay: .08 } },
});

const count = new Intl.NumberFormat("en-US");
const hostOf = (url: string) => url.replace(/^https:\/\//, "").split("/")[0];
const pathOf = (url: string) => url.replace(/^https:\/\/[^/]+/, "");
const latencyText = (ms: number) => ms >= 10000 ? `${(ms / 1000).toFixed(1)} s` : `${count.format(ms)} ms`;
/** Floored, so an endpoint that still has a failure never reads 100.0%. */
const rateOf = (total: number, failing: number) => total ? Math.floor(((total - failing) / total) * 1000) / 10 : 0;
const rateText = (total: number, failing: number) => total ? `${rateOf(total, failing).toFixed(1)}%` : "–";
const pickFor = (endpoint: Endpoint) => (endpoint.deliveries.find(failed) ?? endpoint.deliveries[0])?.id;
const ticks = [{ slot: 0, label: "15:00" }, { slot: 12, label: "21:00" }, { slot: 24, label: "03:00" }, { slot: 36, label: "09:00" }];
const urlPattern = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/\S*)?$/i;

/** Changing words rise out of a soft blur; the leaving copy is hidden from assistive tech while it fades. */
function SwapText({ text, reduced, wrap = false }: { text: string; reduced: boolean; wrap?: boolean }) {
  return <span className={wrap ? styles.swapBlock : styles.swap}><AnimatePresence mode="popLayout" initial={false}><SwapWord key={text} text={text} reduced={reduced} wrap={wrap} /></AnimatePresence></span>;
}
function SwapWord({ text, reduced, wrap }: { text: string; reduced: boolean; wrap: boolean }) {
  const present = useIsPresent();
  return <motion.span className={wrap ? styles.swapWrap : styles.swapText} aria-hidden={present ? undefined : true} initial={reduced ? { opacity: 0 } : rise} animate={rest} exit={reduced ? { opacity: 0, transition: instant } : lift} transition={reduced ? instant : { duration: motionTokens.duration.standard, ease: easeEnter }}>{text}</motion.span>;
}

/** Each character keeps its place from the right, so only digits that change roll, lowest place first, up when the value rises. */
function Roll({ text, value, reduced }: { text: string; value: number; reduced: boolean }) {
  const [shown, setShown] = useState({ value, direction: 1 });
  if (shown.value !== value) setShown({ value, direction: value > shown.value ? 1 : -1 });
  const chars = [...text];
  return <span className={styles.roll} aria-hidden="true">{chars.map((char, index) => {
    const place = chars.length - index, delay = Math.min(place - 1, 4) * .03;
    return <span key={place} className={styles.rollSlot}><AnimatePresence mode="popLayout" initial={false} custom={shown.direction}>
      <motion.span key={char} custom={shown.direction} variants={roll} initial={reduced ? false : "enter"} animate="center" exit={reduced ? undefined : "exit"}
        transition={reduced ? instant : { y: { ...motionTokens.spring.snappy, delay }, opacity: { duration: motionTokens.duration.fast, delay }, filter: { duration: motionTokens.duration.fast, delay } }}>{char}</motion.span>
    </AnimatePresence></span>;
  })}</span>;
}

/** Arrow keys, Home, and End move through a list of rows and select the row they land on. */
function moveIn(event: ReactKeyboardEvent<HTMLElement>, attribute: string, select: (id: string) => void) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(`[${attribute}]`));
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  if (index < 0) return;
  event.preventDefault();
  const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : Math.min(buttons.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)));
  buttons[next].focus();
  select(buttons[next].getAttribute(attribute) ?? "");
}

/**
 * Sizes the add shell with real width and height, so nothing inside is ever stretched. The button's width and the toolbar's width are measured;
 * opening springs from one to the other while the height follows the panel's content. Changes the person caused animate; later reflows follow at once.
 */
function useShellSize(open: boolean, reduced: boolean) {
  const width = useMotionValue<number | "auto">("auto");
  const height = useMotionValue<number | "auto">("auto");
  const [size, setSize] = useState({ track: 0, face: 0, row: 0, inner: 0 });
  const trackRef = useRef<HTMLDivElement>(null);
  const faceRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const openRef = useRef(open);
  const armedUntil = useRef(0);
  const running = useRef<{ width?: AnimationPlaybackControls; height?: AnimationPlaybackControls }>({});

  useLayoutEffect(() => { openRef.current = open; }, [open]);
  useEffect(() => {
    const track = trackRef.current, face = faceRef.current, inner = innerRef.current;
    if (!track || !face || !inner || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setSize(current => {
      const next = { track: track.getBoundingClientRect().width, face: openRef.current && current.face ? current.face : face.getBoundingClientRect().width, row: face.offsetHeight, inner: inner.getBoundingClientRect().height };
      return next.track === current.track && next.face === current.face && next.row === current.row && next.inner === current.inner ? current : next;
    }));
    [track, face, inner].forEach(node => observer.observe(node));
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!size.track || !size.face || !size.row) return;
    const moving = !reduced && performance.now() < armedUntil.current;
    const to = (value: MotionValue<number | "auto">, target: number, key: "width" | "height") => {
      const from = value.get();
      running.current[key]?.stop();
      if (!moving || typeof from !== "number") value.jump(target);
      else if (Math.abs(from - target) > .5) running.current[key] = animate(value, target, motionTokens.spring.smooth);
    };
    to(width, open ? size.track : size.face, "width");
    to(height, open ? Math.max(size.inner, size.row) : size.row, "height");
  }, [open, size, reduced, width, height]);
  useEffect(() => () => { running.current.width?.stop(); running.current.height?.stop(); }, []);

  const arm = () => { armedUntil.current = performance.now() + 900; };
  return { width, height, trackRef, faceRef, innerRef, arm };
}

/** The detail follows its content's height. A switch the person made springs; rows growing inside it are already animated, so it simply follows. */
function useFollowHeight(reduced: boolean) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const armedUntil = useRef(0);
  useEffect(() => {
    const box = outer.current, node = inner.current;
    if (!box || !node || typeof ResizeObserver === "undefined") return;
    let last = node.offsetHeight;
    let controls: AnimationPlaybackControls | undefined;
    const observer = new ResizeObserver(() => {
      const next = node.offsetHeight;
      if (next === last) return;
      const from = controls ? box.offsetHeight : last;
      last = next;
      controls?.stop(); controls = undefined;
      if (reduced || performance.now() > armedUntil.current || Math.abs(from - next) < 1) { box.style.height = ""; return; }
      box.style.height = `${from}px`;
      controls = animate(box, { height: [`${from}px`, `${next}px`] }, { ...motionTokens.spring.smooth, onComplete: () => { box.style.height = ""; controls = undefined; } });
    });
    observer.observe(node);
    return () => { observer.disconnect(); controls?.stop(); };
  }, [reduced]);
  return { outer, inner, arm: () => { armedUntil.current = performance.now() + 500; } };
}

type EndpointRowProps = { item: Endpoint; selected: boolean; selectedId: string; fresh: boolean; reduced: boolean; detailId: string; onSelect: () => void };

function EndpointRow({ item, selected, selectedId, fresh, reduced, detailId, onSelect }: EndpointRowProps) {
  const { total, failing } = seriesFor(item);
  const shown = item.events.slice(0, 3), more = item.events.length - shown.length;
  return <motion.div role="listitem" className={styles.row} {...grow(reduced)}>
    <div className={styles.endpoint} data-fresh={fresh}>
      {selected && <motion.span layoutId="endpoint-highlight" layoutDependency={selectedId} className={styles.highlight} transition={reduced ? instant : motionTokens.spring.morph} aria-hidden="true" />}
      <span className={styles.flash} aria-hidden="true" />
      <button type="button" className={styles.endpointButton} data-endpoint={item.id} aria-current={selected ? "true" : undefined} aria-controls={detailId} onClick={onSelect}>
        <span className={styles.identity}>
          <span className={styles.name}>{item.name}</span>
          <span className={styles.url}><span className={styles.host}>{hostOf(item.url)}</span>{pathOf(item.url)}</span>
        </span>
        <span className={styles.srOnly}>{`Events: ${item.events.join(", ")}. `}</span>
        <span className={styles.events} aria-hidden="true">
          {shown.map(event => <span key={event} className={styles.chip} aria-hidden="true">{event}</span>)}
          {more > 0 && <span className={styles.chip} aria-hidden="true">+{more}</span>}
        </span>
        <span className={styles.rate}>
          <Roll text={rateText(total, failing)} value={rateOf(total, failing)} reduced={reduced} />
          <span className={styles.srOnly}>{total ? `${rateText(total, failing)} delivered. ` : "No events yet. "}</span>
          <span className={styles.rateLabel} aria-hidden="true">delivered</span>
        </span>
        <span className={styles.state}>
          <Badge size="sm" tone={failing ? "warning" : total ? "success" : "neutral"} icon={failing ? <TriangleAlert size={12} strokeWidth={2} /> : total ? <Check size={12} strokeWidth={2} /> : undefined}>{failing ? `${failing} failing` : total ? "Healthy" : "No events"}</Badge>
        </span>
      </button>
    </div>
  </motion.div>;
}

/** Events per half hour. Failed events sit on top of each bar in the danger color; a retry melts its sliver back into the bar. */
function DeliveryChart({ endpoint, reduced }: { endpoint: Endpoint; reduced: boolean }) {
  const { volume, fails, total, failing } = seriesFor(endpoint);
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(4, ...volume), peak = volume.indexOf(Math.max(...volume));
  const failingSlots = fails.flatMap((value, slot) => value ? [slotLabel(slot)] : []);
  const label = total
    ? `Events per half hour over the last 24 hours: ${count.format(total)} events, ${failing ? `${failing} still failing, from ${failingSlots.join(", ")}` : "all delivered"}. Busiest from ${slotLabel(peak)} with ${volume[peak]} events.`
    : "No events in the last 24 hours.";
  function track(event: ReactPointerEvent<HTMLDivElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    setHover(Math.min(SLOTS - 1, Math.max(0, Math.floor(((event.clientX - box.left) / box.width) * SLOTS))));
  }
  const summary = total ? `${count.format(total)} events` : "No events yet";
  return <div className={styles.chartBlock}>
    <p className={styles.caption} aria-hidden="true">
      {hover === null
        ? <><SwapText text={summary} reduced={reduced} />{failing ? <span className={styles.legend}><span className={styles.swatch} /><SwapText text={`${failing} failed`} reduced={reduced} /></span> : total ? <span className={styles.legendMuted}>all delivered</span> : null}</>
        : <><span className={styles.readoutTime}>{slotLabel(hover)}</span><span>{`${volume[hover]} ${volume[hover] === 1 ? "event" : "events"}`}</span>{fails[hover] ? <span className={styles.legend}><span className={styles.swatch} />{`${fails[hover]} failed`}</span> : null}</>}
    </p>
    <div className={styles.chart} role="img" aria-label={label} data-hover={hover !== null} onPointerMove={track} onPointerLeave={() => setHover(null)}>
      {volume.map((value, slot) => {
        const fail = fails[slot] ? Math.max(5, Math.round((fails[slot] / max) * 56) + 1) : 0;
        const height = value ? Math.max(3, Math.round((value / max) * 56), fail + (value > fails[slot] ? 3 : -1)) : 0;
        const move = reduced ? instant : { ...motionTokens.spring.smooth, delay: slot * .004 };
        return <motion.span key={slot} className={styles.bar} data-active={hover === slot} initial={false} animate={{ height }} transition={move}>
          <motion.span className={styles.fail} initial={false} animate={{ height: fail }} transition={move} /><span className={styles.ok} />
        </motion.span>;
      })}
    </div>
    <div className={styles.axis} aria-hidden="true">
      {ticks.map(tick => <span key={tick.slot} style={{ left: `${(tick.slot / SLOTS) * 100}%` }}>{tick.label}</span>)}
      <span className={styles.now}>Now</span>
    </div>
  </div>;
}

type DeliveryRowProps = { item: Delivery; endpointId: string; selected: boolean; selectedKey: string; fresh: boolean; sending: boolean; reduced: boolean; inspectorId: string; onSelect: () => void; onRetry: () => void; buttonRef: (node: HTMLButtonElement | null) => void };

function DeliveryRow({ item, endpointId, selected, selectedKey, fresh, sending, reduced, inspectorId, onSelect, onRetry, buttonRef }: DeliveryRowProps) {
  const ok = item.status < 300;
  const label = `${item.status} ${phrases[item.status]}, ${item.event}${item.attempt > 1 ? `, attempt ${item.attempt}` : ""}${item.test ? ", test event" : ""}, ${latencyText(item.latency)}, sent at ${item.time}${item.resolved ? ", resolved by a retry" : ""}`;
  const swap = { initial: reduced ? { opacity: 0 } : rise, animate: rest, exit: reduced ? { opacity: 0, transition: instant } : lift, transition: reduced ? instant : { duration: motionTokens.duration.standard, ease: easeEnter } };
  return <motion.div role="listitem" className={styles.row} data-row={item.id} {...grow(reduced)}>
    <div className={styles.delivery} data-fresh={fresh} data-resolved={item.resolved ?? false}>
      {selected && <motion.span layoutId={`delivery-${endpointId}`} layoutDependency={selectedKey} className={styles.highlight} transition={reduced ? instant : motionTokens.spring.morph} aria-hidden="true" />}
      <span className={styles.flash} aria-hidden="true" />
      <button ref={buttonRef} type="button" className={styles.deliveryButton} data-delivery={item.id} aria-current={selected ? "true" : undefined} aria-controls={inspectorId} aria-label={label} onClick={onSelect}>
        <Badge size="sm" tone={ok ? "success" : "danger"} className={styles.statusCode}>{String(item.status)}</Badge>
        <span className={styles.eventCell}>
          <span className={styles.eventName}>{item.event}</span>
          {item.attempt > 1 ? <span className={styles.attempt}>Attempt {item.attempt}</span> : item.test ? <span className={styles.attempt}>Test</span> : null}
        </span>
        <span className={styles.meta}><span className={styles.latency}>{latencyText(item.latency)}</span><span className={styles.time}>{item.time}</span></span>
      </button>
      <span className={styles.action}>
        {!ok && <AnimatePresence mode="popLayout" initial={false}>
          {item.resolved
            ? <motion.span key="resolved" className={styles.resolved} {...swap}><Check size={14} strokeWidth={1.75} aria-hidden="true" />Resolved</motion.span>
            : <motion.span key="retry" {...swap}><Button type="button" size="sm" variant="secondary" loading={sending} aria-label={sending ? `Sending ${item.event} again` : `Retry ${item.event} from ${item.time}`} onClick={onRetry}>{sending ? "Sending" : <><RotateCw size={14} strokeWidth={1.75} aria-hidden="true" />Retry</>}</Button></motion.span>}
        </AnimatePresence>}
      </span>
    </div>
  </motion.div>;
}

/** Indents with two spaces and colors keys, strings, numbers, and literals with one accent and the text ramp. */
function JsonView({ text }: { text: string }) {
  const pattern = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?)|\b(true|false|null)\b/g;
  return <pre className={styles.code}><code>{text.split("\n").map((line, row) => {
    const parts: ReactNode[] = [];
    let last = 0;
    for (const match of line.matchAll(pattern)) {
      const at = match.index ?? 0;
      if (at > last) parts.push(line.slice(last, at));
      if (match[1]) { parts.push(<span key={at} className={match[2] ? styles.key : styles.string}>{match[1]}</span>); if (match[2]) parts.push(match[2]); }
      else parts.push(<span key={at} className={match[3] ? styles.number : styles.literal}>{match[3] ?? match[4]}</span>);
      last = at + match[0].length;
    }
    if (last < line.length) parts.push(line.slice(last));
    return <span key={row} className={styles.line}><span className={styles.lineNumber} aria-hidden="true">{row + 1}</span><span>{parts}</span></span>;
  })}</code></pre>;
}

type InspectorProps = { endpoint: Endpoint; delivery: Delivery | undefined; tab: Tab; reduced: boolean; id: string; onTab: (tab: Tab) => void; onCopied: (what: string) => void };

function Inspector({ endpoint, delivery, tab, reduced, id, onTab, onCopied }: InspectorProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const tabs = useRef<Record<Tab, HTMLButtonElement | null>>({ payload: null, headers: null });
  const payload = delivery ? JSON.stringify(payloadFor(endpoint, delivery), null, 2) : "";
  const headers = delivery ? headersFor(endpoint, delivery) : [];
  useEffect(() => { scroller.current?.scrollTo({ top: 0, left: 0 }); }, [delivery?.id, tab]);
  function onTabKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next: Tab = event.key === "Home" ? "payload" : event.key === "End" ? "headers" : tab === "payload" ? "headers" : "payload";
    onTab(next);
    tabs.current[next]?.focus();
  }
  if (!delivery) return <section id={id} className={styles.inspector} aria-label="Delivery inspector"><p className={styles.placeholder}>The request body and headers of each delivery show up here.</p></section>;
  const ok = delivery.status < 300;
  const panel = { initial: reduced ? { opacity: 0 } : { opacity: 0, y: 4, filter: `blur(${motionTokens.blur.subtle}px)` }, animate: { opacity: 1, y: 0, filter: "blur(0px)" }, exit: { opacity: 0, transition: reduced ? instant : { duration: motionTokens.duration.instant } }, transition: reduced ? instant : { duration: motionTokens.duration.standard, ease: easeEnter } };
  return <section id={id} className={styles.inspector} aria-labelledby={`${id}-title`}>
    <div className={styles.inspectorHead}>
      <div className={styles.inspectorTitle}>
        <h4 id={`${id}-title`}><SwapText text={delivery.event} reduced={reduced} /></h4>
        <p><SwapText text={`${delivery.eventId}, attempt ${delivery.attempt}`} reduced={reduced} /></p>
      </div>
      <CopyButton value={tab === "payload" ? payload : headers.map(([name, value]) => `${name}: ${value}`).join("\n")} label="Copy" onCopied={() => onCopied(tab === "payload" ? "Payload" : "Headers")} />
    </div>
    <div className={styles.response}>
      <span className={styles.responseLine}>
        <span className={styles.responseLabel}>Response</span>
        <Badge size="sm" tone={ok ? "success" : "danger"}>{String(delivery.status)}</Badge>
        <SwapText text={`${phrases[delivery.status]} in ${latencyText(delivery.latency)}`} reduced={reduced} />
      </span>
      <code className={styles.responseBody}><SwapText text={delivery.response} reduced={reduced} wrap /></code>
    </div>
    <div className={styles.tabs} role="tablist" aria-label="Request" onKeyDown={onTabKey}>
      {(["payload", "headers"] as const).map(value => <button key={value} ref={node => { tabs.current[value] = node; }} id={`${id}-${value}`} type="button" role="tab" className={styles.tab} aria-selected={tab === value} aria-controls={`${id}-panel`} tabIndex={tab === value ? 0 : -1} onClick={() => onTab(value)}>
        {tab === value && <motion.span layoutId={`tab-${endpoint.id}`} layoutDependency={tab} className={styles.tabHighlight} transition={reduced ? instant : motionTokens.spring.morph} aria-hidden="true" />}
        <span className={styles.tabLabel}>{value === "payload" ? "Payload" : "Headers"}</span>
      </button>)}
    </div>
    <div ref={scroller} id={`${id}-panel`} className={styles.panel} role="tabpanel" aria-labelledby={`${id}-${tab}`} tabIndex={0}>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.div key={`${delivery.id}-${tab}`} className={styles.panelBody} {...panel}>
          {tab === "payload" ? <JsonView text={payload} /> : <dl className={styles.headers}>{headers.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>}
        </motion.div>
      </AnimatePresence>
    </div>
  </section>;
}

export function Webhooks() {
  const id = useId();
  const reduced = useReducedMotion() ?? false;
  const [endpoints, setEndpoints] = useState<Endpoint[]>(sampleEndpoints);
  const [selectedId, setSelectedId] = useState(sampleEndpoints[0].id);
  const [picks, setPicks] = useState<Record<string, string | undefined>>(() => Object.fromEntries(sampleEndpoints.map(item => [item.id, pickFor(item)])));
  const [tab, setTab] = useState<Tab>("payload");
  const [sending, setSending] = useState<string[]>([]);
  const [fresh, setFresh] = useState<string[]>([]);
  const [testing, setTesting] = useState<string | null>(null);
  const [status, setStatus] = useState("Pick a delivery to inspect its payload and headers");
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<"form" | "reveal">("form");
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [picked, setPicked] = useState<EventType[]>(["order.paid"]);
  const [errors, setErrors] = useState<{ url?: string; events?: string }>({});
  const [saving, setSaving] = useState(false);
  const [secret, setSecret] = useState("");
  const [newEndpoint, setNewEndpoint] = useState<string | null>(null);
  const { width: shellWidth, height: shellHeight, trackRef, faceRef, innerRef, arm } = useShellSize(open, reduced);
  const { outer: followOuter, inner: followInner, arm: armFollow } = useFollowHeight(reduced);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  const eventsRef = useRef<HTMLFieldSetElement>(null);
  const revealRef = useRef<HTMLDivElement>(null);
  const rowButtons = useRef(new Map<string, HTMLButtonElement>());
  const timers = useRef<number[]>([]);
  const steps = useRef(0);
  const createAttempt = useRef(0);
  const created = useRef(0);
  const createdName = useRef("");
  const selectedRef = useRef(selectedId);

  const endpoint = endpoints.find(item => item.id === selectedId) ?? endpoints[0];
  const deliveryId = picks[endpoint.id] ?? pickFor(endpoint);
  const delivery = endpoint.deliveries.find(item => item.id === deliveryId);
  const title = open && phase === "reveal" ? "Endpoint added" : open ? "New endpoint" : "Add endpoint";
  const detailId = `${id}-detail`, inspectorId = `${id}-inspector`;

  useEffect(() => { selectedRef.current = selectedId; }, [selectedId]);
  useEffect(() => { const pending = timers.current; return () => pending.forEach(timer => window.clearTimeout(timer)); }, []);
  const later = (run: () => void, ms: number) => { timers.current.push(window.setTimeout(run, ms)); };
  const flash = (key: string) => { setFresh(list => [...list, key]); later(() => setFresh(list => list.filter(item => item !== key)), 1400); };
  const focusRow = (key: string) => requestAnimationFrame(() => rowButtons.current.get(key)?.focus({ preventScroll: true }));

  function selectEndpoint(next: string) {
    if (next === selectedRef.current) return;
    armFollow();
    selectedRef.current = next;
    setSelectedId(next);
  }

  function retry(target: Endpoint, item: Delivery) {
    if (sending.includes(item.id)) return;
    const host = hostOf(target.url);
    setSending(list => [...list, item.id]);
    setStatus(`Retrying ${item.event} to ${host}.`);
    later(() => {
      const step = ++steps.current;
      const next: Delivery = { ...item, id: `dlv_${tokenFrom(`${item.id}:${step}`, 7)}`, status: 200, latency: [184, 146, 211, 163, 129, 197][step % 6], time: clockAfter(step), attempt: item.attempt + 1, response: '{"received":true}', resolved: false };
      const hadFocus = document.activeElement?.closest(`[data-row="${item.id}"]`) != null;
      setEndpoints(list => list.map(entry => entry.id !== target.id ? entry : { ...entry, deliveries: [next, ...entry.deliveries.map(row => row.id === item.id ? { ...row, resolved: true } : row)] }));
      setSending(list => list.filter(key => key !== item.id));
      flash(next.id);
      setStatus(`${item.event} delivered on attempt ${next.attempt}. ${host} answered 200 in ${next.latency} ms.`);
      if (hadFocus) focusRow(next.id);
      // The new row opens first; then the selection glides up to it and the inspector shows the attempt that worked.
      later(() => setPicks(current => ({ ...current, [target.id]: next.id })), reduced ? 0 : 460);
    }, 1100);
  }

  function sendTest(target: Endpoint) {
    if (testing) return;
    setTesting(target.id);
    setStatus(`Sending a test ${target.events[0]} event to ${hostOf(target.url)}.`);
    later(() => {
      const step = ++steps.current, time = clockAfter(step), event = target.events[0];
      const next: Delivery = { id: `dlv_${tokenFrom(`${target.id}:test:${step}`, 7)}`, eventId: `evt_${tokenFrom(`${target.id}:evt:${step}`, 10)}`, event, status: 200, latency: 172, time, eventTime: time, attempt: 1, response: '{"received":true}', data: testObjects[event], test: true };
      setEndpoints(list => list.map(entry => entry.id !== target.id ? entry : { ...entry, volume: entry.volume.map((value, slot) => slot === SLOTS - 1 ? value + 1 : value), deliveries: [next, ...entry.deliveries] }));
      setPicks(current => ({ ...current, [target.id]: next.id }));
      setTesting(null);
      flash(next.id);
      setStatus(`Test event delivered. ${hostOf(target.url)} answered 200 in 172 ms.`);
      focusRow(next.id);
    }, 900);
  }

  function openPanel() {
    arm();
    setPhase("form"); setUrl(""); setDescription(""); setPicked(["order.paid"]); setErrors({}); setSaving(false);
    setOpen(true);
    setStatus("Enter an HTTPS URL and choose the events it should receive");
    requestAnimationFrame(() => urlRef.current?.focus({ preventScroll: true }));
  }

  function closePanel() {
    if (!open) return;
    createAttempt.current++;
    arm();
    setOpen(false);
    setSaving(false);
    if (phase === "reveal") { setNewEndpoint(null); setStatus(`${createdName.current} added. Send a test event to check that it answers.`); }
    else setStatus("New endpoint discarded");
    toggleRef.current?.focus({ preventScroll: true });
  }

  function toggleEvent(event: EventType, on: boolean) {
    setPicked(current => on ? [...current.filter(item => item !== event), event] : current.filter(item => item !== event));
    if (on && errors.events) setErrors(current => ({ ...current, events: undefined }));
  }

  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const address = url.trim();
    const next = { url: !address ? "Enter the URL Halden should post events to" : urlPattern.test(address) ? undefined : "Use a public HTTPS URL, such as https://api.fernway.example/webhooks", events: picked.length ? undefined : "Choose at least one event" };
    setErrors(next);
    if (next.url || next.events) {
      setStatus(next.url ?? next.events ?? "");
      if (next.url) urlRef.current?.focus(); else eventsRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
      return;
    }
    const token = ++createAttempt.current;
    setSaving(true);
    setStatus(`Adding ${address}.`);
    later(() => {
      if (token !== createAttempt.current) return;
      created.current += 1;
      const value = secretFor(`${address}:${created.current}`);
      const item: Endpoint = { id: `new-${created.current}`, name: description.trim() || hostOf(address), url: address, events: eventOptions.map(option => option.id).filter(option => picked.includes(option)), version: "2026-08-01", secretTail: value.slice(-4), addedBy: currentUser, added: "Sep 22, 2026", volume: Array.from({ length: SLOTS }, () => 0), deliveries: [] };
      createdName.current = item.name;
      arm();
      setSecret(value);
      setEndpoints(list => [item, ...list]);
      setNewEndpoint(item.id);
      setSaving(false);
      setPhase("reveal");
      setStatus(`${item.name} added. Copy the signing secret now, it will not be shown again.`);
      requestAnimationFrame(() => revealRef.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true }));
      // The row opens first; then the selection glides to it.
      later(() => selectEndpoint(item.id), reduced ? 0 : 460);
    }, 760);
  }

  const failingEndpoints = endpoints.filter(item => seriesFor(item).failing > 0).length;

  return (
    <LayoutGroup id={id}>
      <section className={styles.hooks} aria-labelledby={`${id}-heading`}>
        <div className={styles.top}>
          <header className={styles.header}>
            <h2 id={`${id}-heading`}>Webhooks</h2>
            <p>Halden signs every event and posts it to your endpoints. Failed deliveries retry on their own for three days, or you can retry them now.</p>
          </header>

          <div ref={trackRef} className={styles.toolbar} onKeyDown={event => { if (event.key === "Escape" && open) { event.stopPropagation(); closePanel(); } }}>
            <p className={styles.count} data-hidden={open} inert={open}>
              <Roll text={String(endpoints.length)} value={endpoints.length} reduced={reduced} /><span className={styles.srOnly}>{endpoints.length}</span>
              <span>{endpoints.length === 1 ? "endpoint" : "endpoints"}</span>
              <span className={styles.countNote}><SwapText text={failingEndpoints ? `${failingEndpoints} with failed deliveries` : "all delivering"} reduced={reduced} /></span>
            </p>
            <motion.div className={styles.shell} data-open={open} style={{ width: shellWidth, height: shellHeight }}>
              <div ref={innerRef} className={styles.shellInner}>
                <div ref={faceRef} className={styles.face}>
                  <button ref={toggleRef} className={styles.toggle} type="button" aria-label={open ? "Close" : "Add endpoint"} aria-expanded={open} aria-controls={open ? `${id}-panel` : undefined} onClick={open ? closePanel : openPanel}>
                    <motion.span className={styles.toggleIcon} initial={false} animate={{ rotate: open ? 45 : 0 }} transition={reduced ? instant : motionTokens.spring.snappy}><Plus size={16} strokeWidth={1.75} aria-hidden="true" /></motion.span>
                  </button>
                  <span id={`${id}-title`} className={styles.title} role={open ? "heading" : undefined} aria-level={open ? 3 : undefined} aria-hidden={open ? undefined : true}><SwapText text={title} reduced={reduced} /></span>
                </div>

                <AnimatePresence initial={false}>
                  {open && <motion.div key="body" id={`${id}-panel`} className={styles.body} role="group" aria-labelledby={`${id}-title`}
                    initial={{ opacity: 0 }} animate={{ opacity: 1, transition: reduced ? instant : { duration: motionTokens.duration.standard + .04, ease: easeEnter, delay: .14 } }} exit={{ opacity: 0, transition: reduced ? instant : { duration: .1, ease: easeStandard } }}>
                    <AnimatePresence mode="popLayout" initial={false}>
                      {phase === "form" ? <motion.form key="form" className={styles.form} noValidate onSubmit={create} exit={{ opacity: 0, transition: reduced ? instant : { duration: motionTokens.duration.instant } }}>
                        <div className={styles.fields}>
                          <Input ref={urlRef} label="Endpoint URL" placeholder="https://api.fernway.example/webhooks" type="url" inputMode="url" autoComplete="off" spellCheck={false} value={url} error={errors.url}
                            onChange={event => { setUrl(event.target.value); if (errors.url) setErrors(current => ({ ...current, url: undefined })); }} />
                          <Input label="Description" description="Optional" placeholder="Warehouse sync" autoComplete="off" maxLength={40} value={description} onChange={event => setDescription(event.target.value)} />
                        </div>
                        <fieldset ref={eventsRef} className={styles.eventSet} aria-describedby={errors.events ? `${id}-event-error` : undefined}>
                          <legend>Events to send</legend>
                          <div className={styles.eventGrid}>
                            {eventOptions.map(option => <Checkbox key={option.id} label={option.id} description={option.description} checked={picked.includes(option.id)} onCheckedChange={checked => toggleEvent(option.id, checked === true)} />)}
                          </div>
                          <AnimatePresence initial={false}>
                            {errors.events && <motion.p key="error" id={`${id}-event-error`} className={styles.fieldError} role="alert" initial={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={reduced ? { opacity: 0, transition: instant } : { height: 0, opacity: 0 }} transition={reduced ? instant : motionTokens.spring.smooth}><span>{errors.events}</span></motion.p>}
                          </AnimatePresence>
                        </fieldset>
                        <div className={styles.actions}>
                          <span className={styles.hint}><SwapText text={picked.length === 1 ? "1 event selected" : `${picked.length} events selected`} reduced={reduced} /></span>
                          <Button type="button" variant="ghost" onClick={closePanel}>Cancel</Button>
                          <Button type="submit" loading={saving}>{saving ? "Adding" : "Add endpoint"}</Button>
                        </div>
                      </motion.form> : <motion.div key="reveal" ref={revealRef} className={styles.reveal} initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={reduced ? instant : { duration: motionTokens.duration.standard + .08, ease: easeEnter, delay: .06 }}>
                        <div className={styles.secretBlock}>
                          <span id={`${id}-secret-label`} className={styles.fieldLabel}>Signing secret</span>
                          <div className={styles.secretField} role="group" aria-labelledby={`${id}-secret-label`}>
                            <motion.code className={styles.secret} initial={reduced ? false : { opacity: 0, filter: `blur(${motionTokens.blur.text}px)` }} animate={{ opacity: 1, filter: "blur(0px)" }} transition={{ duration: motionTokens.duration.considered, ease: easeEnter, delay: .14 }}>{secret}</motion.code>
                            <CopyButton value={secret} label="Copy" onCopied={() => setStatus("Signing secret copied. Store it with your other server secrets.")} />
                          </div>
                        </div>
                        <p className={styles.once}><TriangleAlert size={16} strokeWidth={1.75} aria-hidden="true" /><span>Shown once. Use it to check the Halden-Signature header on every request. You can roll it later, but you cannot view it again.</span></p>
                        <div className={styles.actions}>
                          <Button type="button" onClick={closePanel}>Done</Button>
                        </div>
                      </motion.div>}
                    </AnimatePresence>
                  </motion.div>}
                </AnimatePresence>
              </div>
            </motion.div>
          </div>
        </div>

        <div className={styles.endpoints} role="list" aria-label="Endpoints" onKeyDown={event => moveIn(event, "data-endpoint", selectEndpoint)}>
          <AnimatePresence initial={false}>
            {endpoints.map(item => <EndpointRow key={item.id} item={item} selected={item.id === endpoint.id} selectedId={endpoint.id} fresh={newEndpoint === item.id} reduced={reduced} detailId={detailId} onSelect={() => selectEndpoint(item.id)} />)}
          </AnimatePresence>
        </div>

        <div id={detailId} className={styles.detail} role="region" aria-labelledby={`${id}-detail-title`}>
          <div className={styles.detailHead}>
            <div className={styles.detailTitle}>
              <h3 id={`${id}-detail-title`}><SwapText text={endpoint.name} reduced={reduced} /></h3>
              <div className={styles.detailMeta}>
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.p key={endpoint.id} initial={reduced ? { opacity: 0 } : rise} animate={rest} exit={reduced ? { opacity: 0, transition: instant } : lift} transition={reduced ? instant : { duration: motionTokens.duration.standard, ease: easeEnter }}>
                    {/* Every item leads with its separator and the line is pulled left by one separator, so the dot that would start a line is clipped. */}
                    <span className={styles.metaItem}><span className={styles.dot} aria-hidden="true" /><Avatar className={styles.metaAvatar} name={endpoint.addedBy.name} src={endpoint.addedBy.photo} size="sm" aria-hidden="true" /><span>Added by {endpoint.addedBy.name} on {endpoint.added}</span></span>
                    <span className={styles.metaItem}><span className={styles.dot} aria-hidden="true" /><span className={styles.mono}>whsec_••••{endpoint.secretTail}</span></span>
                    <span className={styles.metaItem}><span className={styles.dot} aria-hidden="true" /><span>API {endpoint.version}</span></span>
                  </motion.p>
                </AnimatePresence>
              </div>
            </div>
          </div>
          <DeliveryChart endpoint={endpoint} reduced={reduced} />

          <div ref={followOuter} className={styles.follow}>
            <div ref={followInner} className={styles.followInner}>
              {/* Both splits share one grid cell while they cross-fade, so the entering one is laid out in place from its first frame
                  and the selection highlight inside it never measures itself below the leaving one. */}
              <AnimatePresence initial={false}>
                <motion.div key={endpoint.id} className={styles.split}
                  initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6, filter: `blur(${motionTokens.blur.subtle}px)` }} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                  exit={{ opacity: 0, pointerEvents: "none", transition: reduced ? instant : { duration: motionTokens.duration.instant } }} transition={reduced ? instant : { duration: motionTokens.duration.standard, ease: easeEnter, delay: .04 }}>
                  <div className={styles.deliveries}>
                    <h4 className={styles.sectionLabel}>Recent deliveries</h4>
                    <div className={styles.deliveryList} role="list" aria-label={`Recent deliveries to ${endpoint.name}`} onKeyDown={event => moveIn(event, "data-delivery", key => setPicks(current => ({ ...current, [endpoint.id]: key })))}>
                      <AnimatePresence initial={false}>
                        {endpoint.deliveries.map(item => <DeliveryRow key={item.id} item={item} endpointId={endpoint.id} selected={item.id === deliveryId} selectedKey={deliveryId ?? ""} fresh={fresh.includes(item.id)} sending={sending.includes(item.id)} reduced={reduced} inspectorId={inspectorId}
                            onSelect={() => setPicks(current => ({ ...current, [endpoint.id]: item.id }))} onRetry={() => retry(endpoint, item)}
                            buttonRef={node => { if (node) rowButtons.current.set(item.id, node); else rowButtons.current.delete(item.id); }} />)}
                      </AnimatePresence>
                    </div>
                    <AnimatePresence initial={false}>
                      {endpoint.deliveries.length === 0 && <motion.div key="empty" className={styles.emptyWrap} {...grow(reduced)}>
                        <div className={styles.empty}>
                          <p>No deliveries yet</p>
                          <span>Send a test event to check that {hostOf(endpoint.url)} answers with a 2xx status.</span>
                          <Button type="button" variant="secondary" size="sm" loading={testing === endpoint.id} onClick={() => sendTest(endpoint)}>{testing === endpoint.id ? "Sending" : "Send test event"}</Button>
                        </div>
                      </motion.div>}
                    </AnimatePresence>
                  </div>
                  <Inspector endpoint={endpoint} delivery={delivery} tab={tab} reduced={reduced} id={inspectorId} onTab={setTab} onCopied={what => setStatus(`${what} copied`)} />
                </motion.div>
              </AnimatePresence>
            </div>
          </div>
        </div>

        <footer className={styles.srOnly}>
        <p role="status" aria-live="polite">{status}</p>
        </footer>
      </section>
    </LayoutGroup>
  );
}

export default Webhooks;
