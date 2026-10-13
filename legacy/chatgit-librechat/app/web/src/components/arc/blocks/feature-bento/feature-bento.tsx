"use client";

import { forwardRef, useId, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties, ReactNode } from "react";
import { motion, useInView, useReducedMotion } from "motion/react";
import { Building2, Check, CornerDownLeft, FileText, Hash, Inbox, LineChart, Plug, Receipt, Search, UserPlus, Zap } from "lucide-react";
import { motionTokens } from "../../lib/motion-tokens";
import { avatar, person } from "../../lib/media";
import { bentoFeatures, bentoSamples, type BentoFeature, type BentoVisual } from "./feature-bento-data";
import styles from "./feature-bento.module.css";

export type { BentoFeature, BentoSize, BentoVisual } from "./feature-bento-data";

export interface FeatureBentoProps {
  title?: string;
  description?: string;
  /** Six cells read best. Sizes decide the rhythm; the grid fills gaps densely. */
  features?: BentoFeature[];
  /** Replace a built-in illustration by feature id, for example `{ sync: <MyVisual /> }`. */
  visuals?: Partial<Record<string, ReactNode>>;
  className?: string;
}

type Bezier = [number, number, number, number];
const enter = [...motionTokens.ease.enter] as Bezier;
const ICON = { size: 14, strokeWidth: 1.75, "aria-hidden": true } as const;

const fineQuery = "(hover: hover) and (pointer: fine)";
function subscribeFine(callback: () => void) {
  const query = window.matchMedia(fineQuery);
  query.addEventListener("change", callback);
  return () => query.removeEventListener("change", callback);
}
/** Fine pointers act a cell out on hover; touch screens act it out once, when it scrolls into view. */
const useFinePointer = () => useSyncExternalStore(subscribeFine, () => window.matchMedia(fineQuery).matches, () => true);

const cssVars = (vars: Record<string, string | number>) => vars as CSSProperties;

function SyncVisual() {
  const { doc } = bentoSamples;
  const emma = person("emma-collins"), marcus = person("marcus-johnson");
  return <div className={styles.doc}>
    <div className={styles.docHead}>
      <FileText {...ICON} />
      <span className={styles.docTitle}>{doc.title}</span>
      <span className={styles.faces}>
        {(["emma-collins", "marcus-johnson", "sofia-ramirez"] as const).map(id => (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={id} src={avatar(id)} alt="" width={20} height={20} />
        ))}
      </span>
    </div>
    <p className={styles.line}>
      {doc.lines[0]}{" "}
      <span className={styles.selection}>
        <span className={styles.selectionFill} />
        <span className={styles.selectionText}>{doc.selected}</span>
        <span className={styles.cursorTrack}>
          <span className={styles.cursor} style={cssVars({ "--who": "var(--series-1)" })}>
            <svg viewBox="0 0 12 14" aria-hidden="true"><path d="M1 1l10 5.2-4.4 1.3L4.4 12z" /></svg>
            <span className={styles.tag}>{emma.name.split(" ")[0]}</span>
          </span>
        </span>
      </span>
    </p>
    <p className={styles.line}>{doc.lines[1]}</p>
    <p className={styles.line}>
      {doc.lines[2]}
      <span className={styles.typed} style={cssVars({ "--chars": doc.typed.length })}>{doc.typed}</span>
      <span className={styles.caret} style={cssVars({ "--who": "var(--series-3)" })}>
        <span className={styles.tag}>{marcus.name.split(" ")[0]}</span>
      </span>
    </p>
  </div>;
}

const commandIcons = [UserPlus, Receipt, Plug, LineChart, Inbox];
function CommandVisual() {
  return <div className={styles.palette}>
    <div className={styles.paletteSearch}>
      <Search {...ICON} />
      <span className={styles.query}>in<span className={styles.queryTyped}>t</span></span>
      <span className={styles.paletteCaret} />
    </div>
    <ul className={styles.commands}>
      <li className={styles.commandHighlight} aria-hidden="true" />
      {bentoSamples.commands.map((label, index) => {
        const Icon = commandIcons[index % commandIcons.length];
        return <li key={label} className={styles.command} data-target={index === 2 ? "" : undefined} data-first={index === 0 ? "" : undefined}><Icon {...ICON} />{label}</li>;
      })}
    </ul>
    <div className={styles.paletteFoot}>
      <span><kbd>↑</kbd><kbd>↓</kbd> Move</span>
      <span><kbd className={styles.enterKey}><CornerDownLeft size={11} strokeWidth={2} aria-hidden="true" /></kbd> Open</span>
    </div>
  </div>;
}

function ChartVisual() {
  const { chart } = bentoSamples;
  const last = chart.bars.length - 1;
  return <div className={styles.chart}>
    <div className={styles.chartHead}>
      <span>{chart.label}</span>
      <strong>{chart.value}</strong>
    </div>
    <div className={styles.bars}>
      {chart.bars.map((height, index) => <span key={index} className={styles.bar} data-last={index === last ? "" : undefined} style={cssVars({ "--h": `${height}%`, "--i": index })} />)}
      <span className={styles.barTip} style={cssVars({ "--h": `${chart.bars[last]}%` })}>{chart.delta}</span>
    </div>
  </div>;
}

const flowIcons = [Zap, Building2, Hash];
function FlowVisual() {
  return <ol className={styles.flow}>
    <li className={styles.flowLine} aria-hidden="true"><span className={styles.flowFill} /></li>
    {bentoSamples.flow.map((label, index) => {
      const Icon = flowIcons[index % flowIcons.length];
      return <li key={label} className={styles.flowStep} style={cssVars({ "--i": index })}>
        <span className={styles.flowIcon}><Icon {...ICON} /></span>
        <span className={styles.flowLabel}>{label}</span>
        <span className={styles.flowCheck}><Check size={12} strokeWidth={2.5} aria-hidden="true" /></span>
      </li>;
    })}
  </ol>;
}

function PermissionsVisual() {
  return <div className={styles.rolesWrap}>
    <div className={styles.roles}>
      {bentoSamples.roles.map(role => <div key={role.name} className={styles.role} data-flips={role.on ? undefined : ""}>
        <span className={styles.roleText}><span>{role.name}</span><span>{role.access}</span></span>
        <span className={styles.switch} data-on={role.on ? "" : undefined}><span className={styles.thumb} /></span>
      </div>)}
    </div>
    <span className={styles.saved}><Check size={12} strokeWidth={2.5} aria-hidden="true" />Saved</span>
  </div>;
}

function HistoryVisual() {
  const { history } = bentoSamples;
  return <div className={styles.history}>
    <div className={styles.historyHead}>
      <span className={styles.swap}><span data-now="">Current version</span><span data-past="">{history.viewing}</span></span>
    </div>
    <p className={styles.historyText}>
      <span className={styles.swap}><span data-now="">{history.current}</span><span data-past="">{history.past}</span></span>
    </p>
    <div className={styles.track}>
      {[0, 1, 2, 3, 4, 5].map(tick => <span key={tick} className={styles.tick} style={cssVars({ "--x": `${tick * 20}%` })} />)}
      <span className={styles.trackFill} />
      <span className={styles.thumbTrack}><span className={styles.scrub} /></span>
    </div>
    <div className={styles.times}><span>{history.times[0]}</span><span>{history.times[1]}</span></div>
  </div>;
}

const builtIn: Record<BentoVisual, () => ReactNode> = {
  sync: SyncVisual,
  command: CommandVisual,
  chart: ChartVisual,
  flow: FlowVisual,
  permissions: PermissionsVisual,
  history: HistoryVisual,
};

function Cell({ feature, index, custom, fine, reduced }: { feature: BentoFeature; index: number; custom?: ReactNode; fine: boolean; reduced: boolean }) {
  const ref = useRef<HTMLLIElement>(null);
  const seen = useInView(ref, { once: true, amount: .4 });
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const on = hovered || focused || (!fine && seen);
  const Visual = builtIn[feature.visual];
  return <motion.li
    ref={ref}
    className={styles.cell}
    data-size={feature.size ?? "regular"}
    data-visual={feature.visual}
    data-seen={seen ? "" : undefined}
    data-on={on ? "" : undefined}
    onPointerEnter={event => { if (event.pointerType === "mouse") setHovered(true); }}
    onPointerLeave={() => setHovered(false)}
    onFocus={() => setFocused(true)}
    onBlur={() => setFocused(false)}
    initial={reduced ? false : { opacity: 0, y: 14 }}
    animate={seen || reduced ? { opacity: 1, y: 0 } : undefined}
    transition={{ duration: motionTokens.duration.considered, ease: enter, delay: (index % 3) * motionTokens.stagger.line }}
  >
    <div className={styles.visual} aria-hidden="true">{custom ?? (Visual ? <Visual /> : null)}</div>
    <div className={styles.copy}>
      <h3 className={styles.cellTitle}>{feature.href ? <a href={feature.href} className={styles.cellLink}>{feature.title}</a> : feature.title}</h3>
      <p className={styles.cellText}>{feature.description}</p>
    </div>
  </motion.li>;
}

/**
 * A six cell feature bento. Each cell pairs one sentence with a small piece of real product UI that acts the feature
 * out: on hover with a mouse, or once as it scrolls into view on touch screens.
 */
export const FeatureBento = forwardRef<HTMLElement, FeatureBentoProps>(function FeatureBento({
  title = "Built for the way teams actually work",
  description = "Fast, shared, and quietly automatic. Everything your team needs to plan, ship, and look back.",
  features = bentoFeatures,
  visuals,
  className,
}, ref) {
  const id = useId();
  const reduced = !!useReducedMotion();
  const fine = useFinePointer();
  return <section ref={ref} className={[styles.bento, className].filter(Boolean).join(" ")} aria-labelledby={`${id}-title`}>
    <div className={styles.inner}>
      <header className={styles.header}>
        <h2 id={`${id}-title`} className={styles.title}>{title}</h2>
        {description && <p className={styles.description}>{description}</p>}
      </header>
      <ul className={styles.grid}>
        {features.map((feature, index) => <Cell key={feature.id} feature={feature} index={index} custom={visuals?.[feature.id]} fine={fine} reduced={reduced} />)}
      </ul>
    </div>
  </section>;
});

FeatureBento.displayName = "FeatureBento";

/** Preview: the bento with its sample features. Hover a cell to see it work. */
export function FeatureBentoBlock() {
  return <div className={styles.frame}><FeatureBento /></div>;
}

export default FeatureBentoBlock;
