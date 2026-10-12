"use client";

import { useId, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowRight, CircleCheck } from "lucide-react";
import { Avatar } from "../../avatar/avatar";
import { Button } from "../../button/button";
import { Checkbox } from "../../checkbox/checkbox";
import { Switch } from "../../switch/switch";
import { person } from "../../lib/media";
import { motionTokens } from "../../lib/motion-tokens";
import styles from "./release-readiness.module.css";

const initialChecks = { brief: true, qa: false, changelog: false, owner: false };
type CheckId = keyof typeof initialChecks;
const tasks: { id: CheckId; label: string; detail: string }[] = [
  { id: "brief", label: "Product brief approved", detail: "Scope and acceptance criteria are final" },
  { id: "qa", label: "Quality checks passed", detail: "Build 2.4.0-rc.3 reviewed on staging" },
  { id: "changelog", label: "Changelog is ready", detail: "Release notes drafted for customers" },
  { id: "owner", label: "Release owner on call", detail: "Someone is available for the handoff" },
];
const owners = [person("emma-collins"), person("marcus-johnson")];

export interface ReleaseReadinessProps { onRelease?: () => void | Promise<void> }

export function ReleaseReadiness({ onRelease }: ReleaseReadinessProps) {
  const id = useId();
  const reduce = !!useReducedMotion();
  const [checks, setChecks] = useState(initialChecks);
  const [notify, setNotify] = useState(true);
  const [shipping, setShipping] = useState(false);
  const [released, setReleased] = useState(false);
  const [error, setError] = useState("");
  const ready = Object.values(checks).filter(Boolean).length;
  const remaining = tasks.length - ready;

  async function release() {
    setShipping(true);
    setError("");
    try { await onRelease?.(); setReleased(true); }
    catch { setError("The release could not be started. Try again."); }
    finally { setShipping(false); }
  }
  function reset() { setChecks(initialChecks); setReleased(false); setError(""); }

  return (
    <section className={styles.release} aria-labelledby={`${id}-title`}>
      <header className={styles.header}>
        <div className={styles.titleBlock}>
          <h2 id={`${id}-title`}>Release 2.4</h2>
          <p>Atlas workspace · ships Thursday</p>
        </div>
        <div className={styles.owners} aria-label={`Release owners: ${owners.map(owner => owner.name).join(" and ")}`}>
          {owners.map(owner => <Avatar key={owner.id} name={owner.name} src={owner.src} size="sm" aria-hidden="true" />)}
        </div>
      </header>

      <div className={styles.progress}>
        <div className={styles.progressMeta}>
          <span aria-live="polite">{released ? "Release in progress" : remaining ? `${remaining} ${remaining === 1 ? "check" : "checks"} left` : "Ready to ship"}</span>
          <span className={styles.count}>{ready} of {tasks.length}</span>
        </div>
        <div className={styles.track} role="progressbar" aria-label="Readiness" aria-valuemin={0} aria-valuemax={tasks.length} aria-valuenow={ready}>
          <span className={styles.fill} data-complete={ready === tasks.length || undefined} style={{ transform: `translateX(${(ready / tasks.length - 1) * 100}%)` }} />
        </div>
      </div>

      <ul className={styles.tasks} aria-label="Before you ship">
        {tasks.map(task => {
          const done = checks[task.id];
          return (
            <li key={task.id} className={styles.task} data-done={done || undefined}>
              <Checkbox id={`${id}-${task.id}`} checked={done} disabled={released} onCheckedChange={value => setChecks(current => ({ ...current, [task.id]: value === true }))} aria-label={task.label} aria-describedby={`${id}-${task.id}-detail`} />
              <label htmlFor={`${id}-${task.id}`} className={styles.taskCopy}>
                <span className={styles.taskLabel}>{task.label}</span>
                <span id={`${id}-${task.id}-detail`} className={styles.taskDetail}>{task.detail}</span>
              </label>
            </li>
          );
        })}
      </ul>

      <footer className={styles.footer}>
        <Switch checked={notify} onCheckedChange={setNotify} label="Notify #releases" disabled={released} />
        <div className={styles.footerActions}>
          {released && <Button variant="ghost" size="sm" onClick={reset}>Reset</Button>}
          <Button size="sm" disabled={ready < tasks.length || released} loading={shipping} onClick={() => void release()}>
            {released ? <><CircleCheck size={16} aria-hidden="true" />Started</> : <>Start release<ArrowRight size={16} aria-hidden="true" /></>}
          </Button>
        </div>
      </footer>

      {/* The message opens its own row: the card grows on a spring instead of snapping taller, and closes the same way on reset. */}
      <AnimatePresence initial={false}>
        {(error || released) && (
          <motion.div
            key="message"
            className={styles.message}
            initial={reduce ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { height: 0, opacity: 0 }}
            transition={reduce ? { duration: 0 } : { height: motionTokens.spring.smooth, opacity: { duration: motionTokens.duration.fast, ease: [...motionTokens.ease.standard] } }}
          >
            <p className={error ? styles.error : styles.success} role={error ? "alert" : "status"}>
              {error || `Release 2.4 is rolling out.${notify ? " #releases was notified." : ""}`}
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

export default ReleaseReadiness;
