"use client";

import { useEffect, useId, useRef, useState } from "react";
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from "motion/react";
import { Check, Copy, Search, X } from "lucide-react";
import { Avatar } from "../../avatar/avatar";
import { avatar } from "../../lib/media";
import { motionTokens } from "../../lib/motion-tokens";
import styles from "./team-directory.module.css";

type Team = "Design" | "Engineering" | "Operations";

interface Person {
  id: string;
  name: string;
  role: string;
  team: Team;
  location: string;
  timezone: string;
  email: string;
  photo: string;
  available: boolean;
  about: string;
  focus: string;
}

// Example profiles. Replace the names, contact details, and portraits with your own team data.
const people: Person[] = [
  { id: "emma", name: "Emma Collins", role: "Product designer", team: "Design", location: "Zürich", timezone: "CET", email: "emma@arc.example", photo: avatar("emma-collins"), available: true, about: "Shapes clear, considered experiences across the product. Ask Emma about interaction design, prototypes, or a second pair of eyes on a flow.", focus: "Design system and onboarding" },
  { id: "marcus", name: "Marcus Johnson", role: "Frontend engineer", team: "Engineering", location: "London", timezone: "GMT", email: "marcus@arc.example", photo: avatar("marcus-johnson"), available: true, about: "Builds the interfaces and systems behind the details. Marcus works closely with design so components feel as good in code as they do on screen.", focus: "Component architecture" },
  { id: "ava", name: "Ava Mitchell", role: "Design lead", team: "Design", location: "Amsterdam", timezone: "CET", email: "ava@arc.example", photo: avatar("ava-mitchell"), available: false, about: "Connects product direction to the everyday work of the team. Ava can help with design reviews, priorities, and bringing an idea into focus.", focus: "Product direction" },
  { id: "daniel", name: "Daniel Kim", role: "Platform engineer", team: "Engineering", location: "Berlin", timezone: "CET", email: "daniel@arc.example", photo: avatar("daniel-kim"), available: true, about: "Keeps the platform dependable as the product grows. Reach out to Daniel for integrations, performance, and technical planning.", focus: "Platform and performance" },
  { id: "sofia", name: "Sofia Ramirez", role: "Operations lead", team: "Operations", location: "New York", timezone: "ET", email: "sofia@arc.example", photo: avatar("sofia-ramirez"), available: false, about: "Makes collaboration easier across teams and time zones. Sofia helps people find context, coordinate work, and keep projects moving.", focus: "Team operations" },
  { id: "hannah", name: "Hannah Walsh", role: "Customer success", team: "Operations", location: "Dublin", timezone: "GMT", email: "hannah@arc.example", photo: avatar("hannah-walsh"), available: true, about: "Turns customer conversations into clear next steps for the team. Hannah knows which accounts are blocked and why.", focus: "Enterprise onboarding" },
];

const filters = ["All", "Design", "Engineering", "Operations"] as const;
type Filter = (typeof filters)[number];

export interface TeamDirectoryProps {
  onPersonSelect?: (person: { id: string; name: string; team: Team }) => void;
}

export function TeamDirectory({ onPersonSelect }: TeamDirectoryProps) {
  const uid = useId();
  const reduce = useReducedMotion();
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("All");
  const [selectedId, setSelectedId] = useState(people[0].id);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");

  const needle = query.trim().toLowerCase();
  const visible = people.filter((person) => {
    const matchesFilter = filter === "All" || person.team === filter;
    const terms = `${person.name} ${person.role} ${person.team} ${person.location}`.toLowerCase();
    return matchesFilter && terms.includes(needle);
  });
  const selected = visible.find((person) => person.id === selectedId) ?? visible[0];

  useEffect(() => {
    if (copyState === "idle") return;
    const timeout = window.setTimeout(() => setCopyState("idle"), 1800);
    return () => window.clearTimeout(timeout);
  }, [copyState]);

  function choose(person: Person) {
    setSelectedId(person.id);
    setCopyState("idle");
    onPersonSelect?.({ id: person.id, name: person.name, team: person.team });
  }

  async function copyEmail() {
    if (!selected) return;
    try {
      await navigator.clipboard.writeText(selected.email);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  }

  function reset() {
    setQuery("");
    setFilter("All");
    setCopyState("idle");
    searchRef.current?.focus();
  }

  const listTransition = reduce ? { duration: 0 } : motionTokens.spring.smooth;

  return (
    <section className={styles.directory} aria-labelledby={`${uid}-title`}>
      <header className={styles.header}>
        <h2 id={`${uid}-title`}>People <span className={styles.count}>{people.length}</span></h2>
        <label className={styles.search}>
          <Search size={16} strokeWidth={1.75} aria-hidden="true" />
          <span className={styles.srOnly}>Search people</span>
          <input ref={searchRef} type="search" value={query} onChange={(event) => { setQuery(event.target.value); setCopyState("idle"); }} onKeyDown={(event) => { if (event.key === "Escape" && query) { event.preventDefault(); setQuery(""); } }} placeholder="Search name, role, city" />
          <span className={styles.clearSlot}>{query && <button type="button" onClick={() => { setQuery(""); searchRef.current?.focus(); }} aria-label="Clear search"><X size={14} strokeWidth={1.75} aria-hidden="true" /></button>}</span>
        </label>
      </header>

      <div className={styles.filters} role="group" aria-label="Filter by team">
        {filters.map((item) => {
          const count = item === "All" ? people.length : people.filter((person) => person.team === item).length;
          return <button key={item} type="button" aria-pressed={filter === item} onClick={() => { setFilter(item); setCopyState("idle"); }}>
            {filter === item && <motion.span layoutId={`${uid}-filter`} className={styles.filterHighlight} transition={reduce ? { duration: 0 } : motionTokens.spring.morph} aria-hidden="true" />}
            <span className={styles.filterLabel}>{item}<span className={styles.filterCount}>{count}</span></span>
          </button>;
        })}
      </div>

      <div className={styles.body}>
        <div className={styles.listPane}>
          <ul className={styles.peopleList} aria-label="Team members">
            <AnimatePresence mode="popLayout" initial={false}>
              {visible.map((person) => {
                const isSelected = selected?.id === person.id;
                return <motion.li
                  key={person.id}
                  layout={reduce ? false : "position"}
                  initial={reduce ? false : { opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0, transition: { duration: reduce ? 0 : motionTokens.duration.exit } }}
                  transition={{ layout: listTransition, opacity: { duration: reduce ? 0 : motionTokens.duration.fast } }}
                >
                  <button type="button" className={styles.personRow} aria-pressed={isSelected} onClick={() => choose(person)}>
                    {isSelected && <RowHighlight layoutId={`${uid}-row-${filter}-${needle}`} reduce={Boolean(reduce)} />}
                    <Avatar name={person.name} src={person.photo} status={person.available ? "online" : "offline"} />
                    <span className={styles.personText}><span className={styles.personName}>{person.name}</span><span className={styles.personRole}>{person.role}</span></span>
                  </button>
                </motion.li>;
              })}
            </AnimatePresence>
          </ul>
          {visible.length === 0 && <div className={styles.empty}>
            <p>No one matches{needle ? ` “${query.trim()}”` : ""}</p>
            <button type="button" onClick={reset}>Clear filters</button>
          </div>}
        </div>

        {/* Stacked on a phone, the profile rides up with the list as rows leave instead of jumping ahead of it. */}
        <motion.div className={styles.detailPane} layout={reduce ? false : "position"} transition={{ layout: listTransition }} aria-live="polite">
          <AnimatePresence mode="popLayout" initial={false}>
          {selected ? <motion.article
            key={selected.id}
            className={styles.profile}
            initial={reduce ? false : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: reduce ? 0 : motionTokens.duration.exit, ease: [...motionTokens.ease.standard] } }}
            transition={{ duration: reduce ? 0 : motionTokens.duration.standard, ease: [...motionTokens.ease.enter] }}
            aria-label={`${selected.name}, ${selected.role}`}
          >
            <div className={styles.profileTop}>
              <Avatar name={selected.name} src={selected.photo} size="lg" />
              <div className={styles.profileIdentity}>
                <h3>{selected.name}</h3>
                <p>{selected.role}</p>
              </div>
            </div>
            <p className={styles.about}>{selected.about}</p>
            <dl className={styles.facts}>
              <div><dt>Status</dt><dd><span className={styles.dot} data-available={selected.available || undefined} aria-hidden="true" />{selected.available ? "Available" : "Away"}</dd></div>
              <div><dt>Team</dt><dd>{selected.team}</dd></div>
              <div><dt>Working on</dt><dd>{selected.focus}</dd></div>
              <div><dt>Location</dt><dd>{selected.location} <span className={styles.muted}>{selected.timezone}</span></dd></div>
              <div className={styles.contactRow}>
                <dt>Email</dt>
                <dd>
                  <a href={`mailto:${selected.email}`}>{selected.email}</a>
                  <button type="button" className={styles.copy} data-state={copyState} onClick={() => void copyEmail()} aria-label={copyState === "copied" ? "Email copied" : "Copy email address"}>
                    <span className={styles.copyIcon} aria-hidden="true">
                      <Copy size={14} strokeWidth={1.75} data-on={copyState !== "copied" || undefined} />
                      <Check size={14} strokeWidth={2} data-on={copyState === "copied" || undefined} />
                    </span>
                    <span className={styles.copyLabel}>{copyState === "copied" ? "Copied" : copyState === "error" ? "Retry" : "Copy"}</span>
                  </button>
                </dd>
              </div>
            </dl>
            <span className={styles.srOnly} role="status">{copyState === "copied" ? "Email address copied" : copyState === "error" ? "Copy failed. Try again." : ""}</span>
          </motion.article> : <motion.div key="none" className={styles.noProfile} initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: reduce ? 0 : motionTokens.duration.exit } }} transition={{ duration: reduce ? 0 : motionTokens.duration.standard, ease: [...motionTokens.ease.standard] }}><p>Nobody selected</p><span>Clear your search to see the team.</span></motion.div>}
          </AnimatePresence>
        </motion.div>
      </div>
    </section>
  );
}

/** The shared selection highlight. Its layout id carries the filter and query, so it morphs between rows on a click but rides along
 *  with its row when a filter moves the selection. A row that is leaving drops it at once, so the highlight never holds the exit open or splits in two. */
function RowHighlight({ layoutId, reduce }: { layoutId: string; reduce: boolean }) {
  const present = useIsPresent();
  if (!present) return null;
  return <motion.span layoutId={layoutId} className={styles.rowHighlight} transition={reduce ? { duration: 0 } : motionTokens.spring.morph} aria-hidden="true" />;
}

export default TeamDirectory;
