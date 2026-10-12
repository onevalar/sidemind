"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { AnimatePresence, LayoutGroup, animate, motion, useMotionValue, useReducedMotion } from "motion/react";
import { ArrowLeft, Maximize2, Minus, Plus } from "lucide-react";
import { motionTokens } from "../../lib/motion-tokens";
import {
  ACCOUNTS, GROUPS, HEALTH_LABELS, HEALTH_ORDER, HEALTH_TONES, INDUSTRIES, PLANS, REGIONS, TOTAL,
  categoryOf, formatCompact, formatCount, formatMoney, percent, rowsFor, statsFor, type GroupKey, type GroupStat,
} from "./galaxy-data";
import { GalaxyEngine } from "./galaxy-engine";
import styles from "./customer-galaxy.module.css";

const { spring, stagger, duration, ease } = motionTokens;
const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
type Sort = "mrr" | "count";

/** A tiny external store so hover changes re-render only the card, never the whole section. */
function createStore(initial: number) {
  let value = initial;
  const subs = new Set<() => void>();
  return {
    get: () => value,
    set: (next: number) => { if (next !== value) { value = next; subs.forEach(fn => fn()); } },
    subscribe: (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn); }; },
  };
}
type Store = ReturnType<typeof createStore>;

/** Digits roll on wheels keyed by place value; new wheels roll up from zero as they mount. */
function Roll({ text }: { text: string }) {
  const chars = [...text];
  return <span className={styles.roll}>
    <span className={styles.srOnly}>{text}</span>
    <span className={styles.rollVisual} aria-hidden="true">
      {chars.map((ch, i) => {
        const place = chars.length - 1 - i;
        if (ch < "0" || ch > "9") return <span key={`s${place}`} className={styles.sym}>{ch}</span>;
        return <span key={`d${place}`} className={styles.wheel}>
          <span className={styles.strip} style={{ "--d": ch, "--i": i } as CSSProperties}>{DIGITS.map(d => <span key={d}>{d}</span>)}</span>
        </span>;
      })}
    </span>
  </span>;
}

/** Springs a wrapper to its content's height when `key` changes (a regroup with more or fewer rows), so the panel never snaps.
 *  Other resizes, such as a parent reflow or a late font, follow at once. */
function useAutoHeight(key: string, reduced: boolean) {
  const content = useRef<HTMLDivElement>(null);
  const height = useMotionValue<number | "auto">("auto");
  const lastKey = useRef(key), armedUntil = useRef(0);
  useLayoutEffect(() => {
    if (lastKey.current === key) return;
    lastKey.current = key;
    armedUntil.current = performance.now() + 700;
  }, [key]);
  useEffect(() => {
    const node = content.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    let measured = false;
    const observer = new ResizeObserver(() => {
      const next = node.offsetHeight;
      if (!measured || reduced || performance.now() > armedUntil.current) { measured = next > 0; height.jump(next || "auto"); return; }
      animate(height, next, spring.smooth);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [height, reduced]);
  return { content, height };
}

function Swatch({ health }: { health: number }) {
  return <span className={styles.swatch} data-tone={HEALTH_TONES[health]} aria-hidden="true" />;
}

/** The account card. It keeps the last account while fading out so the copy never blanks mid-exit. */
function AccountCard({ store, selected, attach, measure }: { store: Store; selected: number; attach: (el: HTMLDivElement | null) => void; measure: () => void }) {
  const hovered = useSyncExternalStore(store.subscribe, store.get, () => -1);
  const shown = hovered >= 0 ? hovered : selected;
  const [last, setLast] = useState(-1);
  if (shown >= 0 && shown !== last) setLast(shown);
  const account = ACCOUNTS[shown >= 0 ? shown : last];
  useLayoutEffect(() => { measure(); }, [account, measure]);
  return <div ref={attach} className={styles.card} data-open={shown >= 0} aria-hidden="true">
    {account && <>
      <div className={styles.cardName}>{account.name}</div>
      <div className={styles.cardMeta}>{PLANS[account.plan]} · {REGIONS[account.region]} · {INDUSTRIES[account.industry]}</div>
      <dl className={styles.cardRows}>
        <div><dt>MRR</dt><dd className={styles.num}>{formatMoney(account.mrr)}</dd></div>
        <div><dt>Owner</dt><dd>{account.owner}</dd></div>
        <div><dt>Health</dt><dd className={styles.health}><Swatch health={account.health} />{HEALTH_LABELS[account.health]}</dd></div>
      </dl>
      <p className={styles.cardNote}>{account.note}</p>
    </>}
  </div>;
}

export function CustomerGalaxy() {
  const reduce = !!useReducedMotion();
  const uid = useId();
  const titleId = `${uid}-title`, hintId = `${uid}-hint`, stageId = `${uid}-stage`;
  const rootRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<GalaxyEngine | null>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const [hoverStore] = useState(() => createStore(-1));
  // Stable callbacks, so a render never detaches and reattaches the card or the labels, or wakes the engine for nothing.
  // Elements are remembered here too, because they mount before the engine exists.
  const cardEl = useRef<HTMLDivElement | null>(null);
  const labelEls = useRef(new Map<number, HTMLDivElement | null>());
  const attachCard = useCallback((el: HTMLDivElement | null) => { cardEl.current = el; engineRef.current?.attachCard(el); }, []);
  const measureCard = useCallback(() => engineRef.current?.measureCard(), []);
  const attachLabel = useCallback((el: HTMLDivElement) => {
    const index = Number(el.dataset.index);
    labelEls.current.set(index, el); engineRef.current?.attachLabel(index, el);
    return () => { if (labelEls.current.get(index) === el) { labelEls.current.delete(index); engineRef.current?.attachLabel(index, null); } };
  }, []);

  const [group, setGroup] = useState<GroupKey>("all");
  const [settled, setSettled] = useState(true);
  const [selected, setSelected] = useState(-1);
  const [focus, setFocus] = useState(-1);
  const [rowHover, setRowHover] = useState(-1);
  const [sort, setSort] = useState<Sort>("mrr");
  const [zoomed, setZoomed] = useState(false);
  const [touched, setTouched] = useState(false);
  const [keyed, setKeyed] = useState(false);

  const clusters = statsFor(group);
  const rows = rowsFor(group);
  const rowGroup: GroupKey = group === "all" ? "health" : group;
  const meta = GROUPS.find(g => g.key === group) ?? GROUPS[0];
  const scope: GroupStat = focus >= 0 && clusters[focus] ? clusters[focus] : TOTAL;
  const sortedRows = useMemo(() => [...rows].sort((a, b) => (sort === "mrr" ? b.mrr - a.mrr : b.count - a.count) || a.index - b.index), [rows, sort]);
  const maxRow = Math.max(...rows.map(r => sort === "mrr" ? r.mrr : r.count));
  const byMrr = [...clusters].sort((a, b) => b.mrr - a.mrr).map(c => c.index);
  useEffect(() => {
    const stage = stageRef.current, canvas = canvasRef.current, root = rootRef.current;
    if (!stage || !canvas || !root) return;
    const engine = new GalaxyEngine(canvas, {
      hover: hoverStore.set,
      select: index => { setSelected(index); setKeyed(false); },
      settle: setSettled,
      focus: setFocus,
      view: setZoomed,
      interact: () => setTouched(true),
    });
    engineRef.current = engine;
    engine.attachCard(cardEl.current);
    labelEls.current.forEach((el, index) => engine.attachLabel(index, el));
    const read = () => {
      const cs = getComputedStyle(root);
      const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
      engine.setPalette({ dots: [v("--text-muted", "#8a8a8a"), v("--success", "#1f8a4c"), v("--warning", "#b7791f"), v("--danger", "#c53030")], ring: v("--foreground", "#111"), accent: v("--accent", "#333") });
    };
    read();
    const themeWatch = new MutationObserver(read);
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-accent", "class", "style"] });
    const scheme = matchMedia("(prefers-color-scheme: dark)");
    scheme.addEventListener("change", read);
    const sizeWatch = new ResizeObserver(([entry]) => engine.resize(entry.contentRect.width, entry.contentRect.height, Math.min(2, window.devicePixelRatio || 1)));
    sizeWatch.observe(stage);
    const viewWatch = new IntersectionObserver(([entry]) => engine.setVisible(entry.isIntersecting), { threshold: .2 });
    viewWatch.observe(stage);
    const onVisibility = () => engine.setHidden(document.hidden);
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    const onWheel = (e: WheelEvent) => engine.wheel(e);
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      engine.destroy(); engineRef.current = null;
      themeWatch.disconnect(); scheme.removeEventListener("change", read); sizeWatch.disconnect(); viewWatch.disconnect();
      document.removeEventListener("visibilitychange", onVisibility); stage.removeEventListener("wheel", onWheel);
    };
  }, [hoverStore]);

  useEffect(() => { engineRef.current?.setReduced(reduce); }, [reduce]);
  useEffect(() => {
    const cat = rowHover >= 0 ? rowHover : focus;
    engineRef.current?.setHighlight(cat >= 0 ? { group: rowHover >= 0 ? rowGroup : group, cat } : null);
  }, [rowHover, focus, group, rowGroup]);

  const choose = (next: GroupKey, focusIndex = -1) => {
    const engine = engineRef.current;
    if (next === group) { if (focusIndex >= 0) engine?.focus(focusIndex); return; }
    setGroup(next); setRowHover(-1); setSelected(-1); setFocus(focusIndex);
    engine?.select(-1, false);
    engine?.setGroup(next, focusIndex);
  };

  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = GROUPS.findIndex(g => g.key === group);
    const next = e.key === "ArrowRight" ? (i + 1) % GROUPS.length : e.key === "ArrowLeft" ? (i - 1 + GROUPS.length) % GROUPS.length : e.key === "Home" ? 0 : e.key === "End" ? GROUPS.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    choose(GROUPS[next].key);
    tabsRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };

  const pickRow = (index: number) => {
    const engine = engineRef.current;
    setTouched(true);
    if (group === "all") { choose("health", index); return; }
    if (focus === index) engine?.resetView(); else engine?.focus(index);
  };

  /** Up and down walk the focused cluster, or the whole book, from the largest account down. */
  const stepAccount = (dir: number) => {
    const list = ACCOUNTS.filter(a => focus < 0 || categoryOf(group, a) === focus).sort((a, b) => b.mrr - a.mrr || a.id - b.id).map(a => a.id);
    const at = list.indexOf(selected);
    const next = list[at < 0 ? (dir > 0 ? 0 : list.length - 1) : Math.min(list.length - 1, Math.max(0, at + dir))];
    setSelected(next); setKeyed(true);
    engineRef.current?.select(next, true);
  };

  const onStageKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const engine = engineRef.current;
    if (!engine) return;
    let handled = true;
    if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && clusters.length > 1) {
      const order = byMrr, at = order.indexOf(focus), dir = e.key === "ArrowRight" ? 1 : -1;
      const next = order[at < 0 ? (dir > 0 ? 0 : order.length - 1) : (at + dir + order.length) % order.length];
      setSelected(-1); engine.select(-1, true); engine.focus(next);
    } else if (e.key === "ArrowRight" || e.key === "ArrowDown") stepAccount(1);
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") stepAccount(-1);
    else if (e.key === "+" || e.key === "=") engine.zoomBy(1.6);
    else if (e.key === "-" || e.key === "_") engine.zoomBy(1 / 1.6);
    else if (e.key === "Escape" && selected >= 0) { setSelected(-1); engine.select(-1, false); }
    else if (e.key === "Escape" || e.key === "0" || e.key === "Home") engine.resetView();
    else handled = false;
    if (handled) { e.preventDefault(); setTouched(true); }
  };

  const onPointer = (e: ReactPointerEvent<HTMLDivElement>) => {
    const engine = engineRef.current;
    if (!engine) return;
    if (e.type === "pointerdown") {
      if ((e.target as Element).closest("button")) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      engine.pointerDown(e.nativeEvent);
    } else if (e.type === "pointermove") engine.pointerMove(e.nativeEvent);
    else if (e.type === "pointerup") engine.pointerUp(e.nativeEvent);
    else engine.pointerCancel(e.nativeEvent);
  };

  const scopeLabel = focus >= 0 && clusters[focus] ? clusters[focus].label : "All accounts";
  const account = selected >= 0 ? ACCOUNTS[selected] : null;
  const live = keyed && account
    ? `${account.name}. ${PLANS[account.plan]}, ${formatMoney(account.mrr)} MRR, owner ${account.owner}, ${HEALTH_LABELS[account.health].toLowerCase()}. ${account.note}.`
    : focus >= 0 && clusters[focus]
      ? `${clusters[focus].label}: ${formatCount(clusters[focus].count)} accounts, ${formatCompact(clusters[focus].mrr)} MRR, ${formatCompact(clusters[focus].healthMrr[3])} at risk.`
      : group === "all" ? "Showing all accounts in one cluster." : `Grouped by ${meta.noun} into ${clusters.length} clusters. ${clusters[byMrr[0]].label} leads with ${formatCompact(Math.max(...clusters.map(c => c.mrr)))} MRR.`;
  const summary = `Customer galaxy: ${formatCount(TOTAL.count)} accounts with ${formatCompact(TOTAL.mrr)} in monthly recurring revenue, ${group === "all" ? "shown as one cluster" : `grouped by ${meta.noun}`}. Dot size shows MRR and color shows health.`;
  const layoutT = reduce ? { duration: 0 } : spring.smooth;
  const { content: rowsContent, height: rowsHeight } = useAutoHeight(group, reduce);
  const enter = [...ease.enter] as [number, number, number, number];

  return <section ref={rootRef} className={styles.root} aria-labelledby={titleId}>
    <header className={styles.header}>
      <h2 id={titleId} className={styles.title}>Where your revenue lives</h2>
      <p className={styles.lede}>{formatCount(TOTAL.count)} accounts, sized by MRR and colored by health.</p>
    </header>

    <div className={styles.toolbar}>
      <LayoutGroup id={`${uid}-tabs`}>
        <div ref={tabsRef} className={styles.tabs} role="tablist" aria-label="Group accounts by" onKeyDown={onTabKey}>
          {GROUPS.map(g => <button key={g.key} type="button" role="tab" id={`${uid}-tab-${g.key}`} aria-selected={group === g.key} aria-controls={stageId} tabIndex={group === g.key ? 0 : -1} className={styles.tab} onClick={() => choose(g.key)}>
            {group === g.key && <motion.span layoutId="tab" className={styles.tabPill} transition={reduce ? { duration: 0 } : spring.morph} />}
            <span className={styles.tabLabel}>{g.label}</span>
          </button>)}
        </div>
      </LayoutGroup>
      <ul className={styles.legend} aria-label="Legend">
        {HEALTH_ORDER.map(h => <li key={h}><Swatch health={h} />{HEALTH_LABELS[h]}</li>)}
        <li className={styles.sizeKey}><span className={styles.sizeDots} aria-hidden="true"><span /><span /></span>Size is MRR</li>
      </ul>
    </div>

    <div className={styles.body}>
      <div className={styles.stageWrap} role="tabpanel" id={stageId} aria-labelledby={`${uid}-tab-${group}`}>
        <div ref={stageRef} className={styles.stage} data-zoomed={zoomed} tabIndex={0} role="application" aria-roledescription="interactive chart" aria-label={summary} aria-describedby={hintId}
          onPointerDown={onPointer} onPointerMove={onPointer} onPointerUp={onPointer} onPointerCancel={onPointer}
          onPointerLeave={() => engineRef.current?.pointerLeave()} onDoubleClick={e => engineRef.current?.doubleClick(e.nativeEvent)} onKeyDown={onStageKey}>
          <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />
          <div className={styles.labels} aria-hidden="true">
            {settled && group !== "all" && clusters.map(s => <div key={`${group}-${s.index}`} className={styles.label} data-dim={(focus >= 0 && focus !== s.index) || (rowHover >= 0 && rowHover !== s.index)}
              data-index={s.index} ref={attachLabel}>
              <div className={styles.labelInner} style={{ "--i": byMrr.indexOf(s.index) } as CSSProperties}>
                <span className={styles.labelName}>{s.label}</span>
                <span className={styles.labelMeta}><Roll text={formatCompact(s.mrr)} /><span className={styles.labelCount}><span className={styles.dotSep}>·</span><Roll text={formatCount(s.count)} />{" accounts"}</span></span>
              </div>
            </div>)}
          </div>
          <AccountCard store={hoverStore} selected={selected} attach={attachCard} measure={measureCard} />
          <AnimatePresence initial={false}>
            {focus >= 0 && clusters[focus] && <motion.button key="back" type="button" className={styles.back} onClick={() => engineRef.current?.resetView()}
              initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -8 }} transition={reduce ? { duration: 0 } : { duration: duration.standard, ease: enter }}>
              <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />Show all
            </motion.button>}
          </AnimatePresence>
          <p className={styles.hint} data-hidden={touched} aria-hidden="true"><span className={styles.hintFine}>Drag to pan, scroll to zoom, double click a cluster to fly in</span><span className={styles.hintCoarse}>Pinch to zoom, double tap a cluster to fly in</span></p>
          <div className={styles.zoom}>
            <button type="button" aria-label="Zoom out" onClick={() => engineRef.current?.zoomBy(1 / 1.6)}><Minus size={16} strokeWidth={1.75} aria-hidden="true" /></button>
            <button type="button" aria-label="Zoom in" onClick={() => engineRef.current?.zoomBy(1.6)}><Plus size={16} strokeWidth={1.75} aria-hidden="true" /></button>
            <button type="button" aria-label="Fit all accounts" disabled={!zoomed} onClick={() => engineRef.current?.resetView()}><Maximize2 size={16} strokeWidth={1.75} aria-hidden="true" /></button>
          </div>
        </div>
        <p id={hintId} className={styles.srOnly}>Use left and right arrows to fly between clusters, up and down to step through accounts by MRR, plus and minus to zoom, and Escape to reset.</p>
      </div>

      <aside className={styles.panel} aria-label="Totals">
        <div className={styles.scope}>
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span key={scopeLabel} className={styles.scopeText} initial={reduce ? false : { opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, transition: { duration: duration.instant } }} transition={{ duration: duration.standard, ease: enter }}>{scopeLabel}</motion.span>
          </AnimatePresence>
        </div>
        <div className={styles.kpiMain}>
          <span className={styles.kpiLabel}>Monthly recurring revenue</span>
          <span className={styles.kpiValue}><Roll text={formatCompact(scope.mrr)} /></span>
        </div>
        <dl className={styles.kpis}>
          <div><dt>Accounts</dt><dd><Roll text={formatCount(scope.count)} /></dd></div>
          <div><dt><Swatch health={1} />Expanding</dt><dd><Roll text={formatCompact(scope.healthMrr[1])} /></dd></div>
          <div><dt><Swatch health={3} />At risk</dt><dd><Roll text={formatCompact(scope.healthMrr[3])} /></dd></div>
        </dl>
        <div className={styles.breakdown}>
          <div className={styles.breakdownHead}>
            <h3>By {rowGroup === "health" ? "health" : meta.noun}</h3>
            <div className={styles.sort} role="group" aria-label="Sort rows by">
              {(["mrr", "count"] as Sort[]).map(s => <button key={s} type="button" aria-pressed={sort === s} onClick={() => setSort(s)}>{s === "mrr" ? "MRR" : "Accounts"}</button>)}
            </div>
          </div>
          <motion.div className={styles.rowsWrap} style={{ height: rowsHeight }}><div ref={rowsContent}>
          <ul key={group} className={styles.rows}>
            {sortedRows.map((r, i) => {
              const value = sort === "mrr" ? r.mrr : r.count;
              const parts = HEALTH_ORDER.map(h => ({ h, v: sort === "mrr" ? r.healthMrr[h] : r.healthCount[h] })).filter(p => p.v > 0);
              return <motion.li key={r.index} layout="position" transition={{ layout: layoutT }} initial={reduce ? false : { opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0, transition: { duration: duration.standard, ease: enter, delay: reduce ? 0 : i * stagger.item } }}>
                <button type="button" className={styles.row} aria-pressed={group !== "all" && focus === r.index} data-lit={rowHover === r.index}
                  aria-label={`${r.label}: ${formatCompact(r.mrr)} MRR, ${formatCount(r.count)} accounts, ${percent(r.healthMrr[3], r.mrr)}% of MRR at risk. ${group === "all" ? "Group by health and fly to this cluster" : focus === r.index ? "Show all clusters" : "Fly to this cluster"}`}
                  onPointerEnter={e => { if (e.pointerType === "mouse") setRowHover(r.index); }} onPointerLeave={() => setRowHover(-1)}
                  onFocus={() => setRowHover(r.index)} onBlur={() => setRowHover(-1)} onClick={() => pickRow(r.index)}>
                  <span className={styles.rowTop}><span className={styles.rowName}>{r.label}</span><span className={styles.rowValue}><Roll text={sort === "mrr" ? formatCompact(value) : formatCount(value)} /></span></span>
                  <span className={styles.track}><span className={styles.fill} style={{ width: `${(value / maxRow) * 100}%` }}>
                    {parts.map(p => <span key={p.h} className={styles.seg} data-tone={HEALTH_TONES[p.h]} style={{ flexGrow: p.v }} />)}
                  </span></span>
                  <span className={styles.rowMeta}>{sort === "mrr" ? `${formatCount(r.count)} accounts` : formatCompact(r.mrr)}{rowGroup !== "health" && <> · {percent(r.healthMrr[3], r.mrr)}% at risk</>}</span>
                </button>
              </motion.li>;
            })}
          </ul>
          </div></motion.div>
        </div>
      </aside>
    </div>

    <div className={styles.srOnly}><table>
      <caption>Accounts and monthly recurring revenue by {rowGroup === "health" ? "health" : meta.noun}</caption>
      <thead><tr><th scope="col">{rowGroup === "health" ? "Health" : meta.label}</th><th scope="col">Accounts</th><th scope="col">MRR</th>{HEALTH_ORDER.map(h => <th key={h} scope="col">{HEALTH_LABELS[h]} accounts</th>)}</tr></thead>
      <tbody>{rows.map(r => <tr key={r.index}><th scope="row">{r.label}</th><td>{formatCount(r.count)}</td><td>{formatMoney(r.mrr)}</td>{HEALTH_ORDER.map(h => <td key={h}>{formatCount(r.healthCount[h])}</td>)}</tr>)}</tbody>
    </table></div>
    <p className={styles.srOnly} aria-live="polite">{live}</p>
  </section>;
}

export default CustomerGalaxy;
