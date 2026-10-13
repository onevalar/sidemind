"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent } from "react";
import { AnimatePresence, animate, motion, useMotionValue, useSpring, useTransform } from "motion/react";
import { Pause, Play, RotateCcw } from "lucide-react";
import { motionTokens } from "../../lib/motion-tokens";
import { CITIES, DATE_LABEL, DAY, HQ, NOW, REGIONS, day, formatClock, formatCompact, formatInt, formatMoney, localTime, snapshotAt, type Snapshot } from "./globe-data";
import { GlobeEngine, type Focus, type Mode } from "./globe-engine";
import styles from "./revenue-globe.module.css";

const { spring, duration, ease } = motionTokens;
const TIP_WIDTH = 216;
const BIN_WIDTH = 10;
const HOURS = ["00:00", "06:00", "12:00", "18:00", "24:00"];
const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";
const subscribeReduced = (onChange: () => void) => {
  const query = window.matchMedia(REDUCED_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};
/** Reads the preference after hydration, so the server and the first client render match. */
const usePrefersReducedMotion = () => useSyncExternalStore(subscribeReduced, () => window.matchMedia(REDUCED_QUERY).matches, () => false);
function writeAria(slider: HTMLElement, clock: number, live: number) {
  slider.setAttribute("aria-valuenow", String(Math.round(clock)));
  slider.setAttribute("aria-valuetext", `${formatClock(clock, false)} UTC`);
  slider.setAttribute("aria-valuemax", String(Math.round(live)));
}
const percent = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

/**
 * A live figure that glides to each new total. The feed ticks several times a second, so a short
 * count on tabular numerals reads calmer than rolling digits; reduced motion writes the value directly.
 */
function Ticker({ value, prefix = "", reduce }: { value: number; prefix?: string; reduce: boolean }) {
  const shown = useMotionValue(value);
  const text = useTransform(shown, current => prefix + formatInt(Math.round(current)));
  useEffect(() => {
    if (reduce) { shown.jump(value); return; }
    const control = animate(shown, value, { duration: duration.considered, ease: [...ease.standard] as [number, number, number, number] });
    return () => control.stop();
  }, [value, reduce, shown]);
  return <motion.span className={styles.ticker} aria-hidden="true">{text}</motion.span>;
}

function Stat({ label, value, prefix, reduce }: { label: string; value: number; prefix?: string; reduce: boolean }) {
  return <div className={styles.stat}>
    <span className={styles.statLabel}>{label}</span>
    <span className={styles.statValue}><Ticker value={value} prefix={prefix} reduce={reduce} /><span className={styles.srOnly}>{(prefix ?? "") + formatInt(Math.round(value))}</span></span>
  </div>;
}

function Tip({ city, snapshot }: { city: number; snapshot: Snapshot }) {
  const info = CITIES[city];
  return <>
    <div className={styles.tipHead}>
      <span className={styles.tipName}>{info.name}</span>
      <span className={styles.tipMeta}>{city === HQ ? "Headquarters" : REGIONS[info.region].name} · {localTime(snapshot.t, info.tz)} local</span>
    </div>
    <dl className={styles.tipStats}>
      <div><dt>Today</dt><dd>{formatMoney(snapshot.cityRevenue[city])}</dd></div>
      <div><dt>Payments</dt><dd>{formatInt(snapshot.cityCount[city])}</dd></div>
      <div><dt>Share</dt><dd>{(snapshot.total > 0 ? (snapshot.cityRevenue[city] / snapshot.total) * 100 : 0).toFixed(1)}%</dd></div>
    </dl>
  </>;
}

export function RevenueGlobe() {
  const reduce = usePrefersReducedMotion();
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [snapshot, setSnapshot] = useState<Snapshot>(() => snapshotAt(NOW));
  const [mode, setMode] = useState<Mode>("live");
  const [focus, setFocus] = useState<Focus>(null);
  const [tip, setTip] = useState<{ city: number | null; shown: boolean }>({ city: null, shown: false });
  const [announcement, setAnnouncement] = useState("");
  const [bins] = useState(() => { const values = day().bins; const max = Math.max(...values); return values.map(value => value / max); });
  const [forecast] = useState(() => day().forecast);

  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<GlobeEngine | null>(null);
  const sliderRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLSpanElement>(null);
  const playedRef = useRef<SVGRectElement>(null);
  const availableRef = useRef<SVGRectElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);

  const anchorX = useMotionValue(0);
  const anchorY = useMotionValue(0);
  const tipX = useSpring(anchorX, spring.responsive);
  const tipY = useSpring(anchorY, spring.responsive);

  useEffect(() => {
    const canvas = canvasRef.current, host = hostRef.current, slider = sliderRef.current;
    if (!canvas || !host || !slider) return;
    let lastTip = { city: null as number | null, shown: false };
    let lastText = "";
    let lastAria = 0;

    const engine = new GlobeEngine(canvas, host, reduce, {
      tick: setSnapshot,
      mode: next => {
        setMode(next);
        setAnnouncement(next === "live" ? "Back to live" : next === "replay" ? "Replaying today" : "Paused");
      },
      focus: next => {
        setFocus(next);
        setAnnouncement(!next ? "Selection cleared" : next.kind === "city" ? `Camera on ${CITIES[next.index].name}` : `Camera on ${REGIONS[next.index].name}`);
      },
      hover: () => {},
      anchor: (city, x, y, shown) => {
        const width = host.clientWidth;
        const nextX = Math.min(Math.max(x, TIP_WIDTH / 2 + 12), width - TIP_WIDTH / 2 - 12);
        const nextY = Math.max(y, 132);
        const appearing = shown && (!lastTip.shown || lastTip.city === null);
        if (appearing) { anchorX.jump(nextX); anchorY.jump(nextY); tipX.jump(nextX); tipY.jump(nextY); }
        else if (shown) { anchorX.set(nextX); anchorY.set(nextY); }
        if (city !== lastTip.city || shown !== lastTip.shown) { lastTip = { city, shown }; setTip(lastTip); }
      },
      frame: (clock, live) => {
        const played = (clock / DAY) * 96 * BIN_WIDTH;
        // The slider is a size container, so the thumb rides a transform in cqw and the per-frame update never touches layout.
        if (thumbRef.current) thumbRef.current.style.transform = `translateX(${((clock / DAY) * 100).toFixed(3)}cqw)`;
        playedRef.current?.setAttribute("width", played.toFixed(1));
        availableRef.current?.setAttribute("width", ((live / DAY) * 96 * BIN_WIDTH).toFixed(1));
        const text = formatClock(clock);
        if (text !== lastText && timeRef.current) { timeRef.current.textContent = text; lastText = text; }
        const now = performance.now();
        if (now - lastAria > 600) { lastAria = now; writeAria(slider, clock, live); }
      },
    });
    engineRef.current = engine;
    return () => { engine.destroy(); engineRef.current = null; };
  }, [reduce, anchorX, anchorY, tipX, tipY]);

  const engine = () => engineRef.current;
  const select = (next: Focus) => engine()?.select(next);
  const isFocused = (kind: "city" | "region", index: number) => focus?.kind === kind && focus.index === index;

  const scrubAt = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    engine()?.scrubTo(((event.clientX - rect.left) / rect.width) * DAY);
  };
  const onSliderKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = engine();
    if (!current) return;
    const step = event.shiftKey ? 3600 : 300;
    const moves: Record<string, number> = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step, PageDown: -3600, PageUp: 3600 };
    if (event.key in moves) current.seek(current.time + moves[event.key]);
    else if (event.key === "Home") current.seek(0);
    else if (event.key === "End") current.goLive();
    else return;
    event.preventDefault();
    writeAria(event.currentTarget, current.time, current.live);
  };
  const onGlobeKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const moves: Record<string, [number, number]> = { ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (event.key in moves) { engine()?.nudge(...moves[event.key]); event.preventDefault(); }
    else if (event.key === "Escape") engine()?.clearFocus();
  };

  const tipCity = tip.city;
  const leader = snapshot.top[0];
  const summary = `${formatMoney(snapshot.total)} revenue today from ${formatInt(snapshot.count)} payments as of ${formatClock(snapshot.t, false)} UTC. ${REGIONS.map((region, r) => `${region.name} ${formatCompact(snapshot.regions[r])}`).join(", ")}. ${CITIES[leader].name} leads.`;
  const reveal = { duration: reduce ? 0 : duration.standard, ease: [...ease.enter] as [number, number, number, number] };

  return <section className={styles.root} aria-labelledby={`${uid}-title`}>
    <header className={styles.header}>
      <div className={styles.heading}>
        <h2 id={`${uid}-title`} className={styles.title}>Payments today</h2>
        <p className={styles.lede}>40 cities settling to San Francisco. Drag to spin, pick a city to fly there.</p>
      </div>
      <p className={styles.meta}>{DATE_LABEL}</p>
    </header>

    <div className={styles.stage}>
      <div className={styles.viz}>
        <div
          ref={hostRef}
          className={styles.globe}
          role="region"
          aria-roledescription="interactive globe"
          aria-label="Revenue globe. Arrow keys spin it, Escape clears the selection."
          aria-describedby={`${uid}-summary`}
          tabIndex={0}
          onKeyDown={onGlobeKey}
        >
          <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />
          <motion.div
            className={styles.tip}
            style={{ x: tipX, y: tipY, width: TIP_WIDTH }}
            initial={false}
            animate={tip.shown && tipCity !== null ? { opacity: 1, scale: 1 } : { opacity: 0, scale: .96 }}
            transition={reduce ? { duration: 0 } : { opacity: { duration: duration.fast }, scale: spring.snappy }}
            aria-hidden="true"
          >
            {tipCity !== null && <Tip city={tipCity} snapshot={snapshot} />}
          </motion.div>
          <p id={`${uid}-summary`} className={styles.srOnly}>{summary}</p>
        </div>

        <div className={styles.timeline}>
          <div className={styles.controls}>
            {!reduce && <button type="button" className={styles.control} onClick={() => engine()?.replayDay()}>
              <RotateCcw size={16} strokeWidth={1.75} aria-hidden="true" />Replay today
            </button>}
            {!reduce && <button type="button" className={styles.iconControl} aria-label={mode === "paused" ? "Play" : "Pause"} onClick={() => engine()?.togglePlay()}>
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span key={mode === "paused" ? "play" : "pause"} className={styles.iconSwap} initial={{ opacity: 0, scale: .8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: .8 }} transition={{ duration: duration.fast, ease: [...ease.standard] as [number, number, number, number] }}>
                  {mode === "paused" ? <Play size={16} strokeWidth={1.75} /> : <Pause size={16} strokeWidth={1.75} />}
                </motion.span>
              </AnimatePresence>
            </button>}
            <span className={styles.clock}><span ref={timeRef}>{formatClock(NOW)}</span> UTC</span>
            <button type="button" className={styles.live} data-live={mode === "live"} aria-pressed={mode === "live"} onClick={() => engine()?.goLive()}>
              <span className={styles.liveDot} aria-hidden="true" />{reduce ? "Now" : mode === "live" ? "Live" : "Go live"}
            </button>
          </div>
          <div
            ref={sliderRef}
            className={styles.slider}
            role="slider"
            tabIndex={0}
            aria-label="Time of day, UTC"
            aria-valuemin={0}
            aria-valuemax={NOW}
            aria-valuenow={NOW}
            aria-valuetext={`${formatClock(NOW, false)} UTC`}
            onKeyDown={onSliderKey}
            onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); engine()?.scrubStart(); scrubAt(event); }}
            onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) scrubAt(event); }}
            onPointerUp={() => engine()?.scrubEnd()}
            onPointerCancel={() => engine()?.scrubEnd()}
          >
            <svg className={styles.bins} viewBox={`0 0 ${96 * BIN_WIDTH} 40`} preserveAspectRatio="none" aria-hidden="true">
              <defs>
                <clipPath id={`${uid}-available`}><rect ref={availableRef} x="0" y="0" width={(NOW / DAY) * 96 * BIN_WIDTH} height="40" /></clipPath>
                <clipPath id={`${uid}-played`}><rect ref={playedRef} x="0" y="0" width={(NOW / DAY) * 96 * BIN_WIDTH} height="40" /></clipPath>
              </defs>
              <g className={styles.binsFuture}>{bins.map((value, i) => <rect key={i} x={i * BIN_WIDTH + 1.5} y={38.5} width={BIN_WIDTH - 3} height={1.5} />)}</g>
              <g className={styles.binsBase} clipPath={`url(#${uid}-available)`}>{bins.map((value, i) => <rect key={i} x={i * BIN_WIDTH + 1.5} y={40 - Math.max(1.5, value * 36)} width={BIN_WIDTH - 3} height={Math.max(1.5, value * 36)} />)}</g>
              <g className={styles.binsPlayed} clipPath={`url(#${uid}-played)`}>{bins.map((value, i) => <rect key={i} x={i * BIN_WIDTH + 1.5} y={40 - Math.max(1.5, value * 36)} width={BIN_WIDTH - 3} height={Math.max(1.5, value * 36)} />)}</g>
            </svg>
            <span ref={thumbRef} className={styles.thumb} style={{ transform: `translateX(${((NOW / DAY) * 100).toFixed(3)}cqw)` }} aria-hidden="true"><span className={styles.thumbLine} /></span>
          </div>
          <div className={styles.hours} aria-hidden="true">{HOURS.map(hour => <span key={hour}>{hour}</span>)}</div>
        </div>
      </div>

      <aside className={styles.panel} aria-label="Key numbers">
        <div className={styles.kpi}>
          <span className={styles.kpiLabel}>Revenue today</span>
          <span className={styles.kpiValue}><Ticker value={snapshot.total} prefix="$" reduce={reduce} /><span className={styles.srOnly}>{formatMoney(snapshot.total)}</span></span>
          <div className={styles.stats}>
            <Stat label="Payments" value={snapshot.count} reduce={reduce} />
            <Stat label="Last hour" value={snapshot.lastHour} prefix="$" reduce={reduce} />
          </div>
        </div>

        <div className={styles.group}>
          <div className={styles.groupHead}><h3>Regions</h3><span>Today vs forecast</span></div>
          <ul className={styles.list}>
            {REGIONS.map((region, r) => {
              const value = snapshot.regions[r];
              return <li key={region.id}>
                <button
                  type="button"
                  className={styles.row}
                  aria-pressed={isFocused("region", r)}
                  onClick={() => select({ kind: "region", index: r })}
                >
                  <span className={styles.rowHead}>
                    <span className={styles.rowName}>{region.name}<span className={styles.rowMeta}>{percent(value, forecast[r])}% of forecast</span></span>
                    <span className={styles.rowValue}><Ticker value={value} prefix="$" reduce={reduce} /><span className={styles.srOnly}>{formatMoney(value)}</span></span>
                  </span>
                  <span className={styles.bar} aria-hidden="true">
                    <span className={styles.track}>
                      <motion.span className={styles.fill} initial={false} animate={{ scaleX: Math.min(1, value / forecast[r]) }} transition={reduce ? { duration: 0 } : spring.smooth} />
                    </span>
                  </span>
                  <span className={styles.srOnly}>, {percent(value, snapshot.total)}% of today’s revenue, forecast {formatCompact(forecast[r])}</span>
                </button>
              </li>;
            })}
          </ul>
        </div>

        <div className={styles.group}>
          <div className={styles.groupHead}><h3>Top cities</h3><span>Today</span></div>
          <ol className={styles.list}>
            <AnimatePresence initial={false} mode="popLayout">
              {snapshot.top.map(i => <motion.li
                key={i}
                layout={!reduce}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={reduce ? { duration: 0 } : { layout: spring.smooth, default: reveal }}
              >
                <button
                  type="button"
                  className={`${styles.row} ${styles.cityRow}`}
                  aria-pressed={isFocused("city", i)}
                  onClick={() => select({ kind: "city", index: i })}
                  onFocus={() => engine()?.peek(i)}
                  onBlur={() => engine()?.peek(null)}
                  onPointerMove={() => engine()?.peek(i)}
                  onPointerLeave={() => engine()?.peek(null)}
                >
                  <span className={styles.rowName}>{CITIES[i].name}<span className={styles.rowMeta}>{CITIES[i].country}</span></span>
                  <span className={styles.rowValue}><Ticker value={snapshot.cityRevenue[i]} prefix="$" reduce={reduce} /><span className={styles.srOnly}>{formatMoney(snapshot.cityRevenue[i])}</span></span>
                </button>
              </motion.li>)}
            </AnimatePresence>
          </ol>
        </div>
      </aside>
    </div>

    <p className={styles.srOnly} aria-live="polite">{announcement}</p>
    {/* A table ignores the 1px box, so it sits in a clipped wrapper; otherwise its rows stretch the page below the block. */}
    <div className={styles.srOnly}><table>
      <caption>Revenue by city today, as of {formatClock(snapshot.t, false)} UTC</caption>
      <thead><tr><th scope="col">City</th><th scope="col">Region</th><th scope="col">Revenue</th><th scope="col">Payments</th></tr></thead>
      <tbody>{CITIES.map((city, i) => <tr key={city.name}><th scope="row">{city.name}</th><td>{REGIONS[city.region].name}</td><td>{formatMoney(snapshot.cityRevenue[i])}</td><td>{formatInt(snapshot.cityCount[i])}</td></tr>)}</tbody>
    </table></div>
  </section>;
}

export default RevenueGlobe;
