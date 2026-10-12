"use client";

import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import Image from "next/image";
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "motion/react";
import type { Transition } from "motion/react";
import { Check, Clock, CornerDownLeft, FileSpreadsheet, FileText, Film, Link2, Presentation, Search, SearchX, SlidersHorizontal, X } from "lucide-react";
import { motionTokens } from "../../lib/motion-tokens";
import { Avatar } from "../../avatar/avatar";
import { BottomSheet } from "../../bottom-sheet/bottom-sheet";
import { Button } from "../../button/button";
import { Checkbox } from "../../checkbox/checkbox";
import { EmptyState } from "../../empty-state/empty-state";
import { FilterToolbar } from "../../filter-toolbar/filter-toolbar";
import type { FilterChip } from "../../filter-toolbar/filter-toolbar";
import SegmentedControl from "../../segmented-control/segmented-control";
import { Slider } from "../../slider/slider";
import { personOf, photoOf, recentSearches as sampleRecent, referenceDate, results as sampleResults, suggestedSearches as sampleSuggested, teams as sampleTeams } from "./search-results-data";
import type { FileResult, SearchKind, SearchResult, SearchTeam } from "./search-results-data";
import styles from "./search-results.module.css";

/**
 * A faceted search results page for a workspace: a query bar with recent and suggested searches, a facet sidebar with
 * counts that follow the query, a last edited range, active filter chips, and one list of mixed results (docs, people,
 * and files) with every match highlighted. A keyboard cursor glides through the results and a preview pane follows it.
 * New queries load behind skeletons shaped like the results. Below 680px the facets move into a sheet, and below
 * 1120px the preview opens in a sheet.
 */

export type { DocResult, FileExtension, FileResult, PersonResult, SearchKind, SearchResult, SearchTeam } from "./search-results-data";
export type SearchSort = "relevance" | "newest" | "title";

export interface SearchFacets {
  types: SearchKind[];
  teams: string[];
  /** Months since the start of the range, inclusive. 0 is the oldest month, `RANGE_MAX` the reference month. */
  edited: [number, number];
}

export interface SearchResultsProps {
  /** Everything that can be found. Defaults to a sample workspace. */
  results?: SearchResult[];
  teams?: SearchTeam[];
  recentSearches?: string[];
  suggestedSearches?: string[];
  defaultQuery?: string;
  defaultSort?: SearchSort;
  /** ISO day that relative dates are measured from, so server and client render the same labels. */
  today?: string;
  /** Workspace name used in the placeholder. */
  workspace?: string;
  /** Simulated query time in milliseconds before results appear. 0 shows them at once. */
  latency?: number;
  /** Called when a query is run. */
  onSearch?: (query: string) => void;
  /** Called when a result is opened from its preview. */
  onOpen?: (result: SearchResult) => void;
  className?: string;
}

const RANGE_MAX = 12;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const KIND_LABEL: Record<SearchKind, string> = { doc: "Docs", person: "People", file: "Files" };
const KINDS: SearchKind[] = ["doc", "person", "file"];
const SORTS = [{ value: "relevance", label: "Best match" }, { value: "newest", label: "Newest" }, { value: "title", label: "A to Z" }];
const EXT_LABEL: Record<FileResult["ext"], string> = { pdf: "PDF", fig: "Figma", xlsx: "Spreadsheet", jpg: "Image", mp4: "Video", key: "Keynote" };
const cx = (...names: (string | false | undefined | null)[]) => names.filter(Boolean).join(" ");

/* ---------- Dates, fixed to a reference day so the first render is stable ---------- */

function parseDay(iso: string) { const [y, m, d] = iso.split("-").map(Number); return { y, m, d, t: Date.UTC(y, m - 1, d) }; }
function daysBetween(iso: string, today: string) { return Math.round((parseDay(today).t - parseDay(iso).t) / 86400000); }
/** "Today", "3 days ago", "Last week", or a date once it is more than a month old. `inline` reads inside a sentence. */
function relative(iso: string, today: string, inline = false) {
  const a = parseDay(iso), b = parseDay(today), days = daysBetween(iso, today);
  const phrase = days <= 0 ? "Today" : days === 1 ? "Yesterday" : days < 7 ? `${days} days ago` : days < 14 ? "Last week" : days < 31 ? `${Math.floor(days / 7)} weeks ago` : null;
  if (phrase) return inline ? phrase.toLowerCase() : phrase;
  const date = `${MONTHS[a.m - 1]} ${a.d}${a.y === b.y ? "" : `, ${a.y}`}`;
  return inline ? `on ${date}` : date;
}
function longDate(iso: string) { const a = parseDay(iso); return `${MONTHS[a.m - 1]} ${a.d}, ${a.y}`; }
/** Month slot on the edited range: RANGE_MAX is the reference month, 0 is twelve months before it. */
function monthSlot(iso: string, today: string) {
  const a = parseDay(iso), b = parseDay(today);
  return RANGE_MAX - ((b.y - a.y) * 12 + (b.m - a.m));
}
function monthLabel(slot: number, today: string) {
  const b = parseDay(today);
  const index = b.y * 12 + (b.m - 1) - (RANGE_MAX - slot);
  return `${MONTHS[index % 12]} ${Math.floor(index / 12)}`;
}

/* ---------- Matching ---------- */

const termsOf = (query: string) => query.toLowerCase().split(/\s+/).map(term => term.replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean);
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const titleOf = (result: SearchResult) => result.title;
const updatedOf = (result: SearchResult) => result.kind === "person" ? null : result.updated;

function haystack(result: SearchResult) {
  const extra = result.kind === "doc" ? `${result.path} ${result.body.join(" ")}` : result.kind === "person" ? `${result.role} ${result.location}` : EXT_LABEL[result.ext];
  return `${result.title} ${result.snippet} ${extra} ${result.keywords ?? ""}`.toLowerCase();
}
function score(result: SearchResult, terms: string[]) {
  const title = result.title.toLowerCase();
  return terms.reduce((sum, term) => sum + (title.includes(term) ? 3 : 0) + (result.snippet.toLowerCase().includes(term) ? 1 : 0), 0);
}
function matchCount(text: string, terms: string[]) {
  if (!terms.length) return 0;
  return (text.match(new RegExp(terms.map(escape).join("|"), "gi")) ?? []).length;
}

/** Wraps every query term in a mark. The marks carry the accent, the one place color says "this is why it matched". */
function Highlight({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length) return <>{text}</>;
  const pattern = new RegExp(`(${terms.map(escape).join("|")})`, "gi");
  return <>{text.split(pattern).map((part, index) => index % 2 ? <mark key={index} className={styles.mark}>{part}</mark> : <Fragment key={index}>{part}</Fragment>)}</>;
}

function distance(a: string, b: string) {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length];
}
/** A spelling fix built from words that exist in the results, so the suggestion always finds something. */
function didYouMean(terms: string[], vocabulary: string[]) {
  if (!terms.length) return null;
  let changed = false;
  const fixed = terms.map(term => {
    if (vocabulary.includes(term)) return term;
    let best = term, bestDistance = term.length > 5 ? 3 : 2;
    for (const word of vocabulary) { const d = distance(term, word); if (d < bestDistance) { best = word; bestDistance = d; } }
    if (best !== term) changed = true;
    return best;
  });
  return changed ? fixed.join(" ") : null;
}

/** A stable, believable query time derived from the query and filters. */
function queryTime(key: string) {
  let hash = 0;
  for (let index = 0; index < key.length; index++) hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
  return (6 + (hash % 19)) / 100;
}

/* ---------- Result visuals ---------- */

function FigmaMark() {
  return <svg className={styles.brand} viewBox="0 0 38 57" aria-hidden="true">
    <path fill="#1ABCFE" d="M19 28.5a9.5 9.5 0 1 1 19 0 9.5 9.5 0 0 1-19 0Z" />
    <path fill="#0ACF83" d="M0 47.5A9.5 9.5 0 0 1 9.5 38H19v9.5a9.5 9.5 0 1 1-19 0Z" />
    <path fill="#FF7262" d="M19 0v19h9.5a9.5 9.5 0 1 0 0-19H19Z" />
    <path fill="#F24E1E" d="M0 9.5A9.5 9.5 0 0 0 9.5 19H19V0H9.5A9.5 9.5 0 0 0 0 9.5Z" />
    <path fill="#A259FF" d="M0 28.5A9.5 9.5 0 0 0 9.5 38H19V19H9.5A9.5 9.5 0 0 0 0 28.5Z" />
  </svg>;
}

function FileGlyph({ file, size = 20 }: { file: FileResult; size?: number }) {
  const props = { size, strokeWidth: 1.75, "aria-hidden": true as const };
  if (file.ext === "fig") return <FigmaMark />;
  if (file.ext === "xlsx") return <FileSpreadsheet {...props} />;
  if (file.ext === "mp4") return <Film {...props} />;
  if (file.ext === "key") return <Presentation {...props} />;
  return <FileText {...props} />;
}

function Lead({ result }: { result: SearchResult }) {
  if (result.kind === "person") { const who = personOf(result.person); return <Avatar name={who.name} src={who.src} size="md" className={styles.leadAvatar} />; }
  if (result.kind === "file" && result.photo) {
    const image = photoOf(result.photo);
    return <span className={styles.thumb}><Image src={image.src} alt="" fill sizes="40px" /></span>;
  }
  return <span className={styles.glyph}>{result.kind === "doc" ? <FileText size={20} strokeWidth={1.75} aria-hidden="true" /> : <FileGlyph file={result} />}</span>;
}

function metaOf(result: SearchResult, teamLabel: (id: string) => string) {
  if (result.kind === "doc") return `Doc in ${result.path}`;
  if (result.kind === "person") return `${result.role}, ${result.location}`;
  return [EXT_LABEL[result.ext], result.pages ? `${result.pages} ${result.pages === 1 ? "page" : "pages"}` : null, result.size, teamLabel(result.team)].filter(Boolean).join(", ");
}

function footOf(result: SearchResult, today: string) {
  if (result.kind === "doc") return { who: personOf(result.author), text: `edited ${relative(result.updated, today, true)}` };
  if (result.kind === "file") return { who: personOf(result.owner), text: `uploaded ${relative(result.updated, today, true)}` };
  return null;
}

/* ---------- Facets ---------- */

interface FacetsProps {
  idPrefix: string;
  facets: SearchFacets;
  teams: SearchTeam[];
  typeCounts: Record<SearchKind, number>;
  teamCounts: Record<string, number>;
  today: string;
  active: boolean;
  onToggleType: (kind: SearchKind, on: boolean) => void;
  onToggleTeam: (team: string, on: boolean) => void;
  onRange: (range: [number, number]) => void;
  onClear: () => void;
  /** The sheet has its own title and footer, so it hides the heading row. */
  inSheet?: boolean;
}

function Facets({ inSheet = false, idPrefix, facets, teams, typeCounts, teamCounts, today, active, onToggleType, onToggleTeam, onRange, onClear }: FacetsProps) {
  const reduced = useReducedMotion();
  return <div className={styles.facets}>
    {inSheet ? null : <div className={styles.facetsHead}>
      <h3 className={styles.facetsTitle}>Filters</h3>
      <motion.button type="button" className={styles.clearAll} onClick={onClear} disabled={!active} initial={false} animate={{ opacity: active ? 1 : 0 }} transition={reduced ? { duration: 0 } : { duration: motionTokens.duration.fast, ease: [...motionTokens.ease.standard] }} aria-hidden={!active} tabIndex={active ? 0 : -1}>Clear all</motion.button>
    </div>}
    <fieldset className={styles.group}>
      <legend className={styles.legend}>Type</legend>
      <div className={styles.options}>
        {KINDS.map(kind => {
          const on = facets.types.includes(kind), count = typeCounts[kind];
          return <div key={kind} className={styles.option} data-empty={count === 0 && !on ? "" : undefined}>
            <Checkbox id={`${idPrefix}-type-${kind}`} label={KIND_LABEL[kind]} checked={on} disabled={count === 0 && !on} onCheckedChange={next => onToggleType(kind, next === true)} />
            <span className={styles.optionCount} aria-hidden="true">{count}</span>
          </div>;
        })}
      </div>
    </fieldset>
    <fieldset className={styles.group}>
      <legend className={styles.legend}>Team</legend>
      <div className={styles.options}>
        {teams.map(team => {
          const on = facets.teams.includes(team.id), count = teamCounts[team.id] ?? 0;
          return <div key={team.id} className={styles.option} data-empty={count === 0 && !on ? "" : undefined}>
            <Checkbox id={`${idPrefix}-team-${team.id}`} label={team.label} checked={on} disabled={count === 0 && !on} onCheckedChange={next => onToggleTeam(team.id, next === true)} />
            <span className={styles.optionCount} aria-hidden="true">{count}</span>
          </div>;
        })}
      </div>
    </fieldset>
    <div className={styles.group}>
      <Slider<[number, number]> label="Edited" value={facets.edited} onValueChange={onRange} min={0} max={RANGE_MAX} step={1} format={value => monthLabel(value, today)} thumbLabels={["Edited after", "Edited before"]} />
      <p className={styles.hint}>Applies to docs and files</p>
    </div>
  </div>;
}

/* ---------- Preview ---------- */

function Preview({ result, terms, today, teamLabel, onOpen }: { result: SearchResult; terms: string[]; today: string; teamLabel: (id: string) => string; onOpen?: (result: SearchResult) => void }) {
  const [phase, setPhase] = useState<"idle" | "busy" | "done">("idle");
  const [copied, setCopied] = useState<"idle" | "done" | "error">("idle");
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach(timer => window.clearTimeout(timer)), []);
  const later = (fn: () => void, ms: number) => { timers.current.push(window.setTimeout(fn, ms)); };
  const verb = result.kind === "doc" ? ["Open doc", "Opened"] : result.kind === "person" ? ["View profile", "Profile opened"] : ["Download", "Downloaded"];
  const open = () => {
    if (phase !== "idle") return;
    setPhase("busy");
    later(() => { setPhase("done"); onOpen?.(result); later(() => setPhase("idle"), 1800); }, 650);
  };
  const copy = () => {
    const url = `https://northwind.co/${result.kind}/${result.id}`;
    const done = (state: "done" | "error") => { setCopied(state); later(() => setCopied("idle"), 1600); };
    if (!navigator.clipboard) return done("error");
    navigator.clipboard.writeText(url).then(() => done("done"), () => done("error"));
  };
  const matches = result.kind === "doc" ? matchCount(`${result.title} ${result.body.join(" ")}`, terms) : matchCount(`${result.title} ${result.snippet}`, terms);
  const owner = result.kind === "doc" ? personOf(result.author) : result.kind === "file" ? personOf(result.owner) : null;

  return <article className={styles.previewCard} aria-label={`Preview of ${result.title}`}>
    {result.kind === "file" && result.photo ? <div className={styles.previewMedia}><Image src={photoOf(result.photo).src} alt={photoOf(result.photo).alt} fill sizes="(max-width: 720px) 100vw, 320px" /></div> : null}
    <header className={styles.previewHead}>
      {result.kind === "person"
        ? <Avatar name={result.title} src={personOf(result.person).src} size="lg" />
        : result.kind === "file" && !result.photo ? <span className={styles.previewGlyph}><FileGlyph file={result} size={24} /></span> : null}
      <div className={styles.previewTitles}>
        <h3 className={styles.previewTitle}><Highlight text={result.title} terms={terms} /></h3>
        <p className={styles.previewMeta}>{metaOf(result, teamLabel)}</p>
      </div>
    </header>

    {result.kind === "doc"
      ? <div className={styles.previewBody}>{result.body.map((paragraph, index) => <p key={index}><Highlight text={paragraph} terms={terms} /></p>)}</div>
      : <div className={styles.previewBody}><p><Highlight text={result.snippet} terms={terms} /></p></div>}

    <dl className={styles.facts}>
      {matches > 0 ? <div><dt>Matches</dt><dd className={styles.num}>{matches}</dd></div> : null}
      <div><dt>Team</dt><dd>{teamLabel(result.team)}</dd></div>
      {owner ? <div><dt>{result.kind === "doc" ? "Author" : "Owner"}</dt><dd className={styles.factPerson}><Avatar name={owner.name} src={owner.src} size="sm" />{owner.name}</dd></div> : null}
      {result.kind === "doc" ? <div><dt>Length</dt><dd className={styles.num}>{result.readMinutes} min read</dd></div> : null}
      {result.kind === "person" ? <><div><dt>Email</dt><dd className={styles.truncate} title={result.email}>{result.email}</dd></div><div><dt>Owns</dt><dd className={styles.num}>{result.owns} docs and files</dd></div></> : null}
      {result.kind !== "person" ? <div><dt>Last edited</dt><dd className={styles.num}>{longDate(result.updated)}{daysBetween(result.updated, today) < 31 ? <span className={styles.factMuted}>, {relative(result.updated, today, true)}</span> : null}</dd></div> : null}
    </dl>

    <div className={styles.previewActions}>
      <Button variant="primary" loading={phase === "busy"} onClick={open}>
        {phase === "done" ? <><Check size={16} strokeWidth={1.75} aria-hidden="true" />{verb[1]}</> : verb[0]}
      </Button>
      <Button variant="secondary" onClick={copy} aria-label={copied === "done" ? "Link copied" : copied === "error" ? "Copy failed" : "Copy link"}>
        {copied === "done" ? <><Check size={16} strokeWidth={1.75} aria-hidden="true" />Copied</> : copied === "error" ? "Copy failed" : <><Link2 size={16} strokeWidth={1.75} aria-hidden="true" />Copy link</>}
      </Button>
    </div>
    <p className={styles.srOnly} role="status">{phase === "done" ? `${verb[1]}: ${result.title}` : copied === "done" ? "Link copied" : copied === "error" ? "Copy failed" : ""}</p>
  </article>;
}

/* ---------- Count ---------- */

/** The result count rolls to its new value: up when results grow, down when a filter narrows them. */
function CountRoll({ value }: { value: number }) {
  const reduced = useReducedMotion();
  const [state, setState] = useState({ value, direction: 1 });
  if (state.value !== value) setState({ value, direction: value > state.value ? 1 : -1 });
  const d = state.direction;
  return <span className={styles.roll}>
    <AnimatePresence mode="popLayout" initial={false} custom={d}>
      <motion.span key={value} className={styles.rollValue} custom={d}
        variants={{ enter: (dir: number) => ({ y: reduced ? 0 : `${dir * 0.7}em`, opacity: 0 }), center: { y: 0, opacity: 1 }, exit: (dir: number) => ({ y: reduced ? 0 : `${dir * -0.7}em`, opacity: 0, transition: { duration: reduced ? 0 : motionTokens.duration.exit, ease: [...motionTokens.ease.exit] } }) }}
        initial="enter" animate="center" exit="exit" transition={reduced ? { duration: 0 } : motionTokens.spring.smooth}>{value}</motion.span>
    </AnimatePresence>
  </span>;
}

/* ---------- Skeletons ---------- */

const SKELETON_ROWS = [
  { lead: "square", title: 62, meta: 38, lines: [96, 71] },
  { lead: "round", title: 34, meta: 44, lines: [88, 52] },
  { lead: "square", title: 48, meta: 30, lines: [92, 64] },
  { lead: "square", title: 56, meta: 40, lines: [84, 58] },
  { lead: "round", title: 30, meta: 36, lines: [90, 44] },
];

function ResultSkeletons() {
  return <ul className={styles.skeletons} aria-hidden="true">
    {SKELETON_ROWS.map((row, index) => <li key={index} className={styles.skeletonRow}>
      <span className={cx(styles.bone, row.lead === "round" ? styles.boneRound : styles.boneSquare)} />
      <span className={styles.skeletonBody}>
        <span className={styles.bone} style={{ width: `${row.title}%`, height: 14 }} />
        <span className={styles.bone} style={{ width: `${row.meta}%`, height: 10 }} />
        {row.lines.map((width, line) => <span key={line} className={styles.bone} style={{ width: `${width}%`, height: 10 }} />)}
      </span>
    </li>)}
  </ul>;
}

/* ---------- Block ---------- */

type Suggestion = { id: string; text: string; group: "recent" | "suggested" };

export function SearchResults({
  results = sampleResults,
  teams = sampleTeams,
  recentSearches = sampleRecent,
  suggestedSearches = sampleSuggested,
  defaultQuery = "onboarding",
  defaultSort = "relevance",
  today = referenceDate,
  workspace = "Northwind",
  latency = 650,
  onSearch,
  onOpen,
  className,
}: SearchResultsProps) {
  const uid = useId().replace(/:/g, "");
  const reduced = useReducedMotion() ?? false;
  const rootRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const loadTimer = useRef<number | undefined>(undefined);

  const [draft, setDraft] = useState(defaultQuery);
  const [query, setQuery] = useState(defaultQuery);
  const [recent, setRecent] = useState(recentSearches);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuIndex, setMenuIndex] = useState(-1);
  const [loading, setLoading] = useState(false);
  const [sort, setSort] = useState<SearchSort>(defaultSort);
  const [facets, setFacets] = useState<SearchFacets>({ types: [], teams: [], edited: [0, RANGE_MAX] });
  const [activeId, setActiveId] = useState<string | null>(null);
  const [listFocused, setListFocused] = useState(false);
  const [paneVisible, setPaneVisible] = useState(true);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);

  useEffect(() => () => window.clearTimeout(loadTimer.current), []);

  // Whether the preview pane has room decides where a result opens. Measured after mount, so the server renders the wide layout.
  useEffect(() => {
    const node = rootRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setPaneVisible(entry.contentRect.width >= 1120));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // "/" focuses the query from anywhere on the page, unless someone is typing elsewhere.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName))) return;
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect || rect.bottom < 0 || rect.top > window.innerHeight) return;
      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const teamLabel = useCallback((id: string) => teams.find(team => team.id === id)?.label ?? id, [teams]);
  const terms = useMemo(() => termsOf(query), [query]);
  const matched = useMemo(() => results.filter(result => { const text = haystack(result); return terms.every(term => text.includes(term)); }), [results, terms]);

  const fullRange = facets.edited[0] === 0 && facets.edited[1] === RANGE_MAX;
  const passes = useCallback((result: SearchResult, skip?: "types" | "teams") => {
    if (skip !== "types" && facets.types.length && !facets.types.includes(result.kind)) return false;
    if (skip !== "teams" && facets.teams.length && !facets.teams.includes(result.team)) return false;
    const updated = updatedOf(result);
    if (!fullRange && updated) { const slot = monthSlot(updated, today); if (slot < facets.edited[0] || slot > facets.edited[1]) return false; }
    return true;
  }, [facets, fullRange, today]);

  const visible = useMemo(() => {
    const list = matched.filter(result => passes(result));
    const order = new Map(results.map((result, index) => [result.id, index]));
    const byOrder = (a: SearchResult, b: SearchResult) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0);
    if (sort === "title") return [...list].sort((a, b) => titleOf(a).localeCompare(titleOf(b), "en"));
    if (sort === "newest") return [...list].sort((a, b) => (updatedOf(b) ?? "").localeCompare(updatedOf(a) ?? "") || byOrder(a, b));
    return [...list].sort((a, b) => score(b, terms) - score(a, terms) || byOrder(a, b));
  }, [matched, passes, results, sort, terms]);

  // Counts are disjunctive within a group: each option counts what you would see if you added it, given every other filter.
  const typeCounts = useMemo(() => {
    const counts = { doc: 0, person: 0, file: 0 } as Record<SearchKind, number>;
    matched.forEach(result => { if (passes(result, "types")) counts[result.kind] += 1; });
    return counts;
  }, [matched, passes]);
  const teamCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    matched.forEach(result => { if (passes(result, "teams")) counts[result.team] = (counts[result.team] ?? 0) + 1; });
    return counts;
  }, [matched, passes]);

  const filterCount = facets.types.length + facets.teams.length + (fullRange ? 0 : 1);
  const chips: FilterChip[] = useMemo(() => [
    ...facets.types.map(kind => ({ id: `type:${kind}`, label: "Type", value: KIND_LABEL[kind] })),
    ...facets.teams.map(team => ({ id: `team:${team}`, label: "Team", value: teamLabel(team) })),
    ...(fullRange ? [] : [{ id: "edited", label: "Edited", value: facets.edited[0] === facets.edited[1] ? monthLabel(facets.edited[0], today) : `${monthLabel(facets.edited[0], today)} to ${monthLabel(facets.edited[1], today)}` }]),
  ], [facets, fullRange, teamLabel, today]);

  const active = visible.find(result => result.id === activeId) ?? visible[0] ?? null;
  const activeIndex = active ? visible.indexOf(active) : -1;
  const resultKey = `${query}|${sort}|${chips.map(chip => chip.id + chip.value).join(",")}`;
  const seconds = queryTime(resultKey);

  // Suggestions: recent first, then suggested, filtered by what is typed once it differs from the running query.
  const suggestions = useMemo<Suggestion[]>(() => {
    const needle = draft.trim().toLowerCase();
    const filtering = needle && needle !== query.trim().toLowerCase();
    const keep = (text: string) => !filtering || text.toLowerCase().includes(needle);
    const recentRows = recent.filter(keep).slice(0, 4).map((text, index) => ({ id: `r${index}`, text, group: "recent" as const }));
    const taken = new Set(recentRows.map(row => row.text.toLowerCase()));
    const suggestedRows = suggestedSearches.filter(text => keep(text) && !taken.has(text.toLowerCase())).slice(0, 4).map((text, index) => ({ id: `s${index}`, text, group: "suggested" as const }));
    return [...recentRows, ...suggestedRows];
  }, [draft, query, recent, suggestedSearches]);
  const showMenu = menuOpen && suggestions.length > 0;

  const run = useCallback((text: string) => {
    const next = text.trim();
    setDraft(next);
    setMenuOpen(false);
    setMenuIndex(-1);
    setActiveId(null);
    setQuery(next);
    if (next) setRecent(list => [next, ...list.filter(item => item.toLowerCase() !== next.toLowerCase())].slice(0, 5));
    onSearch?.(next);
    scrollRef.current?.scrollTo({ top: 0 });
    window.clearTimeout(loadTimer.current);
    if (latency > 0) { setLoading(true); loadTimer.current = window.setTimeout(() => setLoading(false), latency); }
  }, [latency, onSearch]);

  const clearFacets = useCallback(() => setFacets({ types: [], teams: [], edited: [0, RANGE_MAX] }), []);
  const removeChip = (id: string) => setFacets(current => {
    if (id === "edited") return { ...current, edited: [0, RANGE_MAX] };
    const [group, value] = id.split(":");
    return group === "type" ? { ...current, types: current.types.filter(kind => kind !== value) } : { ...current, teams: current.teams.filter(team => team !== value) };
  });
  const toggleType = (kind: SearchKind, on: boolean) => setFacets(current => ({ ...current, types: on ? KINDS.filter(item => item === kind || current.types.includes(item)) : current.types.filter(item => item !== kind) }));
  const toggleTeam = (team: string, on: boolean) => setFacets(current => ({ ...current, teams: on ? teams.map(item => item.id).filter(id => id === team || current.teams.includes(id)) : current.teams.filter(id => id !== team) }));
  const setRange = (range: [number, number]) => setFacets(current => ({ ...current, edited: range }));

  const openResult = (result: SearchResult) => {
    setActiveId(result.id);
    if (!paneVisible) setPreviewOpen(true);
  };

  const moveTo = (index: number) => {
    const next = visible[Math.max(0, Math.min(visible.length - 1, index))];
    if (!next) return;
    setActiveId(next.id);
    requestAnimationFrame(() => document.getElementById(`${uid}-r-${next.id}`)?.scrollIntoView({ block: "nearest" }));
  };

  const onInputKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (showMenu) setMenuIndex(index => (index + 1) % suggestions.length);
      else if (!menuOpen && suggestions.length && draft.trim() !== query) { setMenuOpen(true); setMenuIndex(0); }
      else if (visible.length && !loading) { setMenuOpen(false); listRef.current?.focus(); }
      return;
    }
    if (event.key === "ArrowUp" && showMenu) { event.preventDefault(); setMenuIndex(index => index <= 0 ? suggestions.length - 1 : index - 1); return; }
    if (event.key === "Enter") { event.preventDefault(); const pick = showMenu && menuIndex >= 0 ? suggestions[menuIndex] : null; run(pick ? pick.text : draft); return; }
    if (event.key === "Escape") {
      if (showMenu) { event.preventDefault(); setMenuOpen(false); setMenuIndex(-1); }
      else if (draft) { event.preventDefault(); setDraft(""); setMenuOpen(true); }
    }
  };

  const onListKey = (event: ReactKeyboardEvent<HTMLUListElement>) => {
    const key = event.key;
    if (key === "ArrowDown" || key === "j") { event.preventDefault(); moveTo(activeIndex + 1); }
    else if (key === "ArrowUp" || key === "k") {
      event.preventDefault();
      if (activeIndex <= 0) inputRef.current?.focus(); else moveTo(activeIndex - 1);
    }
    else if (key === "Home") { event.preventDefault(); moveTo(0); }
    else if (key === "End") { event.preventDefault(); moveTo(visible.length - 1); }
    else if (key === "Enter" || key === " ") { event.preventDefault(); if (active) openResult(active); }
    else if (key === "Escape" || key === "/") { event.preventDefault(); inputRef.current?.focus(); inputRef.current?.select(); }
  };

  // Empty state helpers.
  const vocabulary = useMemo(() => Array.from(new Set(results.flatMap(result => termsOf(`${result.title} ${result.snippet}`)).filter(word => word.length > 3))), [results]);
  const fix = visible.length ? null : didYouMean(terms, vocabulary);
  const withoutFilters = filterCount ? matched.length : 0;

  const fadeList: Transition = reduced ? { duration: 0 } : { duration: motionTokens.duration.standard, ease: [...motionTokens.ease.enter] };
  const cursorSpring: Transition = reduced ? { duration: 0 } : motionTokens.spring.smooth;
  const listboxId = `${uid}-suggestions`;
  const facetProps = { facets, teams, typeCounts, teamCounts, today, active: filterCount > 0, onToggleType: toggleType, onToggleTeam: toggleTeam, onRange: setRange, onClear: clearFacets };

  return <section ref={rootRef} className={cx(styles.root, className)} aria-label={`Search ${workspace}`}>
    <div className={styles.frame}>
      <header className={styles.top}>
        <div className={styles.queryWrap}>
          <form className={styles.query} role="search" onSubmit={event => { event.preventDefault(); run(draft); }} data-open={showMenu ? "" : undefined}>
            <Search className={styles.queryIcon} size={18} strokeWidth={1.75} aria-hidden="true" />
            <label htmlFor={`${uid}-q`} className={styles.srOnly}>Search {workspace}</label>
            <input
              ref={inputRef}
              id={`${uid}-q`}
              className={styles.queryInput}
              type="text"
              inputMode="search"
              enterKeyHint="search"
              autoComplete="off"
              spellCheck={false}
              placeholder={`Search docs, people, and files in ${workspace}`}
              value={draft}
              role="combobox"
              aria-expanded={showMenu}
              aria-controls={listboxId}
              aria-autocomplete="list"
              aria-activedescendant={showMenu && menuIndex >= 0 ? `${listboxId}-${suggestions[menuIndex]?.id}` : undefined}
              onChange={event => { setDraft(event.target.value); setMenuOpen(true); setMenuIndex(-1); }}
              onFocus={() => setMenuOpen(true)}
              onBlur={() => { setMenuOpen(false); setMenuIndex(-1); }}
              onKeyDown={onInputKey}
            />
            <AnimatePresence initial={false}>
              {draft ? <motion.button key="clear" type="button" className={styles.queryClear} aria-label="Clear search text" onMouseDown={event => event.preventDefault()} onClick={() => { setDraft(""); setMenuOpen(true); inputRef.current?.focus(); }}
                initial={reduced ? { opacity: 0 } : { opacity: 0, scale: .6 }} animate={{ opacity: 1, scale: 1 }} exit={reduced ? { opacity: 0 } : { opacity: 0, scale: .6, transition: { duration: motionTokens.duration.exit, ease: [...motionTokens.ease.exit] } }} transition={reduced ? { duration: 0 } : motionTokens.spring.snappy}>
                <X size={16} strokeWidth={1.75} aria-hidden="true" />
              </motion.button> : null}
            </AnimatePresence>
            <kbd className={styles.slash} aria-hidden="true">/</kbd>
          </form>

          <AnimatePresence>
            {showMenu ? <motion.div key="menu" className={styles.menu}
              initial={reduced ? { opacity: 0 } : { opacity: 0, y: -4, scale: .98 }} animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: -4, scale: .98, transition: { duration: motionTokens.duration.exit, ease: [...motionTokens.ease.exit] } }}
              transition={reduced ? { duration: 0 } : motionTokens.spring.smooth}>
              <ul id={listboxId} role="listbox" aria-label="Search suggestions" className={styles.menuList}>
                {(["recent", "suggested"] as const).map(group => {
                  const rows = suggestions.filter(row => row.group === group);
                  if (!rows.length) return null;
                  return <li key={group} role="presentation" className={styles.menuGroup}>
                    <span className={styles.menuLabel} id={`${listboxId}-${group}`} aria-hidden="true">{group === "recent" ? "Recent" : "Suggested"}</span>
                    <ul role="group" aria-labelledby={`${listboxId}-${group}`} className={styles.menuRows}>
                      {rows.map(row => {
                        const index = suggestions.indexOf(row);
                        return <li key={row.id} id={`${listboxId}-${row.id}`} role="option" aria-selected={index === menuIndex} className={styles.menuRow} data-active={index === menuIndex ? "" : undefined}
                          onMouseDown={event => event.preventDefault()} onMouseMove={() => setMenuIndex(index)} onClick={() => run(row.text)}>
                          {group === "recent" ? <Clock size={16} strokeWidth={1.75} aria-hidden="true" /> : <Search size={16} strokeWidth={1.75} aria-hidden="true" />}
                          <span className={styles.menuText}><Highlight text={row.text} terms={draft.trim().toLowerCase() === query.trim().toLowerCase() ? [] : termsOf(draft)} /></span>
                          <CornerDownLeft className={styles.menuEnter} size={14} strokeWidth={1.75} aria-hidden="true" />
                        </li>;
                      })}
                    </ul>
                  </li>;
                })}
              </ul>
            </motion.div> : null}
          </AnimatePresence>
        </div>

        <BottomSheet
          open={filtersOpen}
          onOpenChange={setFiltersOpen}
          title="Filters"
          detents={[.9]}
          trigger={<button type="button" className={styles.filterButton} aria-label={filterCount ? `Filters, ${filterCount} applied` : "Filters"}>
            <SlidersHorizontal size={16} strokeWidth={1.75} aria-hidden="true" />Filters
            {filterCount ? <span className={styles.filterBadge}>{filterCount}</span> : null}
          </button>}
        >
          <div className={styles.sheetFacets}>
            <Facets idPrefix={`${uid}-sheet`} inSheet {...facetProps} />
            <div className={styles.sheetFooter}>
              <Button variant="secondary" onClick={clearFacets} disabled={!filterCount}>Clear all</Button>
              <Button variant="primary" className={styles.sheetDone} onClick={() => setFiltersOpen(false)}>{visible.length === 1 ? "Show 1 result" : `Show ${visible.length} results`}</Button>
            </div>
          </div>
        </BottomSheet>
      </header>

      <div className={styles.body}>
        <aside className={styles.sidebar} aria-label="Filters">
          <Facets idPrefix={`${uid}-side`} {...facetProps} />
        </aside>

        <div ref={scrollRef} className={styles.main}>
          <div className={styles.mainHead}>
            <p className={styles.count}>
              {loading ? <span className={styles.countLoading}>Searching</span> : <>
                <span className={styles.countValue}><CountRoll value={visible.length} /></span>
                <span>{visible.length === 1 ? " result" : " results"}</span>
                <span className={styles.countTime}> in <span className={styles.num}>{seconds.toFixed(2)}</span> seconds</span>
              </>}
            </p>
            <SegmentedControl label="Sort results" options={SORTS} value={sort} onValueChange={value => setSort(value as SearchSort)} className={styles.sort} />
          </div>
          <p className={styles.srOnly} role="status">{loading ? `Searching for ${query}` : `${visible.length} ${visible.length === 1 ? "result" : "results"}${query ? ` for ${query}` : ""}`}</p>

          <AnimatePresence initial={false}>
            {chips.length ? <motion.div key="chips" className={styles.chipsFrame} initial={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { height: 0, opacity: 0, transition: { ...motionTokens.spring.smooth, opacity: { duration: motionTokens.duration.exit } } }} transition={reduced ? { duration: 0 } : motionTokens.spring.smooth}>
              <div className={styles.chips}><FilterToolbar filters={chips} onRemove={removeChip} onClearAll={clearFacets} /></div>
            </motion.div> : null}
          </AnimatePresence>

          <div className={styles.results} aria-busy={loading || undefined}>
            <AnimatePresence mode="popLayout" initial={false}>
              {loading
                ? <motion.div key="loading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: reduced ? 0 : motionTokens.duration.exit } }} transition={fadeList}><ResultSkeletons /></motion.div>
                : visible.length
                  ? <motion.div key={resultKey} initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: { duration: reduced ? 0 : motionTokens.duration.exit } }} transition={fadeList}>
                    {/* Scoped to this result set: a new sort or filter cross-fades the whole list, so the cursor appears with it instead of flying across rows from the old order. */}
                    <LayoutGroup id={`${uid}-cursor-${resultKey}`}>
                      <ul ref={node => { if (node) listRef.current = node; }} className={styles.list} role="listbox" tabIndex={0} aria-label={query ? `Results for ${query}` : "Results"} aria-activedescendant={active ? `${uid}-r-${active.id}` : undefined}
                        onKeyDown={onListKey} onFocus={() => setListFocused(true)} onBlur={() => setListFocused(false)} data-focused={listFocused ? "" : undefined}>
                        {visible.map(result => {
                          const isActive = result.id === active?.id;
                          const foot = footOf(result, today);
                          return <li key={result.id} id={`${uid}-r-${result.id}`} role="option" aria-selected={isActive} className={styles.result} data-active={isActive ? "" : undefined} data-kind={result.kind} onClick={() => openResult(result)}>
                            {isActive ? <motion.span layoutId="cursor" className={styles.cursor} transition={cursorSpring} aria-hidden="true" /> : null}
                            <span className={styles.lead}><Lead result={result} /></span>
                            <span className={styles.content}>
                              <span className={styles.titleRow}>
                                <span className={styles.title}><Highlight text={result.title} terms={terms} /></span>
                              </span>
                              <span className={styles.meta}>{metaOf(result, teamLabel)}</span>
                              <span className={styles.snippet}><Highlight text={result.snippet} terms={terms} /></span>
                              {foot ? <span className={styles.foot}><Avatar name={foot.who.name} src={foot.who.src} size="sm" className={styles.footAvatar} aria-hidden="true" /><span>{foot.who.name} {foot.text}</span></span>
                                : result.kind === "person" ? <span className={styles.foot}><span>{result.email}</span></span> : null}
                            </span>
                          </li>;
                        })}
                      </ul>
                    </LayoutGroup>
                    <p className={styles.keys} aria-hidden="true"><kbd>↑</kbd><kbd>↓</kbd> to move, <kbd>↵</kbd> to open, <kbd>/</kbd> to search</p>
                  </motion.div>
                  : <motion.div key={`empty-${resultKey}`} className={styles.emptyWrap} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: reduced ? 0 : motionTokens.duration.exit } }} transition={fadeList}>
                    <EmptyState
                      icon={<SearchX width={24} height={24} strokeWidth={1.5} />}
                      title={query ? `No results for “${query}”` : "Nothing matches these filters"}
                      description={withoutFilters ? `Your filters hide ${withoutFilters === 1 ? "1 result" : `${withoutFilters} results`}. Clear them to see everything that matches.` : fix ? `Check the spelling, or try one of these searches.` : "Try a broader word, or one of these searches."}
                      action={<div className={styles.emptyActions}>
                        {withoutFilters ? <Button variant="primary" size="sm" onClick={clearFacets}>Clear filters</Button> : null}
                        {!withoutFilters && fix ? <Button variant="primary" size="sm" onClick={() => run(fix)}>Search for “{fix}”</Button> : null}
                        {!withoutFilters ? suggestedSearches.slice(0, 3).map(text => <Button key={text} variant="secondary" size="sm" onClick={() => run(text)}>{text}</Button>) : null}
                      </div>}
                    />
                  </motion.div>}
            </AnimatePresence>
          </div>
        </div>

        <aside className={styles.preview} aria-label="Preview">
          <AnimatePresence mode="popLayout" initial={false}>
            {loading
              ? <motion.div key="loading" className={styles.previewSkeleton} aria-hidden="true" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: reduced ? 0 : motionTokens.duration.exit } }}>
                <span className={styles.bone} style={{ width: "70%", height: 18 }} />
                <span className={styles.bone} style={{ width: "45%", height: 10 }} />
                <span className={styles.bone} style={{ width: "100%", height: 10, marginTop: 12 }} />
                <span className={styles.bone} style={{ width: "92%", height: 10 }} />
                <span className={styles.bone} style={{ width: "64%", height: 10 }} />
              </motion.div>
              : active
                ? <motion.div key={active.id} initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: { duration: reduced ? 0 : motionTokens.duration.instant } }} transition={fadeList}>
                  <Preview result={active} terms={terms} today={today} teamLabel={teamLabel} onOpen={onOpen} />
                </motion.div>
                : <motion.p key="none" className={styles.previewEmpty} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>{visible.length ? "Select a result to preview it here" : "Nothing to preview"}</motion.p>}
          </AnimatePresence>
        </aside>
      </div>
    </div>

    <BottomSheet open={previewOpen && !paneVisible && !!active} onOpenChange={setPreviewOpen} title={active ? (active.kind === "doc" ? "Doc" : active.kind === "person" ? "Person" : "File") : "Preview"} detents={[.62, .92]}>
      {active ? <div className={styles.sheetPreview}><Preview key={active.id} result={active} terms={terms} today={today} teamLabel={teamLabel} onOpen={onOpen} /></div> : <span />}
    </BottomSheet>
  </section>;
}

export default SearchResults;
