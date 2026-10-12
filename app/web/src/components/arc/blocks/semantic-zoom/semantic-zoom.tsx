"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import Image from "next/image";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ChevronRight, Maximize2, Minus, Pause, Play, Plus } from "lucide-react";
import { motionTokens } from "../../lib/motion-tokens";
import { HEALTH_LABEL, KIND_LABEL, NODES, PEOPLE, PROJECTS, STATUS_LABEL, TASKS, TEAMS, WorkModel, formatCount, formatDay } from "./zoom-data";
import { ZoomEngine } from "./zoom-engine";
import styles from "./semantic-zoom.module.css";

const { spring, duration, ease } = motionTokens;
const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const enter = [...ease.enter] as [number, number, number, number];

/** A tiny external store so hover changes re-render only the floating card. */
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

/** Digits roll on wheels keyed by place value. */
function Roll({ text }: { text: string }) {
  const chars = [...text];
  return <span className={styles.roll}>
    <span className={styles.srOnly}>{text}</span>
    <span className={styles.rollVisual} aria-hidden="true">
      {chars.map((ch, i) => {
        const place = chars.length - 1 - i;
        if (ch < "0" || ch > "9") return <span key={`s${place}${ch}`} className={styles.sym}>{ch}</span>;
        return <span key={`d${place}`} className={styles.wheel}>
          <span className={styles.strip} style={{ "--d": ch, "--i": i } as CSSProperties}>{DIGITS.map(d => <span key={d}>{d}</span>)}</span>
        </span>;
      })}
    </span>
  </span>;
}

function Face({ person, size }: { person: number; size: number }) {
  const p = PEOPLE[person];
  return <span className={styles.face} style={{ width: size, height: size }}>
    {p.portrait ? <Image src={p.portrait} alt="" width={size * 2} height={size * 3} className={styles.faceImg} /> : <span className={styles.initials} style={{ fontSize: size * .38 }}>{p.initials}</span>}
  </span>;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return <div className={styles.cardRow}><dt>{label}</dt><dd>{children}</dd></div>;
}

/** The floating value card. It keeps the last node while fading so its copy never blanks mid-exit. */
function HoverCard({ store, model, version, panelRef, measure }: { store: Store; model: WorkModel; version: number; panelRef: RefObject<HTMLDivElement | null>; measure: () => void }) {
  const node = useSyncExternalStore(store.subscribe, store.get, () => -1);
  const [last, setLast] = useState(-1);
  if (node >= 0 && node !== last) setLast(node);
  const id = node >= 0 ? node : last;
  useLayoutEffect(() => { measure(); }, [id, version, measure]);
  const n = id >= 0 ? NODES[id] : null;
  let body: ReactNode = null;
  if (n) {
    const st = model.stats(id), pct = `${Math.round(st.progress * 100)}%`;
    if (n.kind === 1) {
      const team = TEAMS[n.ref];
      body = <>
        <div className={styles.cardName}>{team.name}</div>
        <div className={styles.cardMeta}>{team.mission}</div>
        <dl className={styles.cardRows}>
          <Row label="Lead"><span className={styles.who}><Face person={team.lead} size={18} />{PEOPLE[team.lead].name}</span></Row>
          <Row label="Projects">{st.projects}{st.atRisk ? <span className={styles.soft}> · {st.atRisk} need attention</span> : null}</Row>
          <Row label="Open tasks">{st.open}</Row>
          <Row label="Progress">{pct}</Row>
        </dl>
        <p className={styles.cardHint}>Click to zoom into the team</p>
      </>;
    } else if (n.kind === 2) {
      const p = PROJECTS[n.ref];
      body = <>
        <div className={styles.cardName}>{p.name}</div>
        <div className={styles.cardMeta}><span className={styles.dot} data-tone={p.health} />{HEALTH_LABEL[p.health]} · Due {formatDay(p.due)}</div>
        <dl className={styles.cardRows}>
          <Row label="Progress">{pct}</Row>
          <Row label="Tasks done">{st.total - st.open} of {st.total}</Row>
          <Row label="Blocked">{st.blocked}</Row>
          <Row label="Lead"><span className={styles.who}><Face person={p.lead} size={18} />{PEOPLE[p.lead].name}</span></Row>
        </dl>
        <p className={styles.cardHint}>Click to open the project</p>
      </>;
    } else if (n.kind === 3) {
      const t = TASKS[n.ref], s = model.status(n.ref);
      body = <>
        <div className={styles.cardName}>{t.title}</div>
        <div className={styles.cardMeta}><span className={styles.status} data-status={s} />{STATUS_LABEL[s]} · {PROJECTS[t.project].name}</div>
        <dl className={styles.cardRows}>
          <Row label="Assignee"><span className={styles.who}><Face person={t.assignee} size={18} />{PEOPLE[t.assignee].name}</span></Row>
          <Row label="Due">{formatDay(t.due)}</Row>
          <Row label="Checklist">{model.done(n.ref)} of {t.checklist.length}</Row>
          <Row label="Estimate">{t.points} {t.points === 1 ? "point" : "points"}</Row>
        </dl>
        <p className={styles.cardHint}>Click to open the task</p>
      </>;
    } else if (n.kind === 4) {
      const person = PEOPLE[n.ref], project = PROJECTS[NODES[n.parent].ref];
      const mine = project.tasks.filter(t => TASKS[t].assignee === n.ref);
      const active = mine.filter(t => model.status(t) === "progress" || model.status(t) === "review").length;
      body = <>
        <div className={styles.person}><Face person={n.ref} size={36} /><div><div className={styles.cardName}>{person.name}</div><div className={styles.cardMeta}>{person.role}</div></div></div>
        <dl className={styles.cardRows}>
          <Row label={`Tasks in ${project.name}`}>{mine.length}</Row>
          <Row label="Open">{st.open}</Row>
          <Row label="Active now">{active}</Row>
        </dl>
        <p className={styles.cardHint}>{mine.length ? "Click to jump to their current task" : "Click to open the project"}</p>
      </>;
    }
  }
  return <div ref={panelRef} className={styles.card} data-open={node >= 0} aria-hidden="true">{body}</div>;
}

export function SemanticZoom() {
  const reduce = !!useReducedMotion();
  const uid = useId();
  const titleId = `${uid}-title`, hintId = `${uid}-hint`;
  const rootRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const miniRef = useRef<HTMLCanvasElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const readoutRef = useRef<HTMLSpanElement>(null);
  const crumbListRef = useRef<HTMLOListElement>(null);
  const engineRef = useRef<ZoomEngine | null>(null);
  const [hoverStore] = useState(() => createStore(-1));
  const [model] = useState(() => new WorkModel());

  const [path, setPath] = useState<number[]>([0]);
  const [version, setVersion] = useState(0);
  const [zoomed, setZoomed] = useState(false);
  const [touched, setTouched] = useState(false);
  const [touring, setTouring] = useState(false);
  const [live, setLive] = useState("");
  const [crumbW, setCrumbW] = useState(0);

  useEffect(() => {
    const stage = stageRef.current, canvas = canvasRef.current, root = rootRef.current, title = titleRef.current;
    if (!stage || !canvas || !root || !title) return;
    const engine = new ZoomEngine(canvas, miniRef.current, stage, model, {
      hover: hoverStore.set,
      path: setPath,
      zoomed: setZoomed,
      interact: () => setTouched(true),
      tour: setTouring,
      changed: () => setVersion(v => v + 1),
      announce: setLive,
    });
    engineRef.current = engine;
    engine.attachPanel(panelRef.current);
    engine.attachReadout(readoutRef.current);
    const read = () => {
      const cs = getComputedStyle(root);
      const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
      engine.setPalette({
        surface: v("--surface", "#fff"), muted: v("--surface-muted", "#f6f6f6"), fg: v("--foreground", "#111"), secondary: v("--text-secondary", "#555"), faint: v("--text-muted", "#777"),
        border: v("--border", "#e8e8e8"), subtle: v("--border-subtle", "#f1f1f1"), strong: v("--border-strong", "#c8c8c8"), accent: v("--accent", "#333"),
        success: v("--success", "#1f8a4c"), warning: v("--warning", "#b7791f"), danger: v("--danger", "#c53030"),
        body: cs.fontFamily, display: getComputedStyle(title).fontFamily,
      });
    };
    read();
    const themeWatch = new MutationObserver(read);
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-accent", "class", "style"] });
    const scheme = matchMedia("(prefers-color-scheme: dark)");
    scheme.addEventListener("change", read);
    const sizeWatch = new ResizeObserver(([entry]) => engine.resize(entry.contentRect.width, entry.contentRect.height, Math.min(2, window.devicePixelRatio || 1)));
    sizeWatch.observe(stage);
    const viewWatch = new IntersectionObserver(([entry]) => engine.setVisible(entry.isIntersecting), { threshold: .15 });
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
  }, [hoverStore, model]);

  useEffect(() => { engineRef.current?.setReduced(reduce); }, [reduce]);

  /* The breadcrumb frame follows its content width on a spring instead of snapping. */
  useEffect(() => {
    const list = crumbListRef.current;
    if (!list) return;
    const watch = new ResizeObserver(() => setCrumbW(Math.ceil(list.getBoundingClientRect().width)));
    watch.observe(list);
    return () => watch.disconnect();
  }, []);

  /* Announce where the camera settles, not every level it passes on the way. */
  const scope = path[path.length - 1];
  useEffect(() => {
    const t = window.setTimeout(() => { const e = engineRef.current; if (e) setLive(`Now viewing ${e.describeNode(scope)}`); }, 450);
    return () => window.clearTimeout(t);
  }, [scope]);

  const measure = useCallback(() => engineRef.current?.measurePanel(), []);

  const onPointer = (e: ReactPointerEvent<HTMLDivElement>) => {
    const engine = engineRef.current;
    if (!engine) return;
    const overlay = (e.target as Element).closest("button, [data-overlay]");
    if (e.type === "pointerdown") {
      if (overlay || (e.pointerType === "mouse" && e.button !== 0)) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      engine.pointerDown(e.nativeEvent);
    } else if (e.type === "pointermove") {
      if (overlay && !e.currentTarget.hasPointerCapture(e.pointerId)) { engine.pointerLeave(); return; }
      engine.pointerMove(e.nativeEvent);
    } else if (e.type === "pointerup") engine.pointerUp(e.nativeEvent);
    else engine.pointerUp(e.nativeEvent, true);
  };

  const onMini = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e.type === "pointerdown") { e.currentTarget.setPointerCapture(e.pointerId); engineRef.current?.miniPointer(e.nativeEvent); }
    else if (e.currentTarget.hasPointerCapture(e.pointerId)) engineRef.current?.miniPointer(e.nativeEvent);
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const engine = engineRef.current;
    if (!engine || e.target !== e.currentTarget) return;
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    let handled = true;
    if (arrows[e.key]) engine.moveCursor(...arrows[e.key]);
    else if (e.key === "Enter" || e.key === " ") engine.activateCursor();
    else if (e.key === "Escape" || e.key === "Backspace") engine.flyOut();
    else if (e.key === "+" || e.key === "=") engine.zoomBy(1.5);
    else if (e.key === "-" || e.key === "_") engine.zoomBy(1 / 1.5);
    else if (e.key === "0" || e.key === "Home") engine.fitAll();
    else handled = false;
    if (handled) e.preventDefault();
  };

  const stats = model.stats(scope);
  const scopeNode = NODES[scope];
  const pct = Math.round(stats.progress * 100);
  const shownPeople = stats.people.slice(0, 6);
  const t = (d: number) => (reduce ? { duration: 0 } : { duration: d, ease: enter });
  const riseIn = reduce ? false : { opacity: 0, y: 4 };
  const summary = `Workspace map of Northstar Studio: ${TEAMS.length} teams, ${PROJECTS.length} projects and ${TASKS.length} tasks. Currently viewing ${scopeNode.name}. Zoom in to reveal projects, tasks and people.`;

  return <section ref={rootRef} className={styles.root} aria-labelledby={titleId}>
    <header className={styles.header}>
      <h2 id={titleId} ref={titleRef} className={styles.title}>Studio map</h2>
      <p className={styles.lede}>{TEAMS.length} teams, {PROJECTS.length} projects and {TASKS.length} tasks. Zoom in for more detail.</p>
    </header>

    <div className={styles.body}>
      <div ref={stageRef} className={styles.stage} data-zoomed={zoomed} tabIndex={0} role="application" aria-roledescription="zoomable map" aria-label={summary} aria-describedby={hintId}
        onPointerDown={onPointer} onPointerMove={onPointer} onPointerUp={onPointer} onPointerCancel={onPointer}
        onPointerLeave={() => engineRef.current?.pointerLeave()} onKeyDown={onKey}>
        <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />

        <motion.nav className={styles.crumbs} aria-label="Map location" data-overlay="" initial={false} animate={crumbW ? { width: crumbW + 2 } : undefined} transition={reduce ? { duration: 0 } : spring.morph}>
          <ol ref={crumbListRef} className={styles.crumbList}>
            <AnimatePresence initial={false} mode="popLayout">
              {path.map((id, i) => <motion.li key={id} className={styles.crumb} layout={reduce ? false : "position"}
                initial={reduce ? false : { opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }}
                exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, transition: { duration: duration.instant } }}
                transition={reduce ? { duration: 0 } : { ...spring.smooth, opacity: { duration: duration.standard } }}>
                {i > 0 && <ChevronRight className={styles.sep} size={14} strokeWidth={1.75} aria-hidden="true" />}
                {i < path.length - 1
                  ? <button type="button" className={styles.crumbBtn} onClick={() => engineRef.current?.goTo(id)}>{NODES[id].name}</button>
                  : <span className={styles.crumbHere} aria-current="location">{NODES[id].name}</span>}
              </motion.li>)}
            </AnimatePresence>
          </ol>
        </motion.nav>

        <button type="button" className={styles.tour} aria-pressed={touring} onClick={() => engineRef.current?.toggleTour()}>
          <span className={styles.tourIcon} aria-hidden="true">{touring ? <Pause size={16} strokeWidth={1.75} /> : <Play size={16} strokeWidth={1.75} />}</span>
          <span className={styles.tourLabels}>
            <span data-on={!touring}>Take the tour</span>
            <span data-on={touring}>Stop tour</span>
          </span>
        </button>

        <HoverCard store={hoverStore} model={model} version={version} panelRef={panelRef} measure={measure} />

        <div className={styles.mini} data-visible={zoomed} data-overlay="" aria-hidden="true">
          <canvas ref={miniRef} className={styles.miniCanvas} onPointerDown={onMini} onPointerMove={onMini} />
        </div>
        <p className={styles.hint} data-hidden={touched || zoomed} aria-hidden="true">
          <span className={styles.hintFine}>Scroll to zoom, drag to pan, click anything to fly in</span>
          <span className={styles.hintCoarse}>Pinch to zoom, tap anything to fly in</span>
        </p>

        <div className={styles.zoom} data-overlay="">
          <button type="button" aria-label="Zoom out" onClick={() => engineRef.current?.zoomBy(1 / 1.6)}><Minus size={16} strokeWidth={1.75} aria-hidden="true" /></button>
          <span ref={readoutRef} className={styles.readout} aria-hidden="true">1.0×</span>
          <button type="button" aria-label="Zoom in" onClick={() => engineRef.current?.zoomBy(1.6)}><Plus size={16} strokeWidth={1.75} aria-hidden="true" /></button>
          <button type="button" aria-label="Show the whole studio" disabled={!zoomed && path.length === 1} onClick={() => engineRef.current?.fitAll()}><Maximize2 size={15} strokeWidth={1.75} aria-hidden="true" /></button>
        </div>
      </div>
      <p id={hintId} className={styles.srOnly}>Use the arrow keys to move between items in view, Enter to zoom in or tick a checklist item, Escape to zoom out, plus and minus to zoom, and 0 to see the whole studio.</p>

      <aside className={styles.panel} aria-label="Key numbers for the current view">
        <div className={styles.scope}>
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.div key={scope} className={styles.scopeInner} initial={riseIn} animate={{ opacity: 1, y: 0 }}
              exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, transition: { duration: duration.instant } }} transition={t(duration.standard)}>
              <span className={styles.scopeKind}>{KIND_LABEL[scopeNode.kind]}</span>
              <span className={styles.scopeName}>{scopeNode.name}</span>
            </motion.div>
          </AnimatePresence>
        </div>
        <div className={styles.kpiMain}>
          <span className={styles.kpiLabel}>{scopeNode.kind === 3 ? "Checklist complete" : "Progress"}</span>
          <span className={styles.kpiValue}><Roll text={`${pct}%`} /></span>
          <span className={styles.track} aria-hidden="true"><span className={styles.fill} style={{ width: `${Math.max(2, pct)}%` }} /></span>
        </div>
        <dl className={styles.kpis}>
          <div><dt>Open tasks</dt><dd><Roll text={formatCount(stats.open)} /></dd></div>
          <div><dt>Blocked</dt><dd data-alert={stats.blocked > 0}><Roll text={formatCount(stats.blocked)} /></dd></div>
          <div><dt>Next due</dt><dd><Roll text={stats.nextDue === null ? "None" : formatDay(stats.nextDue)} /></dd></div>
        </dl>
        <div className={styles.people}>
          <div className={styles.peopleHead}><span>People</span><span className={styles.peopleCount}><Roll text={formatCount(stats.people.length)} /></span></div>
          <ul className={styles.stack} aria-label={`${stats.people.length} people: ${stats.people.map(p => PEOPLE[p].name).join(", ")}`}>
            <AnimatePresence initial={false} mode="popLayout">
              {shownPeople.map(p => <motion.li key={p} layout={reduce ? false : "position"} title={PEOPLE[p].name}
                initial={reduce ? false : { opacity: 0, scale: .9 }} animate={{ opacity: 1, scale: 1 }} exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, scale: .9, transition: { duration: duration.fast } }}
                transition={reduce ? { duration: 0 } : spring.snappy}>
                <Face person={p} size={28} />
              </motion.li>)}
              {stats.people.length > shownPeople.length && <motion.li key="more" layout={reduce ? false : "position"} className={styles.more} initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={reduce ? { duration: 0 } : spring.snappy}>+{stats.people.length - shownPeople.length}</motion.li>}
            </AnimatePresence>
          </ul>
          <p className={styles.peopleNote}>{scopeNode.kind === 3 ? `Assigned to ${PEOPLE[stats.people[0]].name}` : stats.projects ? `${stats.projects} projects, ${stats.atRisk} need attention` : `Led by ${PEOPLE[PROJECTS[scopeNode.ref].lead].name}`}</p>
        </div>
      </aside>
    </div>

    <div className={styles.srOnly}><table>
      <caption>Projects at Northstar Studio by team</caption>
      <thead><tr><th scope="col">Team</th><th scope="col">Project</th><th scope="col">Health</th><th scope="col">Progress</th><th scope="col">Open tasks</th><th scope="col">Blocked</th><th scope="col">Due</th></tr></thead>
      <tbody>{PROJECTS.map((p, i) => {
        const st = model.stats(NODES.findIndex(n => n.kind === 2 && n.ref === i));
        return <tr key={p.id}><td>{TEAMS[p.team].name}</td><th scope="row">{p.name}</th><td>{HEALTH_LABEL[p.health]}</td><td>{Math.round(st.progress * 100)}%</td><td>{st.open}</td><td>{st.blocked}</td><td>{formatDay(p.due)}</td></tr>;
      })}</tbody>
    </table></div>
    <p className={styles.srOnly} aria-live="polite">{live}</p>
  </section>;
}

export default SemanticZoom;
