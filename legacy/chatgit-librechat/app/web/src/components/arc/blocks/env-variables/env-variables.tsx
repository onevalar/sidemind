"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ClipboardEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import { AnimatePresence, animate, motion, useReducedMotion } from "motion/react";
import type { AnimationPlaybackControlsWithThen, Transition } from "motion/react";
import { ArrowLeftRight, Check, CircleAlert, Eye, EyeOff, FileUp, Info, Lock, Pencil, Plus, RefreshCw, TriangleAlert } from "lucide-react";
import { Button } from "../../button/button";
import { Checkbox } from "../../checkbox/checkbox";
import { CopyButton } from "../../copy-button/copy-button";
import { Input } from "../../input/input";
import { SearchField } from "../../search-field/search-field";
import SegmentedControl from "../../segmented-control/segmented-control";
import { Select } from "../../select/select";
import { Switch } from "../../switch/switch";
import { Textarea } from "../../textarea/textarea";
import { motionTokens } from "../../lib/motion-tokens";
import { ENVIRONMENTS, PROJECT, SAMPLE_DOTENV, VARIABLES } from "./env-variables-data";
import type { EnvName, EnvVariable } from "./env-variables-data";
import styles from "./env-variables.module.css";

export type { EnvName, EnvVariable } from "./env-variables-data";

/**
 * Environment variables and secrets. Every row is one value and the environments it applies to, drawn as a matrix of toggles, so a key can hold a
 * different value per environment. Values stay masked (the real value is not in the DOM) until someone reveals a row; sensitive values are write-only.
 * Add one variable or paste a whole .env file that parses into rows with duplicate and invalid key warnings. Compare two environments to find keys
 * that are missing or differ, shown by fingerprint rather than value. Every change queues a redeploy banner. Everything is simulated locally.
 */

export interface EnvVariablesProps {
  /** Rows in any order; the block sorts them by key. */
  variables?: EnvVariable[];
  /** Project name shown under the heading. */
  project?: string;
  /** Text the paste area starts with when Import .env opens. */
  sampleDotenv?: string;
  title?: string;
  /** Called with every row after each change. */
  onChange?: (variables: EnvVariable[]) => void;
  /** Called when Redeploy is pressed with the environments that changed. Return a promise to keep the banner pending until it settles. */
  onRedeploy?: (environments: EnvName[]) => void | Promise<void>;
  className?: string;
}

type View = "list" | "compare";
type AddMode = "single" | "paste";
type DeployState = "idle" | "running" | "done" | "failed";
type ParsedStatus = "new" | "replace" | "duplicate" | "invalid";
type ParsedLine = { line: number; key: string; value: string; status: ParsedStatus; detail: string };
type DiffStatus = "missing-base" | "missing-target" | "different" | "same";
type DiffRow = { key: string; base?: EnvVariable; target?: EnvVariable; status: DiffStatus };

const MASK = "••••••••••••••••";
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_ORDER: EnvName[] = ENVIRONMENTS.map(env => env.id);
const envLabel = (env: EnvName) => ENVIRONMENTS.find(item => item.id === env)?.label ?? env;
const easeExit = [...motionTokens.ease.exit] as [number, number, number, number];
const easeStandard = [...motionTokens.ease.standard] as [number, number, number, number];
const instant: Transition = { duration: 0 };

/**
 * Lets a box follow its content's height on the smooth spring for a moment after `arm()`, then hands control back to auto height.
 * Used where whole content swaps (the list and compare views, the banner states), so the shell never snaps to a new size in one frame.
 * Outside that window the box stays auto, so rows that animate their own height are never chased twice.
 */
function useFollowHeight(reduce: boolean) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const armedUntil = useRef(0);
  useEffect(() => {
    const box = outer.current, content = inner.current;
    if (!box || !content || typeof ResizeObserver === "undefined") return;
    let last = content.offsetHeight;
    let control: AnimationPlaybackControlsWithThen | null = null;
    const release = () => { control = null; box.style.height = ""; box.style.overflow = ""; };
    const observer = new ResizeObserver(() => {
      const next = content.offsetHeight;
      if (next === last) return;
      const from = control ? box.getBoundingClientRect().height : last;
      last = next;
      if (reduce || (!control && performance.now() > armedUntil.current)) { if (control) { control.stop(); release(); } return; }
      control?.stop();
      box.style.overflow = "hidden";
      box.style.height = `${from}px`;
      const current = animate(box, { height: [from, next] }, motionTokens.spring.smooth);
      control = current;
      current.then(() => { if (control === current) release(); });
    });
    observer.observe(content);
    return () => { observer.disconnect(); control?.stop(); };
  }, [reduce]);
  const arm = useCallback(() => { armedUntil.current = performance.now() + 900; }, []);
  return { outer, inner, arm };
}

function joinEnvs(envs: EnvName[]) {
  const labels = ENV_ORDER.filter(env => envs.includes(env)).map(envLabel);
  if (labels.length < 2) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/** Plain code point order, so the server and every browser sort the same way. */
const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function sortVariables(rows: EnvVariable[]) {
  const first = (row: EnvVariable) => Math.min(...row.environments.map(env => ENV_ORDER.indexOf(env)));
  return [...rows].sort((a, b) => byKey(a.key, b.key) || first(a) - first(b));
}

/** A short, stable fingerprint: two values can be compared without showing either one. */
function fingerprint(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 0x01000193); }
  return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 6);
}

function keyError(key: string) {
  if (!key) return "";
  if (/^[0-9]/.test(key)) return "Keys can't start with a number";
  if (!KEY_PATTERN.test(key)) return "Use letters, numbers and underscores only";
  return "";
}

function unquote(raw: string) {
  const value = raw.trim();
  const quote = value[0];
  if ((quote === "\"" || quote === "'") && value.length > 1 && value.endsWith(quote)) {
    const inner = value.slice(1, -1);
    return quote === "\"" ? inner.replace(/\\n/g, "\n").replace(/\\"/g, "\"") : inner;
  }
  const comment = value.search(/\s#/);
  return (comment >= 0 ? value.slice(0, comment) : value).trim();
}

/** Parses .env text into rows, marking later duplicates, invalid keys, and values that replace an existing one in the chosen environments. */
function parseDotenv(text: string, rows: EnvVariable[], targets: EnvName[]): ParsedLine[] {
  const lines: ParsedLine[] = [];
  text.split(/\r?\n/).forEach((source, index) => {
    const trimmed = source.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const body = trimmed.replace(/^export\s+/, "");
    const equals = body.indexOf("=");
    if (equals < 0) { lines.push({ line: index + 1, key: body.slice(0, 40), value: "", status: "invalid", detail: "Missing an equals sign, skipped" }); return; }
    const key = body.slice(0, equals).trim();
    const value = unquote(body.slice(equals + 1));
    const error = key ? keyError(key) : "Missing a key";
    lines.push(error ? { line: index + 1, key: key || "(empty)", value, status: "invalid", detail: `${error}, skipped` } : { line: index + 1, key, value, status: "new", detail: "New" });
  });
  return lines.map((entry, index) => {
    if (entry.status === "invalid") return entry;
    const later = lines.slice(index + 1).find(other => other.status !== "invalid" && other.key === entry.key);
    if (later) return { ...entry, status: "duplicate", detail: `Line ${later.line} sets it again, skipped` };
    const replaced = targets.filter(env => rows.some(row => row.key === entry.key && row.environments.includes(env)));
    return replaced.length ? { ...entry, status: "replace", detail: `Replaces the ${joinEnvs(replaced)} value` } : entry;
  });
}

/** Puts `value` on `key` in `targets`, taking those environments off any row that already covered them. */
function upsert(rows: EnvVariable[], entry: EnvVariable) {
  const cleared = rows
    .map(row => row.key === entry.key ? { ...row, environments: row.environments.filter(env => !entry.environments.includes(env)) } : row)
    .filter(row => row.environments.length > 0);
  return sortVariables([...cleared, entry]);
}

function diffRows(rows: EnvVariable[], base: EnvName, target: EnvName): DiffRow[] {
  const keys = [...new Set(rows.map(row => row.key))].sort(byKey);
  return keys.flatMap(key => {
    const a = rows.find(row => row.key === key && row.environments.includes(base));
    const b = rows.find(row => row.key === key && row.environments.includes(target));
    if (!a && !b) return [];
    const status: DiffStatus = !b ? "missing-target" : !a ? "missing-base" : a.value === b.value ? "same" : "different";
    return [{ key, base: a, target: b, status }];
  });
}

export function EnvVariables({
  variables = VARIABLES,
  project = PROJECT.name,
  sampleDotenv = SAMPLE_DOTENV,
  title = "Environment variables",
  onChange,
  onRedeploy,
  className,
}: EnvVariablesProps) {
  const reduce = !!useReducedMotion();
  const rootRef = useRef<HTMLElement>(null);
  const idCounter = useRef(0);
  const headingId = useId();
  const [rows, setRows] = useState(() => sortVariables(variables));
  const [view, setView] = useState<View>("list");
  const [query, setQuery] = useState("");
  const [revealed, setRevealed] = useState<Set<string>>(() => new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [addMode, setAddMode] = useState<AddMode | null>(null);
  const [changed, setChanged] = useState<Set<string>>(() => new Set());
  const [pending, setPending] = useState<{ count: number; envs: EnvName[] }>({ count: 0, envs: [] });
  const [deploy, setDeploy] = useState<{ state: DeployState; envs: EnvName[] }>({ state: "idle", envs: [] });
  const [note, setNote] = useState<{ id: string; text: string } | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
  const [announcement, setAnnouncement] = useState("");
  const [base, setBase] = useState<EnvName>("preview");
  const [target, setTarget] = useState<EnvName>("production");
  const [showMatching, setShowMatching] = useState(false);

  const smooth: Transition = reduce ? instant : motionTokens.spring.smooth;
  const { outer: viewOuterRef, inner: viewInnerRef, arm: armView } = useFollowHeight(reduce);

  useEffect(() => { if (!note) return; const timer = window.setTimeout(() => setNote(null), 3800); return () => window.clearTimeout(timer); }, [note]);
  useEffect(() => { if (!fresh.size) return; const timer = window.setTimeout(() => setFresh(new Set()), 1800); return () => window.clearTimeout(timer); }, [fresh]);
  useEffect(() => {
    if (deploy.state !== "done") return;
    const timer = window.setTimeout(() => setDeploy({ state: "idle", envs: [] }), 2600);
    return () => window.clearTimeout(timer);
  }, [deploy.state]);

  const nextId = (prefix: string) => `${prefix}-${++idCounter.current}`;

  function commit(next: EnvVariable[], touched: string[], envs: EnvName[], message: string) {
    setRows(next);
    onChange?.(next);
    setChanged(current => new Set([...current, ...touched]));
    setPending(current => ({ count: current.count + 1, envs: ENV_ORDER.filter(env => current.envs.includes(env) || envs.includes(env)) }));
    if (deploy.state === "done" || deploy.state === "failed") setDeploy({ state: "idle", envs: [] });
    setAnnouncement(message);
  }

  function focusLater(selector: string) {
    window.requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>(selector)?.focus());
  }

  function toggleEnv(id: string, env: EnvName) {
    const row = rows.find(item => item.id === id);
    if (!row) return;
    const on = row.environments.includes(env);
    if (on && row.environments.length === 1) { setNote({ id, text: "A value needs at least one environment. Remove it instead." }); return; }
    if (!on) {
      const other = rows.find(item => item.id !== id && item.key === row.key && item.environments.includes(env));
      if (other) { setNote({ id, text: `${row.key} already has a ${envLabel(env)} value. Turn it off on that row first.` }); return; }
    }
    const environments = on ? row.environments.filter(item => item !== env) : ENV_ORDER.filter(item => item === env || row.environments.includes(item));
    setNote(current => current?.id === id ? null : current);
    commit(sortVariables(rows.map(item => item.id === id ? { ...item, environments, updated: "Just now", updatedBy: "You" } : item)), [id], [env], `${envLabel(env)} turned ${on ? "off" : "on"} for ${row.key}`);
  }

  function toggleReveal(id: string) {
    setRevealed(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }

  function openEditor(id: string) {
    setEditing(current => current === id ? null : id);
    setRevealed(current => { if (!current.has(id)) return current; const next = new Set(current); next.delete(id); return next; });
  }

  function closeEditor(id: string) {
    setEditing(null);
    focusLater(`[data-edit="${id}"]`);
  }

  function saveEdit(id: string, value: string, sensitive: boolean) {
    const row = rows.find(item => item.id === id);
    if (!row) return;
    const next = rows.map(item => item.id === id ? { ...item, value: value || item.value, sensitive, updated: "Just now", updatedBy: "You" } : item);
    commit(next, [id], row.environments, `${row.key} saved`);
    setFresh(new Set([id]));
    closeEditor(id);
  }

  function removeRow(id: string) {
    const row = rows.find(item => item.id === id);
    if (!row) return;
    setEditing(null);
    commit(rows.filter(item => item.id !== id), [], row.environments, `${row.key} removed from ${joinEnvs(row.environments)}`);
    focusLater("[data-add-trigger='single']");
  }

  function addEntries(entries: { key: string; value: string; sensitive: boolean }[], environments: EnvName[]) {
    let next = rows;
    const ids: string[] = [];
    for (const entry of entries) {
      const id = nextId("added");
      ids.push(id);
      next = upsert(next, { id, key: entry.key, value: entry.value, environments, sensitive: entry.sensitive, updated: "Just now", updatedBy: "You" });
    }
    commit(next, ids, environments, entries.length === 1 ? `${entries[0].key} added to ${joinEnvs(environments)}` : `${entries.length} variables imported into ${joinEnvs(environments)}`);
    setFresh(new Set(ids));
    setQuery("");
    setView("list");
    setAddMode(null);
  }

  function copyToEnv(row: EnvVariable, env: EnvName) {
    commit(sortVariables(rows.map(item => item.id === row.id ? { ...item, environments: ENV_ORDER.filter(e => e === env || item.environments.includes(e)), updated: "Just now", updatedBy: "You" } : item)), [row.id], [env], `${row.key} copied to ${envLabel(env)}`);
  }

  async function redeploy() {
    const envs = pending.envs;
    setDeploy({ state: "running", envs });
    try {
      if (onRedeploy) await onRedeploy(envs);
      else await new Promise(resolve => window.setTimeout(resolve, 1700));
      setDeploy({ state: "done", envs });
      setPending({ count: 0, envs: [] });
      setChanged(new Set());
      setAnnouncement(`Redeployed ${joinEnvs(envs)}`);
    } catch {
      setDeploy({ state: "failed", envs });
      setAnnouncement("Redeploy failed. Your changes are still queued.");
    }
  }

  function openAdd(mode: AddMode) {
    setAddMode(current => current === mode ? null : mode);
    setEditing(null);
  }

  const needle = query.trim().toLowerCase();
  const visible = needle ? rows.filter(row => row.key.toLowerCase().includes(needle)) : rows;
  const keyCount = new Set(rows.map(row => row.key)).size;
  const envCounts = ENV_ORDER.map(env => rows.filter(row => row.environments.includes(env)).length);
  const bannerOpen = pending.count > 0 || deploy.state !== "idle";
  // Switching views, or a search swapping the table for its empty state, replaces the whole pane: let the shell spring to the new height.
  const paneKey = `${view}|${view === "list" && !visible.length}`;
  const paneSeen = useRef(paneKey);
  useLayoutEffect(() => { if (paneSeen.current !== paneKey) { paneSeen.current = paneKey; armView(); } }, [paneKey, armView]);

  return (
    <section ref={rootRef} className={[styles.root, className].filter(Boolean).join(" ")} aria-labelledby={headingId}>
      <div className={styles.shell}>
        <header className={styles.header}>
          <div className={styles.headText}>
            <h2 id={headingId} className={styles.title}>{title}</h2>
            <p className={styles.meta}><span className={styles.mono}>{project}</span><span className={styles.sep} aria-hidden="true" /><span><span className={styles.num}>{keyCount}</span> {keyCount === 1 ? "key" : "keys"} across {ENVIRONMENTS.length} environments</span></p>
          </div>
          <div className={styles.headActions}>
            <Button variant="secondary" data-add-trigger="paste" aria-expanded={addMode === "paste"} onClick={() => openAdd("paste")}><FileUp size={16} strokeWidth={1.75} aria-hidden="true" />Import .env</Button>
            <Button variant="primary" data-add-trigger="single" aria-expanded={addMode === "single"} onClick={() => openAdd("single")}><Plus size={16} strokeWidth={1.75} aria-hidden="true" />Add variable</Button>
          </div>
        </header>

        <AnimatePresence initial={false}>
          {bannerOpen ? (
            <motion.div key="banner" className={styles.bannerClip} initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1, transition: smooth }} exit={{ height: 0, opacity: 0, transition: reduce ? instant : { duration: motionTokens.duration.exit, ease: easeExit } }}>
              <RedeployBanner pending={pending} deploy={deploy} onRedeploy={redeploy} reduce={reduce} />
            </motion.div>
          ) : null}
        </AnimatePresence>

        <AnimatePresence initial={false}>
          {addMode ? (
            <motion.div key="add" className={styles.addClip} initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1, transition: smooth }} exit={{ height: 0, opacity: 0, transition: reduce ? instant : { duration: motionTokens.duration.exit, ease: easeExit } }}>
              <AddPanel
                mode={addMode}
                rows={rows}
                sampleDotenv={sampleDotenv}
                reduce={reduce}
                onModeChange={setAddMode}
                onCancel={() => { const mode = addMode; setAddMode(null); focusLater(`[data-add-trigger='${mode}']`); }}
                onAdd={addEntries}
              />
            </motion.div>
          ) : null}
        </AnimatePresence>

        <div className={styles.toolbar}>
          <div className={styles.search}><SearchField label="Search variables" placeholder="Search keys" value={query} onValueChange={setQuery} /></div>
          <SegmentedControl label="View" value={view} onValueChange={value => { setView(value as View); setEditing(null); }} options={[{ value: "list", label: "Variables" }, { value: "compare", label: "Compare" }]} />
        </div>

        <div ref={viewOuterRef} className={styles.viewFrame}>
          <div ref={viewInnerRef} className={styles.followInner}>
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={view}
                className={styles.viewPane}
                initial={reduce ? { opacity: 0 } : { opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0, transition: reduce ? instant : { duration: motionTokens.duration.standard, ease: easeStandard } }}
                exit={{ opacity: 0, transition: reduce ? instant : { duration: motionTokens.duration.instant, ease: easeExit } }}
              >
                {view === "list" ? (
                  <VariableList
                    rows={visible}
                    total={rows.length}
                    query={query}
                    envCounts={envCounts}
                    revealed={revealed}
                    editing={editing}
                    changed={changed}
                    fresh={fresh}
                    note={note}
                    reduce={reduce}
                    onToggleEnv={toggleEnv}
                    onToggleReveal={toggleReveal}
                    onEdit={openEditor}
                    onCloseEditor={closeEditor}
                    onSave={saveEdit}
                    onRemove={removeRow}
                    onClearSearch={() => setQuery("")}
                    onAdd={() => openAdd("single")}
                  />
                ) : (
                  <CompareView
                    rows={rows}
                    needle={needle}
                    base={base}
                    target={target}
                    showMatching={showMatching}
                    reduce={reduce}
                    onBase={setBase}
                    onTarget={setTarget}
                    onSwap={() => { setBase(target); setTarget(base); }}
                    onShowMatching={setShowMatching}
                    onCopy={copyToEnv}
                    onClearSearch={() => setQuery("")}
                  />
                )}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </div>
      <p className={styles.srOnly} role="status" aria-live="polite">{announcement}</p>
    </section>
  );
}

/* ---------- Redeploy banner ---------- */

function RedeployBanner({ pending, deploy, onRedeploy, reduce }: { pending: { count: number; envs: EnvName[] }; deploy: { state: DeployState; envs: EnvName[] }; onRedeploy: () => void; reduce: boolean }) {
  const done = deploy.state === "done";
  const failed = deploy.state === "failed";
  const heading = done ? `Redeployed ${joinEnvs(deploy.envs)}` : failed ? "Redeploy failed" : `Redeploy to apply ${pending.count} ${pending.count === 1 ? "change" : "changes"}`;
  const detail = done
    ? "New deployments picked up the changes. This demo only simulates the deploy."
    : failed
      ? "Nothing was deployed and your changes are still queued. Try again."
      : `${joinEnvs(pending.envs)} ${pending.envs.length === 1 ? "keeps" : "keep"} the old values until the next deployment.`;
  // Each state swaps the copy in place: the box springs to the new height, the icon and text crossfade, and the button fades out once done.
  const { outer: outerRef, inner: innerRef, arm } = useFollowHeight(reduce);
  const seen = useRef(deploy.state);
  useLayoutEffect(() => { if (seen.current !== deploy.state) { seen.current = deploy.state; arm(); } }, [deploy.state, arm]);
  const swapIn = reduce ? { opacity: 0 } : { opacity: 0, y: 4 };
  const swapOut = { opacity: 0, y: reduce ? 0 : -4, transition: reduce ? instant : { duration: motionTokens.duration.instant, ease: easeExit } };
  const swapTransition: Transition = reduce ? instant : { duration: motionTokens.duration.standard, ease: easeStandard };
  const iconKey = done ? "done" : failed ? "failed" : "info";
  return (
    <div ref={outerRef}>
      <div ref={innerRef} className={styles.followInner}>
        <div className={styles.banner} data-state={deploy.state}>
          <span className={styles.bannerIcon} aria-hidden="true">
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span key={iconKey} className={styles.bannerGlyph} initial={reduce ? { opacity: 0 } : { opacity: 0, scale: .6 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: reduce ? 1 : .6, transition: reduce ? instant : { duration: motionTokens.duration.instant } }} transition={reduce ? instant : motionTokens.spring.snappy}>
                {done ? <Check size={16} strokeWidth={1.75} /> : failed ? <CircleAlert size={16} strokeWidth={1.75} /> : <Info size={16} strokeWidth={1.75} />}
              </motion.span>
            </AnimatePresence>
          </span>
          <div className={styles.bannerText}>
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.p key={heading} className={styles.bannerTitle} initial={swapIn} animate={{ opacity: 1, y: 0 }} exit={swapOut} transition={swapTransition}>
                <span className={styles.num}>{heading}</span>
              </motion.p>
            </AnimatePresence>
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.p key={detail} className={styles.bannerDetail} initial={swapIn} animate={{ opacity: 1, y: 0 }} exit={swapOut} transition={reduce ? instant : { ...swapTransition, delay: motionTokens.stagger.word }}>{detail}</motion.p>
            </AnimatePresence>
          </div>
          <AnimatePresence mode="popLayout" initial={false}>
            {done ? null : (
              <motion.span key="action" className={styles.bannerAction} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: reduce ? instant : { duration: motionTokens.duration.exit, ease: easeExit } }} transition={swapTransition}>
                <Button variant="secondary" className={styles.bannerButton} loading={deploy.state === "running"} onClick={onRedeploy}>
                  <RefreshCw size={16} strokeWidth={1.75} aria-hidden="true" />{deploy.state === "running" ? "Redeploying" : failed ? "Try again" : "Redeploy"}
                </Button>
              </motion.span>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

/* ---------- Scope toggle ---------- */

/** One cell of the environment matrix. In the wide table only the box shows under its column head; narrow rows and the add form show the label beside it. */
function ScopeToggle({ env, on, name, onToggle, reduce }: { env: EnvName; on: boolean; name?: string; onToggle: () => void; reduce: boolean }) {
  return (
    <button type="button" className={styles.scope} data-on={on} aria-pressed={on} aria-label={name ? `${envLabel(env)} for ${name}` : undefined} onClick={onToggle}>
      <span className={styles.box} aria-hidden="true">
        <motion.span className={styles.boxFill} initial={false} animate={{ opacity: on ? 1 : 0, scale: on ? 1 : .6 }} transition={reduce ? instant : { scale: motionTokens.spring.snappy, opacity: { duration: motionTokens.duration.instant } }} />
        <svg className={styles.boxMark} viewBox="0 0 18 18" fill="none" focusable="false">
          <motion.path d="M5 9.4l2.6 2.6L13 6.6" initial={false} animate={{ pathLength: on ? 1 : 0, opacity: on ? 1 : 0 }} transition={reduce ? instant : { pathLength: motionTokens.spring.smooth, opacity: { duration: motionTokens.duration.instant } }} stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <span className={styles.scopeLabel}>{envLabel(env)}</span>
    </button>
  );
}

/* ---------- Variable list ---------- */

type ListProps = {
  rows: EnvVariable[];
  total: number;
  query: string;
  envCounts: number[];
  revealed: Set<string>;
  editing: string | null;
  changed: Set<string>;
  fresh: Set<string>;
  note: { id: string; text: string } | null;
  reduce: boolean;
  onToggleEnv: (id: string, env: EnvName) => void;
  onToggleReveal: (id: string) => void;
  onEdit: (id: string) => void;
  onCloseEditor: (id: string) => void;
  onSave: (id: string, value: string, sensitive: boolean) => void;
  onRemove: (id: string) => void;
  onClearSearch: () => void;
  onAdd: () => void;
};

function VariableList({ rows, total, query, envCounts, revealed, editing, changed, fresh, note, reduce, onToggleEnv, onToggleReveal, onEdit, onCloseEditor, onSave, onRemove, onClearSearch, onAdd }: ListProps) {
  const smooth: Transition = reduce ? instant : motionTokens.spring.smooth;
  if (!rows.length) {
    return (
      <div className={styles.empty}>
        <p className={styles.emptyTitle}>{total ? `No keys match "${query.trim()}"` : "No variables yet"}</p>
        <p className={styles.emptyText}>{total ? "Search looks at key names only. Values stay hidden." : "Add one, or paste a .env file to import many at once."}</p>
        {total ? <Button variant="secondary" onClick={onClearSearch}>Clear search</Button> : <Button variant="secondary" onClick={onAdd}><Plus size={16} strokeWidth={1.75} aria-hidden="true" />Add variable</Button>}
      </div>
    );
  }
  return (
    <div className={styles.table}>
      <div className={styles.columns} aria-hidden="true">
        <span>Key</span>
        <span>Value</span>
        {ENVIRONMENTS.map((env, index) => <span key={env.id} className={styles.envHead}>{env.label}<span className={styles.envCount}>{envCounts[index]} set</span></span>)}
        <span />
      </div>
      <ul className={styles.list} aria-label="Variables">
        <AnimatePresence initial={false}>
          {rows.map(row => (
            <motion.li
              key={row.id}
              className={styles.item}
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1, transition: smooth }}
              exit={{ height: 0, opacity: 0, transition: reduce ? instant : { duration: motionTokens.duration.exit, ease: easeExit } }}
            >
              <VariableRow
                row={row}
                revealed={revealed.has(row.id)}
                editing={editing === row.id}
                changed={changed.has(row.id)}
                fresh={fresh.has(row.id)}
                note={note?.id === row.id ? note.text : null}
                reduce={reduce}
                onToggleEnv={env => onToggleEnv(row.id, env)}
                onToggleReveal={() => onToggleReveal(row.id)}
                onEdit={() => onEdit(row.id)}
                onCloseEditor={() => onCloseEditor(row.id)}
                onSave={(value, sensitive) => onSave(row.id, value, sensitive)}
                onRemove={() => onRemove(row.id)}
              />
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </div>
  );
}

type RowProps = {
  row: EnvVariable;
  revealed: boolean;
  editing: boolean;
  changed: boolean;
  fresh: boolean;
  note: string | null;
  reduce: boolean;
  onToggleEnv: (env: EnvName) => void;
  onToggleReveal: () => void;
  onEdit: () => void;
  onCloseEditor: () => void;
  onSave: (value: string, sensitive: boolean) => void;
  onRemove: () => void;
};

function VariableRow({ row, revealed, editing, changed, fresh, note, reduce, onToggleEnv, onToggleReveal, onEdit, onCloseEditor, onSave, onRemove }: RowProps) {
  const editorId = useId();
  const smooth: Transition = reduce ? instant : motionTokens.spring.smooth;
  const exit = reduce ? instant : { duration: motionTokens.duration.exit, ease: easeExit };
  const swap = reduce
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
    : { initial: { opacity: 0, y: 4 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: -4 } };
  return (
    <div className={styles.row} data-editing={editing || undefined} data-fresh={fresh || undefined}>
      <div className={styles.rowMain}>
        <div className={styles.keyCell}>
          <span className={styles.keyLine}>
            <span className={styles.key}>{row.key}</span>
            {changed ? <span className={styles.changedDot} aria-hidden="true" /> : null}
          </span>
          <span className={styles.updated} data-changed={changed || undefined}>{changed ? "Changed, waiting for redeploy" : `Updated ${row.updated} by ${row.updatedBy}`}</span>
        </div>

        <div className={styles.valueCell}>
          <span className={styles.valueSlot}>
            <AnimatePresence mode="popLayout" initial={false}>
              {revealed && !row.sensitive ? (
                <motion.span key="value" className={styles.value} title={row.value} {...swap} transition={reduce ? instant : { duration: motionTokens.duration.standard, ease: easeStandard }}>{row.value}</motion.span>
              ) : (
                <motion.span key="mask" className={styles.mask} {...swap} transition={reduce ? instant : { duration: motionTokens.duration.fast, ease: easeStandard }}>
                  <span aria-hidden="true">{MASK}</span>
                  <span className={styles.srOnly}>{row.sensitive ? "Sensitive value, write-only" : "Hidden value"}</span>
                </motion.span>
              )}
            </AnimatePresence>
          </span>
          {row.sensitive ? (
            <span className={styles.sensitive}><Lock size={14} strokeWidth={1.75} aria-hidden="true" />Sensitive</span>
          ) : (
            <span className={styles.valueActions}>
              <AnimatePresence initial={false}>
                {revealed ? (
                  <motion.span key="copy" className={styles.copySlot} initial={reduce ? { opacity: 0 } : { opacity: 0, scale: .8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: reduce ? 1 : .8, transition: reduce ? instant : { duration: motionTokens.duration.exit, ease: easeExit } }} transition={reduce ? instant : motionTokens.spring.snappy}>
                    <CopyButton value={row.value} label={`Copy ${row.key}`} iconOnly variant="plain" />
                  </motion.span>
                ) : null}
              </AnimatePresence>
              <button type="button" className={styles.iconButton} aria-pressed={revealed} aria-label={`Reveal ${row.key}`} onClick={onToggleReveal}>
                {revealed ? <EyeOff size={16} strokeWidth={1.75} aria-hidden="true" /> : <Eye size={16} strokeWidth={1.75} aria-hidden="true" />}
              </button>
            </span>
          )}
        </div>

        <div className={styles.scopes} role="group" aria-label={`Environments for ${row.key}`}>
          {ENVIRONMENTS.map(env => (
            <ScopeToggle key={env.id} env={env.id} on={row.environments.includes(env.id)} name={row.key} onToggle={() => onToggleEnv(env.id)} reduce={reduce} />
          ))}
        </div>

        <div className={styles.rowActions}>
          <button type="button" className={styles.iconButton} data-edit={row.id} data-active={editing || undefined} aria-expanded={editing} aria-controls={editing ? editorId : undefined} aria-label={`Edit ${row.key}`} onClick={onEdit}>
            <Pencil size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {note ? (
          <motion.p key="note" className={styles.noteClip} role="alert" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1, transition: smooth }} exit={{ height: 0, opacity: 0, transition: exit }}>
            <span className={styles.note}><TriangleAlert size={14} strokeWidth={1.75} aria-hidden="true" />{note}</span>
          </motion.p>
        ) : null}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {editing ? (
          <motion.div key="editor" id={editorId} className={styles.editorClip} initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1, transition: smooth }} exit={{ height: 0, opacity: 0, transition: exit }}>
            <RowEditor row={row} onCancel={onCloseEditor} onSave={onSave} onRemove={onRemove} />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function RowEditor({ row, onCancel, onSave, onRemove }: { row: EnvVariable; onCancel: () => void; onSave: (value: string, sensitive: boolean) => void; onRemove: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(row.sensitive ? "" : row.value);
  const [sensitive, setSensitive] = useState(row.sensitive);
  const [confirmRemove, setConfirmRemove] = useState(false);
  useEffect(() => { inputRef.current?.focus({ preventScroll: true }); }, []);
  const dirty = (row.sensitive ? value.length > 0 : value !== row.value && value.length > 0) || sensitive !== row.sensitive;
  const empty = !row.sensitive && value.length === 0;
  function onKeyDown(event: ReactKeyboardEvent<HTMLFormElement>) {
    if (event.key === "Escape") { event.stopPropagation(); onCancel(); }
  }
  return (
    <form className={styles.editor} onKeyDown={onKeyDown} onSubmit={event => { event.preventDefault(); if (dirty && !empty) onSave(value, sensitive); }}>
      <Input
        ref={inputRef}
        label={`Value for ${joinEnvs(row.environments)}`}
        className={styles.monoInput}
        value={value}
        placeholder={row.sensitive ? "Enter a new value to replace it" : undefined}
        autoComplete="off"
        spellCheck={false}
        error={empty ? "A value can't be empty. Remove the variable instead." : undefined}
        onChange={event => setValue(event.target.value)}
      />
      <Checkbox
        label="Sensitive"
        checked={sensitive}
        disabled={row.sensitive}
        description={row.sensitive ? "This value is write-only. To make it readable again, remove it and add it back." : "Write-only after saving. It can be replaced, but nobody can reveal it again."}
        onCheckedChange={next => setSensitive(next === true)}
      />
      <div className={styles.editorActions}>
        <Button type="button" variant={confirmRemove ? "danger" : "ghost"} className={styles.removeButton} onClick={() => { if (confirmRemove) onRemove(); else setConfirmRemove(true); }} onBlur={() => setConfirmRemove(false)}>
          {confirmRemove ? "Confirm remove" : "Remove variable"}
        </Button>
        <span className={styles.editorEnd}>
          <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!dirty || empty}>Save value</Button>
        </span>
      </div>
    </form>
  );
}

/* ---------- Add panel ---------- */

function AddPanel({ mode, rows, sampleDotenv, reduce, onModeChange, onCancel, onAdd }: {
  mode: AddMode;
  rows: EnvVariable[];
  sampleDotenv: string;
  reduce: boolean;
  onModeChange: (mode: AddMode) => void;
  onCancel: () => void;
  onAdd: (entries: { key: string; value: string; sensitive: boolean }[], environments: EnvName[]) => void;
}) {
  const keyRef = useRef<HTMLInputElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [sensitive, setSensitive] = useState(false);
  const [envs, setEnvs] = useState<EnvName[]>(["development", "preview"]);
  const [text, setText] = useState(sampleDotenv);
  const [tried, setTried] = useState(false);

  useEffect(() => {
    const node = mode === "single" ? keyRef.current : areaRef.current;
    const frame = window.requestAnimationFrame(() => node?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [mode]);

  const parsed = useMemo(() => parseDotenv(text, rows, envs), [text, rows, envs]);
  const importable = parsed.filter(line => line.status === "new" || line.status === "replace");
  const skipped = parsed.length - importable.length;

  const trimmedKey = key.trim();
  const conflict = trimmedKey ? envs.filter(env => rows.some(row => row.key === trimmedKey && row.environments.includes(env))) : [];
  const keyProblem = keyError(trimmedKey) || (tried && !trimmedKey ? "Enter a key" : "") || (conflict.length ? `Already set in ${joinEnvs(conflict)}. Edit that row, or turn those environments off here.` : "");
  const valueProblem = tried && !value ? "Enter a value" : "";
  const envProblem = envs.length ? "" : "Choose at least one environment";

  function toggle(env: EnvName) { setEnvs(current => current.includes(env) ? current.filter(item => item !== env) : ENV_ORDER.filter(item => item === env || current.includes(item))); }

  function onKeyPaste(event: ClipboardEvent<HTMLInputElement>) {
    const pasted = event.clipboardData.getData("text");
    if (!/\r?\n/.test(pasted.trim()) || !pasted.includes("=")) return;
    event.preventDefault();
    setText(pasted);
    onModeChange("paste");
  }

  function submitSingle() {
    setTried(true);
    if (!trimmedKey || !value || keyProblem || envProblem) return;
    onAdd([{ key: trimmedKey, value, sensitive }], envs);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") { event.stopPropagation(); onCancel(); }
  }

  const scopePicker = (
    <fieldset className={styles.pickEnvs}>
      <legend className={styles.fieldLabel}>{mode === "single" ? "Environments" : "Import into"}</legend>
      <div className={styles.pickRow}>
        {ENVIRONMENTS.map(env => <ScopeToggle key={env.id} env={env.id} on={envs.includes(env.id)} onToggle={() => toggle(env.id)} reduce={reduce} />)}
      </div>
      {envProblem ? <span className={styles.fieldError}>{envProblem}</span> : null}
    </fieldset>
  );

  return (
    <div className={styles.add} onKeyDown={onKeyDown} role="group" aria-label={mode === "single" ? "Add a variable" : "Import a .env file"}>
      <div className={styles.addHead}>
        <SegmentedControl label="How to add" value={mode} onValueChange={next => onModeChange(next as AddMode)} options={[{ value: "single", label: "One variable" }, { value: "paste", label: "Paste .env" }]} />
      </div>

      {mode === "single" ? (
        <form className={styles.addForm} onSubmit={event => { event.preventDefault(); submitSingle(); }}>
          <div className={styles.pair}>
            <Input ref={keyRef} label="Key" className={styles.monoInput} placeholder="e.g. CLIENT_ID" value={key} autoComplete="off" spellCheck={false} description={keyProblem ? undefined : "Paste a whole .env here to import many at once"} error={keyProblem || undefined} onPaste={onKeyPaste} onChange={event => setKey(event.target.value)} />
            <Input label="Value" className={styles.monoInput} value={value} autoComplete="off" spellCheck={false} error={valueProblem || undefined} onChange={event => setValue(event.target.value)} />
          </div>
          <div className={styles.addOptions}>
            {scopePicker}
            <Checkbox label="Sensitive" description="Write-only after saving" checked={sensitive} onCheckedChange={next => setSensitive(next === true)} />
          </div>
          <div className={styles.addActions}>
            <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
            <Button type="submit" variant="primary">Save variable</Button>
          </div>
        </form>
      ) : (
        <form className={styles.addForm} onSubmit={event => { event.preventDefault(); if (importable.length && envs.length) onAdd(importable.map(line => ({ key: line.key, value: line.value, sensitive: false })), envs); }}>
          <Textarea ref={areaRef} label=".env contents" className={styles.monoArea} rows={7} value={text} spellCheck={false} autoComplete="off" onChange={event => setText(event.target.value)} />
          {scopePicker}
          <div className={styles.parsed}>
            <p className={styles.parsedSummary} aria-live="polite">
              {parsed.length ? <><span className={styles.num}>{importable.length}</span> to import{skipped ? <>, <span className={styles.num}>{skipped}</span> skipped</> : null}</> : "Paste lines like KEY=value. Comments and blank lines are ignored."}
            </p>
            {parsed.length ? (
              <ul className={styles.parsedList}>
                {parsed.map(line => (
                  <li key={`${line.line}-${line.key}`} className={styles.parsedRow} data-status={line.status}>
                    <span className={styles.parsedLine}>{line.line}</span>
                    <span className={styles.parsedKey}>{line.key}</span>
                    <span className={styles.parsedValue} aria-hidden="true">{line.value ? "••••••••" : ""}</span>
                    <span className={styles.parsedStatus}>
                      {line.status === "new" ? <Plus size={14} strokeWidth={1.75} aria-hidden="true" /> : line.status === "invalid" ? <CircleAlert size={14} strokeWidth={1.75} aria-hidden="true" /> : <TriangleAlert size={14} strokeWidth={1.75} aria-hidden="true" />}
                      {line.detail}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <div className={styles.addActions}>
            <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={!importable.length || !envs.length}>{importable.length === 1 ? "Import 1 variable" : `Import ${importable.length} variables`}</Button>
          </div>
        </form>
      )}
    </div>
  );
}

/* ---------- Compare ---------- */

const statusCopy = (status: DiffStatus, base: EnvName, target: EnvName) =>
  status === "missing-target" ? `Missing in ${envLabel(target)}` : status === "missing-base" ? `Missing in ${envLabel(base)}` : status === "different" ? "Different values" : "Same value";

function CompareView({ rows, needle, base, target, showMatching, reduce, onBase, onTarget, onSwap, onShowMatching, onCopy, onClearSearch }: {
  rows: EnvVariable[];
  needle: string;
  base: EnvName;
  target: EnvName;
  showMatching: boolean;
  reduce: boolean;
  onBase: (env: EnvName) => void;
  onTarget: (env: EnvName) => void;
  onSwap: () => void;
  onShowMatching: (show: boolean) => void;
  onCopy: (row: EnvVariable, env: EnvName) => void;
  onClearSearch: () => void;
}) {
  const smooth: Transition = reduce ? instant : motionTokens.spring.smooth;
  const all = diffRows(rows, base, target).filter(row => !needle || row.key.toLowerCase().includes(needle));
  const missing = all.filter(row => row.status === "missing-base" || row.status === "missing-target").length;
  const different = all.filter(row => row.status === "different").length;
  const same = all.length - missing - different;
  const shown = showMatching ? all : all.filter(row => row.status !== "same");
  const options = ENVIRONMENTS.map(env => ({ value: env.id, label: env.label }));

  return (
    <div className={styles.compare}>
      <div className={styles.compareControls}>
        <div className={styles.pickers}>
          <Select label="Environment" value={base} options={options.map(option => ({ ...option, disabled: option.value === target }))} onValueChange={value => onBase(value as EnvName)} />
          <button type="button" className={styles.swap} aria-label="Swap environments" onClick={onSwap}><ArrowLeftRight size={16} strokeWidth={1.75} aria-hidden="true" /></button>
          <Select label="Compared with" value={target} options={options.map(option => ({ ...option, disabled: option.value === base }))} onValueChange={value => onTarget(value as EnvName)} />
        </div>
        <div className={styles.summary}>
          <p className={styles.counts} aria-live="polite">
            <span data-tone="warning"><span><span className={styles.num}>{missing}</span> missing</span></span>
            <span data-tone="info"><span><span className={styles.num}>{different}</span> different</span></span>
            <span><span><span className={styles.num}>{same}</span> matching</span></span>
          </p>
          <Switch label="Show matching" checked={showMatching} onCheckedChange={onShowMatching} />
        </div>
      </div>

      {shown.length ? (
        <div className={styles.table}>
          <div className={styles.diffColumns} aria-hidden="true">
            <span>Key</span>
            <span>{envLabel(base)}</span>
            <span>{envLabel(target)}</span>
            <span>Result</span>
          </div>
          <ul className={styles.list} aria-label={`${envLabel(base)} compared with ${envLabel(target)}`}>
            <AnimatePresence initial={false}>
              {shown.map(row => {
                const source = row.status === "missing-target" ? row.base : row.status === "missing-base" ? row.target : undefined;
                const destination = row.status === "missing-target" ? target : base;
                return (
                  <motion.li key={row.key} className={styles.item} initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1, transition: smooth }} exit={{ height: 0, opacity: 0, transition: reduce ? instant : { duration: motionTokens.duration.exit, ease: easeExit } }}>
                    <div className={styles.diffRow} data-status={row.status}>
                      <span className={styles.key}>{row.key}</span>
                      <DiffCell env={base} row={row.base} />
                      <DiffCell env={target} row={row.target} />
                      <span className={styles.diffResult}>
                        <span className={styles.diffStatus} data-status={row.status}>
                          {row.status === "same" ? <Check size={14} strokeWidth={1.75} aria-hidden="true" /> : row.status === "different" ? <ArrowLeftRight size={14} strokeWidth={1.75} aria-hidden="true" /> : <TriangleAlert size={14} strokeWidth={1.75} aria-hidden="true" />}
                          {statusCopy(row.status, base, target)}
                        </span>
                        {source ? <Button variant="secondary" className={styles.copyTo} onClick={() => onCopy(source, destination)}>Copy to {envLabel(destination)}</Button> : null}
                      </span>
                    </div>
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </ul>
        </div>
      ) : (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>{all.length ? `${envLabel(base)} and ${envLabel(target)} match` : "No keys match your search"}</p>
          <p className={styles.emptyText}>{all.length ? `Every key has the same value in both. Turn on Show matching to list all ${all.length}.` : "Search looks at key names only."}</p>
          {all.length ? <Button variant="secondary" onClick={() => onShowMatching(true)}>Show matching keys</Button> : <Button variant="secondary" onClick={onClearSearch}>Clear search</Button>}
        </div>
      )}
    </div>
  );
}

function DiffCell({ env, row }: { env: EnvName; row?: EnvVariable }) {
  if (!row) return <span className={styles.diffCell} data-empty><span className={styles.cellEnv}>{envLabel(env)}</span>Not set</span>;
  const print = fingerprint(row.value);
  return (
    <span className={styles.diffCell}>
      <span className={styles.cellEnv}>{envLabel(env)}</span>
      <span className={styles.print}><span aria-hidden="true">••••</span><span className={styles.srOnly}>Fingerprint</span> {print}</span>
      {row.sensitive ? <Lock size={14} strokeWidth={1.75} role="img" aria-label="Sensitive" /> : null}
    </span>
  );
}

export default EnvVariables;
