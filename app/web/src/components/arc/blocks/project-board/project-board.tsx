"use client";

import { useId, useRef, useState } from "react";
import Image from "next/image";
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "motion/react";
import { ArrowLeft, ArrowRight, MessageCircle, Plus } from "lucide-react";
import { motionTokens } from "../../lib/motion-tokens";
import { people } from "../../lib/media";
import styles from "./project-board.module.css";

type Stage = "Planned" | "In progress" | "Review" | "Done";
type Owner = "emma-collins" | "marcus-johnson" | "ava-mitchell";
type Task = { id: string; title: string; project: string; stage: Stage; owner: Owner; comments: number; due: string };

const stages: Stage[] = ["Planned", "In progress", "Review", "Done"];
const me: Owner = "emma-collins";
const team: Owner[] = ["emma-collins", "marcus-johnson", "ava-mitchell"];
const person = (id: Owner) => people.find((item) => item.id === id) ?? people[0];

const initialTasks: Task[] = [
  { id: "flows", title: "Map the first-run journey", project: "Onboarding", stage: "Planned", owner: "emma-collins", comments: 3, due: "Today" },
  { id: "copy", title: "Write empty state copy", project: "Onboarding", stage: "Planned", owner: "ava-mitchell", comments: 1, due: "Tomorrow" },
  { id: "tokens", title: "Refine surface tokens", project: "Design system", stage: "In progress", owner: "emma-collins", comments: 5, due: "Thu" },
  { id: "motion", title: "Prototype menu motion", project: "Design system", stage: "In progress", owner: "marcus-johnson", comments: 2, due: "Fri" },
  { id: "audit", title: "Accessibility pass", project: "Onboarding", stage: "Review", owner: "marcus-johnson", comments: 7, due: "Today" },
  { id: "notes", title: "Publish research notes", project: "Research", stage: "Done", owner: "ava-mitchell", comments: 2, due: "Sep 14" },
];

const drafts = ["Outline next experiment", "Draft release notes", "Plan usability sessions", "Clean up icon set"];

export interface ProjectBoardProps { onTaskMove?: (task: { id: string; title: string; stage: Stage }) => void }

/** A four stage board. Cards travel between columns with their arrows; every change stays in this preview. */
export function ProjectBoard({ onTaskMove }: ProjectBoardProps) {
  const reduce = useReducedMotion();
  const groupId = useId();
  const [tasks, setTasks] = useState(initialTasks);
  /** The card in flight between columns: it travels at full opacity above the other columns, and its old copy leaves at once. */
  const [moving, setMoving] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "mine">("all");
  const [announcement, setAnnouncement] = useState("");
  const draftIndex = useRef(0);
  const shown = filter === "mine" ? tasks.filter((task) => task.owner === me) : tasks;
  const completed = tasks.filter((task) => task.stage === "Done").length;
  const spring = reduce ? { duration: 0 } : motionTokens.spring.gentle;

  function move(task: Task, direction: -1 | 1) {
    const next = stages[stages.indexOf(task.stage) + direction];
    if (!next) return;
    setMoving(task.id);
    setTasks((current) => [...current.filter((item) => item.id !== task.id), { ...task, stage: next }]);
    setAnnouncement(`${task.title} moved to ${next}.`);
    onTaskMove?.({ id: task.id, title: task.title, stage: next });
  }

  function addTask() {
    const title = drafts[draftIndex.current % drafts.length];
    draftIndex.current += 1;
    setTasks((current) => [...current, { id: `task-${Date.now()}`, title, project: "Research", stage: "Planned", owner: me, comments: 0, due: "No date" }]);
    setAnnouncement(`${title} added to Planned.`);
  }

  return <LayoutGroup id={groupId}><section className={styles.board} aria-label="Project board">
    <header className={styles.header}>
      <div className={styles.heading}>
        <h2>Product work</h2>
        <p><span className={styles.tabular}>{completed}</span> of <span className={styles.tabular}>{tasks.length}</span> done this sprint</p>
      </div>
      <div className={styles.headerActions}>
        <div className={styles.people} aria-label="Team">{team.map((id) => { const item = person(id); return <Image key={id} src={item.src} width={28} height={28} alt={item.name} />; })}</div>
        <div className={styles.filters} role="group" aria-label="Show">
          {([["all", "All work"], ["mine", "My work"]] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>
            {filter === value && <motion.span layoutId="filter" className={styles.filterHighlight} transition={reduce ? { duration: 0 } : motionTokens.spring.snappy} aria-hidden="true" />}
            <span>{label}</span>
          </button>)}
        </div>
        <button className={styles.addButton} type="button" onClick={addTask} aria-label="Add task"><Plus size={16} strokeWidth={1.75} aria-hidden="true" /><span>Add task</span></button>
      </div>
    </header>
    <div className={styles.progress} aria-hidden="true"><motion.span initial={false} animate={{ scaleX: tasks.length ? completed / tasks.length : 0 }} transition={spring} /></div>

    <motion.div className={styles.stageScroll} layoutScroll>
      <div className={styles.stages}>
        {stages.map((stage, stageIndex) => {
          const cards = shown.filter((task) => task.stage === stage);
          return <section className={styles.stage} key={stage} aria-label={`${stage}, ${cards.length} tasks`}>
            <div className={styles.stageHead}><h3>{stage}</h3><span className={styles.stageCount}>{cards.length}</span></div>
            <div className={styles.cardStack}>
              <AnimatePresence mode="popLayout" initial={false} custom={moving}>
                {cards.map((task) => {
                  const owner = person(task.owner);
                  return <motion.article key={task.id} layoutId={reduce ? undefined : `task-${task.id}`} layoutCrossfade={false} custom={moving} variants={{ exit: (inFlight: string | null) => inFlight === task.id ? { opacity: 0, transition: { duration: 0 } } : reduce ? { opacity: 0 } : { opacity: 0, scale: .98 } }} initial={reduce || task.id === moving ? false : { opacity: 0, scale: .98 }} animate={{ opacity: 1, scale: 1 }} exit="exit" transition={spring} onLayoutAnimationComplete={task.id === moving ? () => setMoving(null) : undefined} className={styles.card} data-moving={task.id === moving || undefined} data-done={stage === "Done" || undefined}>
                    <div className={styles.cardTop}><span>{task.project}</span><span className={styles.due} data-soon={task.due === "Today" && stage !== "Done" ? "" : undefined}>{task.due}</span></div>
                    <h4>{task.title}</h4>
                    <div className={styles.cardBottom}>
                      <Image className={styles.avatar} src={owner.src} width={22} height={22} alt={owner.name} />
                      {task.comments > 0 && <span className={styles.comments}><MessageCircle size={14} strokeWidth={1.75} aria-hidden="true" /><span className={styles.tabular}>{task.comments}</span><span className={styles.srOnly}> comments</span></span>}
                      <div className={styles.moveButtons}>
                        <button type="button" onClick={() => move(task, -1)} disabled={stageIndex === 0} aria-label={`Move ${task.title} to ${stages[stageIndex - 1] ?? "previous stage"}`}><ArrowLeft size={14} strokeWidth={1.75} /></button>
                        <button type="button" onClick={() => move(task, 1)} disabled={stageIndex === stages.length - 1} aria-label={`Move ${task.title} to ${stages[stageIndex + 1] ?? "next stage"}`}><ArrowRight size={14} strokeWidth={1.75} /></button>
                      </div>
                    </div>
                  </motion.article>;
                })}
              </AnimatePresence>
              {cards.length === 0 && <p className={styles.empty}>{filter === "mine" ? "Nothing assigned to you" : "No tasks yet"}</p>}
            </div>
          </section>;
        })}
      </div>
    </motion.div>
    <span className={styles.srOnly} role="status">{announcement}</span>
  </section></LayoutGroup>;
}

export default ProjectBoard;
