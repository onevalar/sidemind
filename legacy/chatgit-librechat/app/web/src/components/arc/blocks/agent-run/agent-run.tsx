"use client";

import { memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import Image from "next/image";
import { AnimatePresence, motion, useInView, useReducedMotion, type Transition } from "motion/react";
import { Check, ChevronDown, CircleCheck, FilePen, FileText, FlaskConical, GitPullRequest, LoaderCircle, Pause, Play, RotateCcw, Search, Sparkles, X } from "lucide-react";
import { AnimatedCounter } from "../../animated-counter/animated-counter";
import { motionTokens } from "../../lib/motion-tokens";
import { GATE, GATE_END, REQUEST, RESULT, STEPS, TIMING, TOTAL, seconds, tokensAt, type Step, type StepKind } from "./agent-run-data";
import styles from "./agent-run.module.css";

const { spring, duration, ease } = motionTokens;
const enterEase = [...ease.enter] as [number, number, number, number];

type Phase = "idle" | "running" | "paused" | "waiting" | "done" | "stopped";
type Run = { clock: number; phase: Phase; approved: boolean };
type StepStatus = "active" | "waiting" | "done" | "rejected";

const FRESH: Run = { clock: 0, phase: "idle", approved: false };
const STATUS: Record<Phase, string> = { idle: "Starting", running: "Working", paused: "Paused", waiting: "Waiting for approval", done: "Done", stopped: "Stopped" };
const ICON: Record<StepKind, typeof Search> = { think: Sparkles, search: Search, read: FileText, edit: FilePen, test: FlaskConical };
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** Moves the run clock forward. The clock stops at the edit until someone approves it, and at the end of the script. */
function advance(run: Run, dt: number): Run {
  if (run.phase !== "running" && run.phase !== "idle") return run;
  const clock = run.clock + dt;
  if (!run.approved && clock >= GATE_END) return { ...run, clock: GATE_END, phase: "waiting" };
  if (clock >= TOTAL) return { ...run, clock: TOTAL, phase: "done" };
  return { ...run, clock, phase: "running" };
}

function useMotion() {
  const reduce = !!useReducedMotion();
  const panel: Transition = reduce ? { duration: 0 } : spring.smooth;
  return { reduce, panel };
}

/** Height follows the content on a spring, so streamed text that wraps onto a new line grows the step instead of jumping. */
function AutoHeight({ children, className }: { children: ReactNode; className?: string }) {
  const { panel } = useMotion();
  const inner = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | "auto">("auto");
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setHeight(el.offsetHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return <motion.div className={styles.autoHeight} initial={false} animate={{ height }} transition={panel}>
    <div ref={inner} className={className}>{children}</div>
  </motion.div>;
}

/** Two labels share one cell, so switching between them never changes the control's width. */
function Stack({ on, a, b }: { on: "a" | "b"; a: ReactNode; b: ReactNode }) {
  return <span className={styles.stack}>
    <span data-on={on === "a" || undefined} aria-hidden={on !== "a" || undefined}>{a}</span>
    <span data-on={on === "b" || undefined} aria-hidden={on !== "b" || undefined}>{b}</span>
  </span>;
}

/** Copy keyed by its text crossfades in place when it changes. */
function Swap({ text, className }: { text: string; className?: string }) {
  const { reduce } = useMotion();
  return <span className={styles.swap}>
    <AnimatePresence initial={false} mode="popLayout">
      <motion.span key={text} className={className}
        initial={reduce ? { opacity: 0 } : { opacity: 0, y: "0.25em" }}
        animate={{ opacity: 1, y: "0em" }}
        exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: "-0.2em", transition: { duration: duration.fast } }}
        transition={reduce ? { duration: duration.instant } : { duration: duration.standard, ease: enterEase }}>{text}</motion.span>
    </AnimatePresence>
  </span>;
}

function Streamed({ text, progress }: { text: string; progress: number }) {
  const words = text.split(" ");
  const shown = Math.ceil(progress * words.length);
  return <AutoHeight>
    <p className={styles.thought}>{words.slice(0, shown).map((word, i) => <span key={i} className={styles.word}>{word}{i < words.length - 1 ? " " : ""}</span>)}</p>
  </AutoHeight>;
}

type DetailProps = { step: Step; status: StepStatus; progress: number; onApprove: () => void; onReject: () => void };

function Details({ step, status, progress, onApprove, onReject }: DetailProps) {
  const all = status !== "active";
  const count = (n: number, lead = 0) => all ? n : Math.min(n, Math.floor(clamp01((progress - lead) / (1 - lead)) * (n + 1)));

  if (step.kind === "think") return <Streamed text={step.text} progress={all ? 1 : progress} />;

  if (step.kind === "search") {
    const hits = step.hits.slice(0, count(step.hits.length, .2));
    return <div className={styles.detailBody}>
      <p className={styles.args}><span className={styles.muted}>Query</span> <code>{step.query}</code> <span className={styles.muted}>in</span> <code>{step.scope}</code></p>
      <ul className={styles.hits}>
        {hits.map(hit => <li key={hit.file} className={styles.line}>
          <span className={styles.hitFile}>{hit.file}<span className={styles.muted}>:{hit.line}</span></span>
          <code className={styles.hitText}>{hit.text}</code>
        </li>)}
      </ul>
    </div>;
  }

  if (step.kind === "read") {
    const lines = step.lines.slice(0, count(step.lines.length, .1));
    return <div className={styles.detailBody}>
      <p className={styles.args}><code>{step.path}</code> <span className={styles.muted}>lines {step.lines[0].n}–{step.lines[step.lines.length - 1].n}</span></p>
      <pre className={styles.code}>{lines.map(line => <span key={line.n} className={styles.line} data-hot={line.n === 40 || undefined}>
        <span className={styles.gutter}>{line.n}</span><span className={styles.src}>{line.text}</span>
      </span>)}</pre>
    </div>;
  }

  if (step.kind === "edit") {
    const lines = step.diff.slice(0, count(step.diff.length, .15));
    const added = step.diff.filter(line => line.kind === "add").length, removed = step.diff.filter(line => line.kind === "remove").length;
    return <div className={styles.detailBody}>
      <p className={styles.args}><code>{step.path}</code> <span className={styles.added}>+{added}</span> <span className={styles.removed}>−{removed}</span></p>
      <pre className={styles.code} data-rejected={status === "rejected" || undefined}>{lines.map((line, i) => <span key={i} className={styles.line} data-kind={line.kind}>
        <span className={styles.gutter}>{line.kind === "remove" ? "" : line.n}</span>
        <span className={styles.sign} aria-hidden="true">{line.kind === "add" ? "+" : line.kind === "remove" ? "−" : ""}</span>
        <span className={styles.src}><span className={styles.srOnly}>{line.kind === "add" ? "Added: " : line.kind === "remove" ? "Removed: " : ""}</span>{line.text}</span>
      </span>)}</pre>
      <AnimatePresence initial={false} mode="popLayout">
        {status === "waiting" && <motion.div key="ask" className={styles.approval} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: { duration: duration.fast } }} transition={{ duration: duration.standard, ease: enterEase }}>
          <span className={styles.approvalText}>Apply this change to retry.ts?</span>
          <span className={styles.approvalActions}>
            <button type="button" className={styles.ghost} onClick={onReject}><X size={16} strokeWidth={1.75} aria-hidden="true" />Reject</button>
            <button type="button" className={styles.primary} onClick={onApprove}><Check size={16} strokeWidth={1.75} aria-hidden="true" />Approve</button>
          </span>
        </motion.div>}
        {status === "done" && <motion.p key="yes" className={styles.verdict} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: duration.standard }}><Check size={14} strokeWidth={1.75} aria-hidden="true" />Approved by you</motion.p>}
        {status === "rejected" && <motion.p key="no" className={styles.verdict} data-tone="danger" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: duration.standard }}><X size={14} strokeWidth={1.75} aria-hidden="true" />Rejected, nothing was written</motion.p>}
      </AnimatePresence>
    </div>;
  }

  const results = step.results.slice(0, count(step.results.length, .12));
  const passed = all ? step.passed : Math.floor(clamp01((progress - .12) / .88) * step.passed);
  return <div className={styles.detailBody}>
    <p className={styles.args}><span className={styles.muted}>$</span> <code>{step.command}</code></p>
    <ul className={styles.hits}>
      {results.map(result => <li key={result.name} className={styles.line}>
        <span className={styles.pass}><Check size={14} strokeWidth={2} aria-label="Passed" /></span>
        <span className={styles.testName}><span className={styles.muted}>{result.file} ›</span> {result.name}</span>
        <span className={styles.testTime}>{result.time}</span>
      </li>)}
    </ul>
    <p className={styles.tally}>
      <span className={styles.tallyCount}><AnimatedCounter value={passed} /></span>
      <span>of {step.passed} tests passed</span>
    </p>
  </div>;
}

type RowProps = DetailProps & { open: boolean; auto: boolean; paused: boolean; ids: string; onToggle: (id: string, auto: boolean) => void; isLast: boolean };

/** Memoized: a finished step keeps the same props while the clock ticks, so only the active step re-renders on each beat. */
const StepRow = memo(function StepRow({ step, status, progress, open, auto, paused, ids, onToggle, onApprove, onReject, isLast }: RowProps) {
  const { reduce, panel } = useMotion();
  const Icon = ICON[step.kind];
  const detailsId = `${ids}-${step.id}-details`;
  const title = status === "done" ? step.done : status === "waiting" ? "Waiting for approval" : status === "rejected" ? "Change rejected" : step.running;
  const fill = status === "active" ? progress : status === "rejected" ? 0 : 1;
  return <motion.li className={styles.step} data-status={status} data-paused={paused || undefined}
    initial={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }}
    exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }} transition={reduce ? { duration: duration.instant } : { height: panel, opacity: { duration: duration.standard } }}>
    <div className={styles.rail} aria-hidden="true">
      <span className={styles.node}><Icon size={14} strokeWidth={1.75} /></span>
      {!isLast && <span className={styles.track}><motion.span className={styles.fill} initial={false} animate={{ scaleY: fill }} transition={panel} /></span>}
    </div>
    <div className={styles.stepMain}>
      <button type="button" id={`${ids}-${step.id}-toggle`} className={styles.stepHead} aria-expanded={open} aria-controls={open ? detailsId : undefined} onClick={() => onToggle(step.id, auto)}>
        <Swap text={title} className={status === "active" && !paused ? `${styles.stepTitle} ${styles.shimmer}` : styles.stepTitle} />
        <span className={styles.stepMeta}>{status === "done" ? seconds(step.duration) : status === "active" ? seconds(progress * step.duration) : ""}</span>
        <ChevronDown className={styles.chevron} size={16} strokeWidth={1.75} aria-hidden="true" />
      </button>
      <AnimatePresence initial={false}>
        {open && <motion.div key="details" id={detailsId} role="region" aria-label={`${step.done} details`} className={styles.details}
          initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
          transition={reduce ? { duration: 0 } : { height: panel, opacity: { duration: duration.standard } }}>
          <div className={styles.detailPad}><Details step={step} status={status} progress={progress} onApprove={onApprove} onReject={onReject} /></div>
        </motion.div>}
      </AnimatePresence>
    </div>
  </motion.li>;
});

type PullRequest = "idle" | "opening" | "opened";

/**
 * A live view of an AI agent working through a task: the request, a timeline of steps that stream in and expand in place,
 * an approval gate before the agent writes code, and a result the timeline folds into when the run finishes.
 * The run is scripted and simulated; nothing is executed.
 */
export function AgentRun() {
  const { reduce, panel } = useMotion();
  const ids = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const root = useRef<HTMLElement>(null);
  const inView = useInView(root, { once: true, amount: .35 });
  // Scrolled away, the run holds its place, so nobody comes back to a run that finished without them.
  const onScreen = useInView(root, { amount: 0 });
  const [run, setRun] = useState<Run>(FRESH);
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [pr, setPr] = useState<PullRequest>("idle");
  const prTimer = useRef<number | undefined>(undefined);
  const pauseButton = useRef<HTMLButtonElement>(null);

  // The run starts the first time the block scrolls into view.
  const phase: Phase = run.phase === "idle" && inView ? "running" : run.phase;
  const ticking = phase === "running" && onScreen;

  useEffect(() => {
    if (!ticking) return;
    let last = performance.now();
    const id = window.setInterval(() => {
      const now = performance.now();
      // A hidden tab holds the clock where it is.
      const dt = document.hidden ? 0 : Math.min(now - last, 200);
      last = now;
      if (dt > 0) setRun(current => advance(current, dt));
    }, 60);
    return () => window.clearInterval(id);
  }, [ticking]);

  useEffect(() => () => window.clearTimeout(prTimer.current), []);

  const focusStep = useCallback((id: string) => requestAnimationFrame(() => document.getElementById(`${ids}-${id}-toggle`)?.focus({ preventScroll: true })), [ids]);
  const restart = () => {
    window.clearTimeout(prTimer.current);
    setRun({ ...FRESH, phase: "running" });
    setToggled({});
    setTimelineOpen(false);
    setPr("idle");
    requestAnimationFrame(() => pauseButton.current?.focus({ preventScroll: true }));
  };
  const togglePause = () => setRun(current => current.phase === "running" || current.phase === "idle" ? { ...current, phase: "paused" } : current.phase === "paused" ? { ...current, phase: "running" } : current);
  const approve = useCallback(() => { setRun(current => ({ ...current, approved: true, phase: "running" })); focusStep(STEPS[GATE].id); }, [focusStep]);
  const reject = useCallback(() => { setRun(current => ({ ...current, phase: "stopped" })); focusStep(STEPS[GATE].id); }, [focusStep]);
  const toggleStep = useCallback((id: string, auto: boolean) => setToggled(t => ({ ...t, [id]: !(t[id] ?? auto) })), []);
  const retryEdit = () => {
    setRun({ clock: TIMING[GATE].start, phase: "running", approved: false });
    setToggled(current => ({ ...current, [STEPS[GATE].id]: true }));
    focusStep(STEPS[GATE].id);
  };
  const openPr = () => {
    if (pr !== "idle") return;
    setPr("opening");
    prTimer.current = window.setTimeout(() => setPr("opened"), 1100);
  };

  const { clock, approved } = run;
  const finished = phase === "done" || phase === "stopped";
  const statusOf = (i: number): StepStatus => {
    if (i === GATE && phase === "stopped") return "rejected";
    if (i === GATE && phase === "waiting") return "waiting";
    if (clock >= TIMING[i].end && (i !== GATE || approved)) return "done";
    return "active";
  };
  const visible = phase === "idle" ? [] : STEPS.map((step, i) => ({ step, i })).filter(({ i }) => i === 0 || clock > TIMING[i].start);
  const current = visible[visible.length - 1];
  const listOpen = !finished || timelineOpen;
  const tokens = tokensAt(clock);
  const worked = seconds(clock);

  const live = phase === "waiting" ? "Waiting for your approval to edit src/payments/retry.ts"
    : phase === "done" ? `Run finished in ${worked}. ${RESULT.title}.`
    : phase === "stopped" ? "Run stopped. The change was rejected and nothing was written."
    : phase === "paused" ? "Run paused"
    : current ? `${current.step.running}` : "";

  return <section ref={root} className={styles.root} aria-labelledby={`${ids}-title`}>
    <header className={styles.request}>
      <div className={styles.byline}>
        <Image className={styles.avatar} src={REQUEST.avatar} alt="" width={28} height={28} />
        <span className={styles.author} id={`${ids}-title`}>{REQUEST.author}</span>
        <span className={styles.muted}>{REQUEST.repo}</span>
      </div>
      <p className={styles.prompt}>{REQUEST.prompt}</p>
    </header>

    <div className={styles.toolbar}>
      <span className={styles.status} data-phase={phase}>
        <span className={styles.dot} aria-hidden="true" />
        <Swap text={STATUS[phase]} />
      </span>
      <span className={styles.counters}>
        <span className={styles.counter}><span className={styles.srOnly}>Time</span>{worked}</span>
        <span className={styles.counter}><span className={styles.tokens}><AnimatedCounter value={tokens} /></span> tokens</span>
      </span>
      <span className={styles.controls}>
        <button ref={pauseButton} type="button" className={styles.ghost} onClick={togglePause} disabled={phase !== "running" && phase !== "paused"}>
          <Stack on={phase === "paused" ? "b" : "a"}
            a={<><Pause size={16} strokeWidth={1.75} aria-hidden="true" />Pause</>}
            b={<><Play size={16} strokeWidth={1.75} aria-hidden="true" />Resume</>} />
        </button>
        <button type="button" className={styles.iconButton} onClick={restart} aria-label="Restart run" title="Restart run">
          <RotateCcw size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </span>
    </div>

    <div className={styles.run}>
      <AnimatePresence initial={false}>
        {finished && <motion.div key="summary" className={styles.summaryWrap}
          initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
          transition={reduce ? { duration: 0 } : { height: panel, opacity: { duration: duration.standard } }}>
          <button type="button" className={styles.summary} aria-expanded={timelineOpen} onClick={() => setTimelineOpen(open => !open)}>
            <span>Worked for {worked}</span>
            <span className={styles.muted}>{visible.length} steps · {tokens.toLocaleString("en-US")} tokens</span>
            <ChevronDown className={styles.chevron} size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </motion.div>}
      </AnimatePresence>

      <motion.div className={styles.timelineWrap} initial={false} animate={{ height: listOpen ? "auto" : 0, opacity: listOpen ? 1 : 0 }}
        transition={reduce ? { duration: 0 } : { height: panel, opacity: { duration: duration.standard } }} inert={!listOpen}>
        <ol className={styles.timeline} aria-label="Steps">
          <AnimatePresence initial={false}>
            {visible.map(({ step, i }, n) => {
              const status = statusOf(i);
              const auto = status === "active" || status === "waiting" || status === "rejected";
              return <StepRow key={step.id} step={step} ids={ids} status={status} isLast={n === visible.length - 1 && finished}
                progress={status === "active" ? clamp01((clock - TIMING[i].start) / step.duration) : 1} paused={phase === "paused"}
                open={status === "waiting" || (toggled[step.id] ?? auto)} auto={auto} onToggle={toggleStep}
                onApprove={approve} onReject={reject} />;
            })}
          </AnimatePresence>
        </ol>
      </motion.div>

      <AnimatePresence initial={false}>
        {finished && <motion.div key={phase} className={styles.resultWrap}
          initial={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
          transition={reduce ? { duration: duration.instant } : { height: panel, opacity: { duration: duration.considered, ease: enterEase } }}>
          <motion.div className={styles.result} data-tone={phase === "done" ? "success" : "danger"}
            initial={reduce ? false : { y: 8 }} animate={{ y: 0 }} transition={reduce ? { duration: 0 } : spring.smooth}>
            {phase === "done" ? <>
              <h3 className={styles.resultTitle}><CircleCheck size={20} strokeWidth={1.75} aria-hidden="true" />{RESULT.title}</h3>
              <p className={styles.resultBody}>{RESULT.body}</p>
              <dl className={styles.facts}>
                <div><dt>Files changed</dt><dd>1</dd></div>
                <div><dt>Lines</dt><dd><span className={styles.added}>+2</span> <span className={styles.removed}>−1</span></dd></div>
                <div><dt>Tests</dt><dd>24 passed</dd></div>
                <div><dt>Tokens</dt><dd>{tokens.toLocaleString("en-US")}</dd></div>
              </dl>
              <div className={styles.actions}>
                <button type="button" className={styles.primary} onClick={openPr} aria-disabled={pr !== "idle" || undefined} data-state={pr}>
                  <span className={styles.stack3}>
                    <span data-on={pr === "idle" || undefined} aria-hidden={pr !== "idle" || undefined}><GitPullRequest size={16} strokeWidth={1.75} aria-hidden="true" />Open pull request</span>
                    <span data-on={pr === "opening" || undefined} aria-hidden={pr !== "opening" || undefined}><LoaderCircle className={styles.spin} size={16} strokeWidth={1.75} aria-hidden="true" />Opening</span>
                    <span data-on={pr === "opened" || undefined} aria-hidden={pr !== "opened" || undefined}><Check size={16} strokeWidth={1.75} aria-hidden="true" />Draft #{RESULT.pr} opened</span>
                  </span>
                </button>
                <button type="button" className={styles.ghost} onClick={restart}><RotateCcw size={16} strokeWidth={1.75} aria-hidden="true" />Run again</button>
              </div>
              <p className={styles.srOnly} aria-live="polite">{pr === "opened" ? `Draft pull request ${RESULT.pr} opened.` : ""}</p>
            </> : <>
              <h3 className={styles.resultTitle}><X size={20} strokeWidth={1.75} aria-hidden="true" />Run stopped</h3>
              <p className={styles.resultBody}>You rejected the change to retry.ts, so nothing was written. The diagnosis above still stands, and the agent can propose the edit again.</p>
              <div className={styles.actions}>
                <button type="button" className={styles.primary} onClick={retryEdit}><RotateCcw size={16} strokeWidth={1.75} aria-hidden="true" />Retry the edit</button>
                <button type="button" className={styles.ghost} onClick={restart}>Start over</button>
              </div>
            </>}
          </motion.div>
        </motion.div>}
      </AnimatePresence>
    </div>

    <p className={styles.srOnly} aria-live="polite">{live}</p>
  </section>;
}

export default AgentRun;
