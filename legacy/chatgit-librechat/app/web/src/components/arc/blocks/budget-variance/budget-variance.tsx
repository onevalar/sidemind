"use client";

import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion, type MotionValue } from "motion/react";
import { ChevronDown } from "lucide-react";
import { motionTokens } from "../../lib/motion-tokens";
import { Avatar } from "../../avatar/avatar";
import SegmentedControl from "../../segmented-control/segmented-control";
import { budgetDepartments, budgetPeriods, type BudgetDepartment, type BudgetPeriod } from "./budget-variance-data";
import styles from "./budget-variance.module.css";

export type { BudgetDepartment, BudgetLine, BudgetPeriod } from "./budget-variance-data";
export { budgetDepartments, budgetPeriods } from "./budget-variance-data";

export interface BudgetVarianceProps {
  /** Departments with their budget lines. Amounts are keyed by period id. */
  departments?: BudgetDepartment[];
  /** Reporting windows offered by the switch. */
  periods?: BudgetPeriod[];
  /** Id of the window shown first. Defaults to the first period. */
  defaultPeriod?: string;
  /** Id of the department opened on first render. Pass null to start with every department closed. */
  defaultExpanded?: string | null;
  /** Qualitative bands as shares of budget: [lower, upper]. Spend between them is within tolerance. */
  ranges?: [number, number];
  /** Variance smaller than this share of budget reads as on plan. */
  onPlanThreshold?: number;
  /** Currency symbol placed before amounts. */
  currency?: string;
  title?: string;
  /** Replaces the period description under the title. */
  description?: string;
  onPeriodChange?: (periodId: string) => void;
  onDepartmentToggle?: (departmentId: string, open: boolean) => void;
  className?: string;
}

type Tone = "over" | "under" | "plan";
interface Figures { budget: number; actual: number; variance: number; share: number; ratio: number; tone: Tone }

const MINUS = "−";

function figures(budget: number, actual: number, threshold: number): Figures {
  const variance = actual - budget;
  const share = budget > 0 ? variance / budget : 0;
  const tone: Tone = Math.abs(share) < threshold ? "plan" : share > 0 ? "over" : "under";
  return { budget, actual, variance, share, ratio: budget > 0 ? actual / budget : 0, tone };
}

function money(value: number, currency: string, signed = false) {
  const size = Math.abs(value);
  const sign = !signed || Math.round(size) === 0 ? "" : value > 0 ? "+" : MINUS;
  const body = size >= 999_500 ? `${(size / 1_000_000).toFixed(2)}M` : size >= 1000 ? `${(size / 1000).toFixed(1)}k` : `${Math.round(size)}`;
  return `${sign}${currency}${body}`;
}

function percent(value: number) {
  const rounded = Math.round(value * 1000) / 10;
  return `${rounded > 0 ? "+" : rounded < 0 ? MINUS : ""}${Math.abs(rounded).toFixed(1)}%`;
}

const toneWord: Record<Tone, string> = { over: "over", under: "under", plan: "on plan" };

function sentence(name: string, f: Figures, currency: string, phrase: string) {
  const gap = money(Math.abs(f.variance), currency);
  const state = f.tone === "plan" ? "on plan" : `${gap} ${f.tone} budget, ${Math.abs(Math.round(f.share * 1000) / 10).toFixed(1)}%${f.tone === "over" ? ", unfavorable" : ", favorable"}`;
  return `${name}: ${money(f.actual, currency)} spent of ${money(f.budget, currency)} ${phrase}, ${state}.`;
}

/** A motion value that springs to each new target. Interruptible: a new target starts from wherever the value is. */
function useSpringValue(target: number, reduce: boolean) {
  const value = useMotionValue(target);
  useEffect(() => {
    if (reduce) { value.jump(target); return; }
    const controls = animate(value, target, motionTokens.spring.smooth);
    return () => controls.stop();
  }, [reduce, target, value]);
  return value;
}

/** A number that counts to its new value. The text is written straight to the DOM, so a tween never re-renders React. */
function Count({ value, format, reduce, className }: { value: number; format: (value: number) => string; reduce: boolean; className?: string }) {
  const node = useRef<HTMLSpanElement>(null);
  const [initial] = useState(() => format(value));
  const motionValue = useSpringValue(value, reduce);
  const formatRef = useRef(format);
  useEffect(() => { formatRef.current = format; });
  useEffect(() => {
    const write = (current: number) => { if (node.current) node.current.textContent = formatRef.current(current); };
    write(motionValue.get());
    return motionValue.on("change", write);
  }, [motionValue]);
  return <span ref={node} className={className}>{initial}</span>;
}

/** Bullet chart: qualitative bands, the actual bar, and the budget tick at a fixed share of the scale. */
function Bullet({ ratio, scaleMax, ranges, reduce, size }: { ratio: number; scaleMax: number; ranges: [number, number]; reduce: boolean; size: "total" | "department" | "line" }) {
  const fill = useSpringValue(Math.min(ratio, scaleMax) / scaleMax, reduce);
  const at = (share: number) => `${(Math.min(share, scaleMax) / scaleMax) * 100}%`;
  return <span className={styles.bullet} data-size={size} style={{ "--target": at(1) } as CSSProperties} aria-hidden="true">
    <span className={styles.track}>
      <span className={styles.band} style={{ left: 0, width: at(ranges[0]) }} />
      <span className={styles.band} data-band="tolerance" style={{ left: at(ranges[0]), width: `calc(${at(ranges[1])} - ${at(ranges[0])})` }} />
      <span className={styles.band} data-band="over" style={{ left: at(ranges[1]), right: 0 }} />
      <Bar fill={fill} />
      <span className={styles.overClip}><Bar fill={fill} over /></span>
    </span>
    <span className={styles.tick} />
  </span>;
}

function Bar({ fill, over }: { fill: MotionValue<number>; over?: boolean }) {
  return <motion.span className={styles.bar} data-over={over || undefined} style={{ scaleX: fill }} />;
}

/** Variance as a signed amount over a signed share, colored by whether it helps or hurts. */
function Variance({ f, currency, threshold, reduce, large }: { f: Figures; currency: string; threshold: number; reduce: boolean; large?: boolean }) {
  // The word follows the counting share, so "over" and "under" never disagree with the number beside them mid-count.
  const share = (value: number) => `${percent(value)} ${toneWord[Math.abs(value) < threshold ? "plan" : value > 0 ? "over" : "under"]}`;
  return <span className={styles.variance} data-tone={f.tone} data-large={large || undefined}>
    <Count value={f.variance} format={value => money(value, currency, true)} reduce={reduce} className={styles.varianceAmount} />
    <Count value={f.share} format={share} reduce={reduce} className={styles.varianceShare} />
  </span>;
}

export function BudgetVariance({
  departments = budgetDepartments,
  periods = budgetPeriods,
  defaultPeriod,
  defaultExpanded = "engineering",
  ranges = [0.9, 1.1],
  onPlanThreshold = 0.005,
  currency = "$",
  title = "Budget vs actual",
  description,
  onPeriodChange,
  onDepartmentToggle,
  className,
}: BudgetVarianceProps) {
  const id = useId();
  const reduce = !!useReducedMotion();
  const [periodId, setPeriodId] = useState(() => (periods.some(p => p.id === defaultPeriod) ? defaultPeriod! : periods[0]?.id ?? ""));
  const [open, setOpen] = useState<string | null>(() => (defaultExpanded && departments.some(d => d.id === defaultExpanded) ? defaultExpanded : null));
  const [announcement, setAnnouncement] = useState("");
  const list = useRef<HTMLUListElement>(null);
  const period = periods.find(p => p.id === periodId) ?? periods[0];

  // One scale for every row, stable across periods, so the budget tick lines up down the whole table and never moves.
  const scaleMax = useMemo(() => {
    let max = Math.max(1.2, ranges[1] + 0.1);
    for (const department of departments) for (const item of department.lines) for (const p of periods) {
      const budget = item.budget[p.id] ?? 0;
      if (budget > 0) max = Math.max(max, (item.actual[p.id] ?? 0) / budget);
    }
    return Math.ceil(max * 10 - 1e-9) / 10;
  }, [departments, periods, ranges]);

  const rows = useMemo(() => departments.map(department => {
    const lines = department.lines.map(item => ({ item, f: figures(item.budget[periodId] ?? 0, item.actual[periodId] ?? 0, onPlanThreshold) }));
    const budget = lines.reduce((sum, row) => sum + row.f.budget, 0);
    const actual = lines.reduce((sum, row) => sum + row.f.actual, 0);
    return { department, lines, f: figures(budget, actual, onPlanThreshold) };
  }), [departments, onPlanThreshold, periodId]);

  const total = useMemo(() => figures(rows.reduce((sum, row) => sum + row.f.budget, 0), rows.reduce((sum, row) => sum + row.f.actual, 0), onPlanThreshold), [onPlanThreshold, rows]);
  const phrase = period?.phrase ?? "";
  const ticks = [0, 0.5, 1].filter(share => share <= scaleMax);

  const choosePeriod = (next: string) => {
    if (next === periodId) return;
    setPeriodId(next);
    onPeriodChange?.(next);
    const chosen = periods.find(p => p.id === next);
    let budget = 0, actual = 0;
    for (const department of departments) for (const item of department.lines) { budget += item.budget[next] ?? 0; actual += item.actual[next] ?? 0; }
    setAnnouncement(chosen ? `Showing ${chosen.description}. ${sentence("Total operating spend", figures(budget, actual, onPlanThreshold), currency, chosen.phrase)}` : "");
  };

  const toggle = (departmentId: string) => {
    const next = open === departmentId ? null : departmentId;
    if (open && open !== departmentId) onDepartmentToggle?.(open, false);
    setOpen(next);
    onDepartmentToggle?.(departmentId, next === departmentId);
  };

  // Arrow keys, Home and End move between department rows; Tab still reaches the switch and leaves the list.
  const onRowKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const buttons = Array.from(list.current?.querySelectorAll<HTMLButtonElement>("[data-row]") ?? []);
    const last = buttons.length - 1;
    const target = event.key === "ArrowDown" ? Math.min(last, index + 1) : event.key === "ArrowUp" ? Math.max(0, index - 1) : event.key === "Home" ? 0 : event.key === "End" ? last : -1;
    if (target < 0) return;
    event.preventDefault();
    buttons[target]?.focus();
  };

  const panelTransition = reduce ? { duration: 0 } : motionTokens.spring.smooth;
  const exitTransition = reduce ? { duration: 0 } : { duration: motionTokens.duration.exit, ease: [...motionTokens.ease.standard] as [number, number, number, number] };

  return <section className={[styles.root, className].filter(Boolean).join(" ")} aria-labelledby={`${id}-title`}>
    <div className={styles.inner}>
      <header className={styles.header}>
        <div className={styles.heading}>
          <h2 id={`${id}-title`} className={styles.title}>{title}</h2>
          <p className={styles.description}>{description ?? period?.description}</p>
        </div>
        {periods.length > 1 && <SegmentedControl className={styles.switch} label="Reporting period" options={periods.map(p => ({ value: p.id, label: p.label }))} value={periodId} onValueChange={choosePeriod} />}
      </header>

      {rows.length === 0 ? <p className={styles.empty}>No departments have a budget for this period yet. Add a budget line to compare it with actual spend.</p> : <div className={styles.table}>
        <div className={`${styles.grid} ${styles.head}`} aria-hidden="true">
          <span className={styles.colName}>Department</span>
          <span className={styles.axis} style={{ "--target": `${100 / scaleMax}%` } as CSSProperties}>
            {ticks.map(share => <span key={share} className={styles.axisTick} data-edge={share === 0 ? "start" : undefined} style={{ left: `${(share / scaleMax) * 100}%` }}>{`${Math.round(share * 100)}%`}</span>)}
          </span>
          <span className={styles.colNum}>Actual</span>
          <span className={styles.colNum}>Budget</span>
          <span className={styles.colNum}>Variance</span>
          <span className={styles.spacer} />
        </div>

        <div className={styles.totalItem}>
        <div className={`${styles.grid} ${styles.total}`} aria-hidden="true">
          <span className={styles.name}>
            <span className={styles.nameText}>
              <span className={styles.primary}>Total operating spend</span>
              <span className={styles.secondary} data-show="wide">{rows.length} departments</span>
              <span className={styles.secondary} data-show="narrow"><Count value={total.actual} format={v => money(v, currency)} reduce={reduce} /> of <Count value={total.budget} format={v => money(v, currency)} reduce={reduce} /></span>
            </span>
          </span>
          <span className={styles.chart}><Bullet ratio={total.ratio} scaleMax={scaleMax} ranges={ranges} reduce={reduce} size="total" /></span>
          <Count value={total.actual} format={v => money(v, currency)} reduce={reduce} className={`${styles.num} ${styles.lead}`} />
          <Count value={total.budget} format={v => money(v, currency)} reduce={reduce} className={`${styles.num} ${styles.muted}`} />
          <Variance f={total} currency={currency} threshold={onPlanThreshold} reduce={reduce} large />
          <span className={styles.spacer} />
        </div>
        <p className={styles.srOnly}>{sentence("Total operating spend", total, currency, phrase)}</p>
        </div>

        <ul ref={list} className={styles.list}>
          {rows.map(({ department, lines, f }, index) => {
            const isOpen = open === department.id;
            const panelId = `${id}-${department.id}-lines`;
            return <li key={department.id} className={styles.group} data-open={isOpen || undefined}>
              <h3 className={styles.rowHeading}>
                <button type="button" data-row className={`${styles.grid} ${styles.row}`} aria-expanded={isOpen} aria-controls={panelId} aria-label={sentence(department.name, f, currency, phrase)} onClick={() => toggle(department.id)} onKeyDown={event => onRowKey(event, index)}>
                  <span className={styles.name}>
                    <Avatar name={department.owner.name} src={department.owner.avatar} size="sm" className={styles.avatar} aria-hidden="true" />
                    <span className={styles.nameText}>
                      <span className={styles.primary}>{department.name}</span>
                      <span className={styles.secondary} data-show="wide">{department.owner.name}</span>
                      <span className={styles.secondary} data-show="narrow"><Count value={f.actual} format={v => money(v, currency)} reduce={reduce} /> of <Count value={f.budget} format={v => money(v, currency)} reduce={reduce} /></span>
                    </span>
                  </span>
                  <span className={styles.chart}><Bullet ratio={f.ratio} scaleMax={scaleMax} ranges={ranges} reduce={reduce} size="department" /></span>
                  <Count value={f.actual} format={v => money(v, currency)} reduce={reduce} className={styles.num} />
                  <Count value={f.budget} format={v => money(v, currency)} reduce={reduce} className={`${styles.num} ${styles.muted}`} />
                  <Variance f={f} currency={currency} threshold={onPlanThreshold} reduce={reduce} />
                  <ChevronDown className={styles.chevron} size={16} strokeWidth={1.75} aria-hidden="true" />
                </button>
              </h3>
              <AnimatePresence initial={false}>
                {isOpen && <motion.div key="lines" id={panelId} role="region" aria-label={`${department.name} budget lines`} className={styles.panel}
                  initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1, transition: panelTransition }} exit={{ height: 0, opacity: 0, transition: exitTransition }}>
                  <ul className={styles.lines}>
                    {lines.map(({ item, f: lf }) => <li key={item.id} className={styles.lineItem}>
                      <div className={`${styles.grid} ${styles.line}`} aria-hidden="true">
                      <span className={styles.name}>
                        <span className={styles.nameText}>
                          <span className={styles.primary}>{item.name}</span>
                          <span className={styles.secondary} data-show="narrow"><Count value={lf.actual} format={v => money(v, currency)} reduce={reduce} /> of <Count value={lf.budget} format={v => money(v, currency)} reduce={reduce} /></span>
                        </span>
                      </span>
                      <span className={styles.chart}><Bullet ratio={lf.ratio} scaleMax={scaleMax} ranges={ranges} reduce={reduce} size="line" /></span>
                      <Count value={lf.actual} format={v => money(v, currency)} reduce={reduce} className={styles.num} />
                      <Count value={lf.budget} format={v => money(v, currency)} reduce={reduce} className={`${styles.num} ${styles.muted}`} />
                      <Variance f={lf} currency={currency} threshold={onPlanThreshold} reduce={reduce} />
                      <span className={styles.spacer} />
                      </div>
                      <span className={styles.srOnly}>{sentence(item.name, lf, currency, phrase)}</span>
                    </li>)}
                  </ul>
                </motion.div>}
              </AnimatePresence>
            </li>;
          })}
        </ul>

        <div className={styles.legend} aria-hidden="true">
          <span className={styles.legendItem}><i className={styles.keyBar} />Actual</span>
          <span className={styles.legendItem}><i className={styles.keyTick} />Budget</span>
          <span className={styles.legendItem}><i className={styles.keyOver} />Over budget</span>
          <span className={styles.legendItem}><i className={styles.keyBand} />{Math.round(ranges[0] * 100)} to {Math.round(ranges[1] * 100)}% of budget</span>
        </div>
      </div>}

      <p className={styles.srOnly} role="status" aria-live="polite">{announcement}</p>
    </div>
  </section>;
}

export default BudgetVariance;
