"use client";

import Image from "next/image";
import { useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import SegmentedControl from "../../segmented-control/segmented-control";
import { CopyButton } from "../../copy-button/copy-button";
import { portrait } from "../../lib/media";
import { motionTokens } from "../../lib/motion-tokens";
import styles from "./team-showcase.module.css";

export type TeamPerson = {
  id: string;
  name: string;
  role: string;
  location: string;
  image: string;
  introduction: string;
  focus: string;
  email: string;
  phone: string;
};

const examplePeople: TeamPerson[] = [
  {
    id: "emma",
    name: "Emma Collins",
    role: "Product designer",
    location: "Zürich, Switzerland",
    image: portrait("emma-collins"),
    introduction: "Emma turns complex product decisions into calm, useful experiences. She cares about the first five minutes of a workflow and the details people notice much later.",
    focus: "Design systems and onboarding",
    email: "emma@arc.example",
    phone: "+1 (202) 555-0101",
  },
  {
    id: "marcus",
    name: "Marcus Johnson",
    role: "Frontend engineer",
    location: "London, United Kingdom",
    image: portrait("marcus-johnson"),
    introduction: "Marcus builds the foundations that let good ideas become dependable interfaces. He is happiest when a component feels simple to use and has room to grow.",
    focus: "Component architecture",
    email: "marcus@arc.example",
    phone: "+1 (202) 555-0102",
  },
  {
    id: "ava",
    name: "Ava Mitchell",
    role: "Design lead",
    location: "Amsterdam, Netherlands",
    image: portrait("ava-mitchell"),
    introduction: "Ava gives teams a shared point of view. She connects research, product direction, and the small decisions that make a service feel coherent.",
    focus: "Product direction",
    email: "ava@arc.example",
    phone: "+1 (202) 555-0103",
  },
  {
    id: "jasmine",
    name: "Jasmine Brooks",
    role: "Platform engineer",
    location: "Berlin, Germany",
    image: portrait("jasmine-brooks"),
    introduction: "Jasmine keeps the platform steady as the product finds its next shape. She works across performance, integrations, and the systems that should quietly keep working.",
    focus: "Platform and performance",
    email: "jasmine@arc.example",
    phone: "+1 (202) 555-0104",
  },
  {
    id: "sofia",
    name: "Sofia Ramirez",
    role: "Operations partner",
    location: "New York, United States",
    image: portrait("sofia-ramirez"),
    introduction: "Sofia makes space for focused work across a distributed team. She brings the right context together and helps a promising idea find its next practical step.",
    focus: "Team operations",
    email: "sofia@arc.example",
    phone: "+1 (202) 555-0105",
  },
];


type Person = TeamPerson;

export type TeamVariant = "gallery" | "filmstrip" | "directory" | "spotlight";
export interface TeamShowcaseProps {
  variant?: TeamVariant;
  onPersonSelect?: (person: { id: string; name: string; role: string }) => void;
  /** The people to show. Defaults to five sample teammates. */
  people?: TeamPerson[];
  /** Heading above the team. */
  title?: string;
}

const variants = [
  { value: "gallery", label: "Gallery" },
  { value: "filmstrip", label: "Filmstrip" },
  { value: "directory", label: "Directory" },
  { value: "spotlight", label: "Spotlight" },
];

function Portrait({ person, sizes = "(max-width: 620px) 80vw, 30vw" }: { person: Person; sizes?: string }) {
  return <Image src={person.image} alt="" fill sizes={sizes} />;
}

function Contact({ person }: { person: Person }) {
  return <div className={styles.contact} aria-label={`Sample contact details for ${person.name}`}>
    <div className={styles.contactItems}>
      <span className={styles.contactItem}><span>{person.email}</span><CopyButton value={person.email} label={`Copy ${person.name}'s email`} iconOnly variant="plain" /></span>
      <span className={styles.contactItem}><span>{person.phone}</span><CopyButton value={person.phone} label={`Copy ${person.name}'s phone number`} iconOnly variant="plain" /></span>
    </div>
  </div>;
}

/**
 * Every person's content sits in one grid cell, so the stage always takes the height of the tallest entry and
 * nothing below it moves when the selection changes. The chosen entry fades in over the one leaving.
 */
function Crossfade({ people, selectedIndex, reduce, offset = 8, className, itemClassName, render }: {
  people: Person[];
  selectedIndex: number;
  reduce: boolean;
  offset?: number;
  className?: string;
  itemClassName?: string;
  render: (person: Person) => ReactNode;
}) {
  const fadeIn = { duration: motionTokens.duration.standard, ease: [...motionTokens.ease.standard] as [number, number, number, number] };
  return <div className={[styles.crossfade, className].filter(Boolean).join(" ")}>
    {people.map((person, index) => {
      const active = index === selectedIndex;
      const shift = reduce || active ? 0 : index < selectedIndex ? -offset : offset;
      return <motion.div key={person.id} className={itemClassName} data-active={active || undefined} aria-hidden={!active} inert={!active}
        initial={false} animate={{ opacity: active ? 1 : 0, x: 0, y: shift }}
        transition={reduce ? { duration: 0 } : active ? fadeIn : { ...fadeIn, duration: motionTokens.duration.fast }}>
        {render(person)}
      </motion.div>;
    })}
  </div>;
}

export function TeamShowcase({ variant = "gallery", onPersonSelect, people = examplePeople, title }: TeamShowcaseProps) {
  const reduce = useReducedMotion() ?? false;
  const id = useId();
  const filmRef = useRef<HTMLDivElement>(null);
  const galleryRef = useRef<HTMLDivElement>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const selected = people[selectedIndex];
  const [directoryOpen, setDirectoryOpen] = useState(true);
  const transition = { duration: reduce ? 0 : motionTokens.duration.standard, ease: [...motionTokens.ease.enter] as [number, number, number, number] };
  function choose(index: number) {
    const next = (index + people.length) % people.length;
    setSelectedIndex(next);
    const track = filmRef.current;
    const item = track?.children[next] as HTMLElement | undefined;
    if (track && item && track.scrollWidth > track.clientWidth) {
      track.scrollTo({ left: item.offsetLeft - (track.firstElementChild as HTMLElement).offsetLeft, behavior: reduce ? "instant" : "smooth" });
    }
    const galleryTrack = galleryRef.current;
    const galleryItem = galleryTrack?.children[next] as HTMLElement | undefined;
    if (galleryTrack && galleryItem && galleryTrack.scrollWidth > galleryTrack.clientWidth) {
      galleryTrack.scrollTo({ left: galleryItem.offsetLeft - (galleryTrack.firstElementChild as HTMLElement).offsetLeft, behavior: reduce ? "instant" : "smooth" });
    }
    onPersonSelect?.(people[next]);
  }
  const detail = <Crossfade people={people} selectedIndex={selectedIndex} reduce={reduce} className={styles.bioStack} itemClassName={styles.bio} render={person => <>
    <div><h3>{person.name}</h3><span>{person.role}</span></div>
    <p>{person.introduction}</p>
    <span className={styles.location}>{person.location}</span>
  </>} />;
  const announcement = <p className={styles.srOnly} aria-live="polite" aria-atomic="true">{selected.name}, {selected.role}</p>;
  const arrows = <div className={styles.arrows}>
    <button type="button" onClick={() => choose(selectedIndex - 1)} aria-label="Show previous team member"><ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" /></button>
    <span>{selectedIndex + 1} / {people.length}</span>
    <button type="button" onClick={() => choose(selectedIndex + 1)} aria-label="Show next team member"><ArrowRight size={16} strokeWidth={1.75} aria-hidden="true" /></button>
  </div>;

  return <section className={`${styles.showcase} ${styles[variant]}`} aria-labelledby={`${id}-title`}>
    <motion.header className={styles.header} initial={reduce ? false : { opacity: 0, y: 8 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: 0.5 }} transition={{ duration: reduce ? 0 : motionTokens.duration.considered, ease: [...motionTokens.ease.enter] }}>
      <h2 id={`${id}-title`}>{title ?? (variant === "directory" ? "The people behind Arc" : "Meet the team")}</h2>
      {variant !== "gallery" && <p>Five people across design, engineering, and operations.</p>}
    </motion.header>

    {variant === "gallery" && <>
      <div className={styles.galleryGrid} ref={galleryRef}>
        {people.map((person, index) => <motion.button type="button" key={person.id} initial={reduce ? false : { opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: 0.2 }} transition={{ duration: reduce ? 0 : motionTokens.duration.considered, delay: reduce ? 0 : index * 0.05, ease: [...motionTokens.ease.enter] }} onFocus={event => { event.currentTarget.style.opacity = "1"; event.currentTarget.style.transform = "none"; }} className={styles.galleryPerson} onClick={() => choose(index)} aria-pressed={selectedIndex === index} aria-label={`Read about ${person.name}`} aria-controls={`${id}-detail`}>
          <span className={styles.galleryPhoto}><Portrait person={person} sizes="(max-width: 620px) 70vw, 20vw" /></span>
          <span className={styles.personName}>{person.name}</span><span className={styles.personRole}>{person.role}</span>
        </motion.button>)}
      </div>
      <div id={`${id}-detail`} className={styles.galleryDetail}>
        <Crossfade people={people} selectedIndex={selectedIndex} reduce={reduce} className={styles.galleryBioStage} itemClassName={styles.galleryBio} render={person => <>
          <div className={styles.galleryBioIdentity}><h3>{person.name}</h3><span>{person.role} · {person.location}</span></div>
          <div className={styles.galleryBioContent}><p>{person.introduction}</p><Contact person={person} /></div>
        </>} />
        <div className={styles.galleryNavigation}>{arrows}</div>
        {announcement}
      </div>
    </>}

    {variant === "filmstrip" && <>
      <div ref={filmRef} className={styles.filmTrack}>
        {people.map((person, index) => <button type="button" key={person.id} className={styles.filmPerson} data-selected={selectedIndex === index} aria-pressed={selectedIndex === index} aria-label={`Read about ${person.name}`} aria-controls={`${id}-detail`} onClick={() => choose(index)}>
          <Portrait person={person} /><span className={styles.filmName}>{person.name}</span>
        </button>)}
      </div>
      <div id={`${id}-detail`} className={styles.filmDetail}>{detail}{arrows}{announcement}</div>
    </>}

    {variant === "directory" && <div className={styles.directoryList}>
      {people.map((person, index) => <div key={person.id} className={styles.directoryPerson} data-selected={selectedIndex === index}>
        <button type="button" className={styles.directoryTrigger} onClick={() => { setDirectoryOpen(index !== selectedIndex || !directoryOpen); choose(index); }} aria-expanded={selectedIndex === index && directoryOpen} aria-controls={`${id}-${person.id}`}>
          <span className={styles.directoryThumb}><Portrait person={person} sizes="96px" /></span><span className={styles.directoryName}>{person.name}</span><span className={styles.directoryRole}>{person.role}</span><svg className={styles.directoryIcon} data-open={(selectedIndex === index && directoryOpen) || undefined} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" aria-hidden="true"><path d="M5 12h14" /><path className={styles.directoryIconBar} d="M12 5v14" /></svg>
        </button>
        <AnimatePresence initial={false}>
          {selectedIndex === index && directoryOpen && <motion.div key="panel" id={`${id}-${person.id}`} className={styles.directoryPanel} initial={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { height: 0, opacity: 0 }}
            transition={reduce ? { duration: 0 } : { height: motionTokens.spring.smooth, opacity: { duration: motionTokens.duration.standard } }}>
            <div className={styles.directoryExpanded}>
              <div className={styles.directoryPhoto}><Portrait person={person} /></div><div><p>{person.introduction}</p><dl><div><dt>Based in</dt><dd>{person.location}</dd></div><div><dt>Working on</dt><dd>{person.focus}</dd></div></dl></div>
            </div>
          </motion.div>}
        </AnimatePresence>
      </div>)}
    </div>}

    {variant === "spotlight" && <>
      <div className={styles.spotlightStage}>
        <div className={styles.spotlightCopy}>{detail}{arrows}{announcement}</div>
        <div className={styles.spotlightPhoto}>
          {people.map((person, index) => {
            const active = index === selectedIndex;
            // The incoming photo fades in on top; the outgoing one stays opaque beneath it until it is covered, so the frame never dims.
            return <motion.div key={person.id} className={styles.spotlightLayer} aria-hidden="true" style={{ zIndex: active ? 1 : 0 }} initial={false}
              animate={{ opacity: active ? 1 : 0, x: active || reduce ? 0 : index < selectedIndex ? -12 : 12 }}
              transition={reduce ? { duration: 0 } : active ? transition : { duration: 0, delay: motionTokens.duration.standard }}><Portrait person={person} /></motion.div>;
          })}
        </div>
      </div>
      <nav className={styles.spotlightNav} aria-label="Choose a team member">{people.map((person, index) => <button type="button" key={person.id} onClick={() => choose(index)} aria-pressed={selectedIndex === index}><span className={styles.spotlightThumb}><Portrait person={person} sizes="64px" /></span><span>{person.name.split(" ")[0]}</span></button>)}</nav>
    </>}
  </section>;
}

export function TeamShowcaseReview() {
  const [variant, setVariant] = useState<TeamVariant>("gallery");
  return <div className={styles.review}>
    <div className={styles.reviewControls}><SegmentedControl label="Team section design" options={variants} value={variant} onValueChange={value => setVariant(value as TeamVariant)} /></div>
    <TeamShowcase key={variant} variant={variant} />
  </div>;
}

export default TeamShowcase;
