"use client";

import { useId, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Check } from "lucide-react";
import { Avatar } from "../../avatar/avatar";
import { Button } from "../../button/button";
import { motionTokens } from "../../lib/motion-tokens";
import styles from "./availability-picker.module.css";

const attendees = [
  { name: "Emma Collins", first: "Emma", src: "/media/people/emma-collins.jpg" },
  { name: "Marcus Johnson", first: "Marcus", src: "/media/people/marcus-johnson.jpg" },
  { name: "Ava Mitchell", first: "Ava", src: "/media/people/ava-mitchell.jpg" },
] as const;

type Slot = { time: string; busy?: (typeof attendees)[number]["first"] };

/** Sample free/busy data for one week. `busy` names the attendee who has a conflict. */
const days: { id: string; short: string; date: string; full: string; slots: Slot[] }[] = [
  { id: "mon", short: "Mon", date: "21", full: "Monday, 21 September", slots: [{ time: "09:30" }, { time: "10:30" }, { time: "14:00", busy: "Marcus" }, { time: "16:00" }] },
  { id: "tue", short: "Tue", date: "22", full: "Tuesday, 22 September", slots: [{ time: "09:00", busy: "Ava" }, { time: "11:00" }, { time: "13:30" }, { time: "15:00", busy: "Emma" }] },
  { id: "wed", short: "Wed", date: "23", full: "Wednesday, 23 September", slots: [{ time: "09:30" }, { time: "10:30", busy: "Marcus" }, { time: "14:30" }, { time: "16:30" }] },
  { id: "thu", short: "Thu", date: "24", full: "Thursday, 24 September", slots: [{ time: "08:30", busy: "Emma" }, { time: "10:00" }, { time: "13:00" }, { time: "15:30", busy: "Ava" }] },
  { id: "fri", short: "Fri", date: "25", full: "Friday, 25 September", slots: [{ time: "09:30" }, { time: "11:30" }, { time: "14:00", busy: "Marcus" }, { time: "15:30" }] },
];

const addMinutes = (time: string, minutes: number) => {
  const [h, m] = time.split(":").map(Number);
  const total = h * 60 + m + minutes;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};

/** Times slide in from the side of the day you moved toward; the old list leaves the other way. */
const slideVariants = {
  enter: (direction: number) => ({ opacity: 0, x: direction * 16 }),
  center: { opacity: 1, x: 0 },
  exit: (direction: number) => ({ opacity: 0, x: direction * -16, transition: { duration: motionTokens.duration.fast, ease: [...motionTokens.ease.standard] as [number, number, number, number] } }),
};
const fadeVariants = { enter: { opacity: 0 }, center: { opacity: 1 }, exit: { opacity: 0, transition: { duration: 0 } } };

export interface AvailabilityPickerProps {
  onConfirm?: (selection: { date: string; time: string }) => void;
}

export function AvailabilityPicker({ onConfirm }: AvailabilityPickerProps) {
  const reduce = !!useReducedMotion();
  const id = useId();
  const [dayId, setDayId] = useState(days[0].id);
  const [direction, setDirection] = useState(1);
  const [time, setTime] = useState("10:30");
  const [confirmed, setConfirmed] = useState(false);
  const day = days.find((entry) => entry.id === dayId) ?? days[0];
  const slot = day.slots.find((entry) => entry.time === time) ?? day.slots[0];
  const summary = `${day.full}, ${slot.time} to ${addMinutes(slot.time, 30)}`;
  const selectionLabel = confirmed ? "Invites sent" : slot.busy ? `${slot.busy} will be asked to move a conflict` : "Everyone is free";

  function selectDay(index: number) {
    const next = days[index];
    if (next.id === dayId) return;
    setDirection(index > days.findIndex((entry) => entry.id === dayId) ? 1 : -1);
    setDayId(next.id);
    setTime((next.slots.find((entry) => !entry.busy) ?? next.slots[0]).time);
    setConfirmed(false);
  }

  function selectTime(next: string) {
    setTime(next);
    setConfirmed(false);
  }

  function confirm() {
    setConfirmed(true);
    onConfirm?.({ date: day.full, time: slot.time });
  }

  const swap = reduce
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
    : { initial: { opacity: 0, y: 4, filter: `blur(${motionTokens.blur.subtle}px)` }, animate: { opacity: 1, y: 0, filter: "blur(0px)" }, exit: { opacity: 0, y: -4, filter: `blur(${motionTokens.blur.subtle}px)` } };
  const swapTransition = { duration: reduce ? motionTokens.duration.instant : motionTokens.duration.fast, ease: [...motionTokens.ease.standard] as [number, number, number, number] };

  return <section className={styles.root} aria-labelledby={`${id}-title`}>
    <div className={styles.picker}>
      <header className={styles.header}>
        <div className={styles.headerCopy}>
          <h2 id={`${id}-title`}>Product review</h2>
          <p>30 minutes · Zürich time</p>
        </div>
        <div className={styles.attendees} aria-label="Attendees: Emma Collins, Marcus Johnson and Ava Mitchell">
          {attendees.map((person) => <Avatar key={person.name} name={person.name} src={person.src} size="sm" />)}
        </div>
      </header>

      <div className={styles.days} role="group" aria-label="Week of 21 September">
        {days.map((entry, index) => {
          const selected = dayId === entry.id;
          const open = entry.slots.filter((item) => !item.busy).length;
          return <button key={entry.id} type="button" className={styles.day} data-selected={selected || undefined} aria-pressed={selected} aria-label={`${entry.full}, ${open} times everyone is free`} onClick={() => selectDay(index)}>
            {selected && <motion.span layoutId={`${id}-day`} className={styles.dayHighlight} transition={reduce ? { duration: 0 } : motionTokens.spring.snappy} />}
            <span className={styles.dayName}>{entry.short}</span>
            <span className={styles.dayDate}>{entry.date}</span>
            <span className={styles.dayOpen}>{open} open</span>
          </button>;
        })}
      </div>

      <div className={styles.slotsHead}>
        <h3 className={styles.slotsTitle}>
          <span className={styles.swap}>
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span key={day.id} {...swap} transition={swapTransition}>{day.full}</motion.span>
            </AnimatePresence>
          </span>
        </h3>
        <span className={styles.legend}><i className={styles.markFree} aria-hidden="true" />Free<i className={styles.markBusy} aria-hidden="true" />Busy</span>
      </div>

      <div className={styles.slotsStage}>
        <AnimatePresence mode="popLayout" initial={false} custom={direction}>
          <motion.ul
            key={day.id}
            className={styles.slots}
            aria-label={`Times on ${day.full}`}
            custom={direction}
            variants={reduce ? fadeVariants : slideVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={reduce ? { duration: motionTokens.duration.instant } : { x: motionTokens.spring.smooth, opacity: { duration: motionTokens.duration.fast } }}
          >
            {day.slots.map((entry) => {
              const selected = slot.time === entry.time;
              const status = entry.busy ? `${entry.busy} is busy` : "Everyone is free";
              return <li key={entry.time}>
                <button type="button" className={styles.slot} data-selected={selected || undefined} data-busy={entry.busy ? "" : undefined} aria-pressed={selected} aria-label={`${entry.time} to ${addMinutes(entry.time, 30)}, ${status}`} onClick={() => selectTime(entry.time)}>
                  <span className={styles.slotTime}>{entry.time}</span>
                  <span className={styles.slotMeta}>{status}</span>
                  <span className={styles.marks} aria-hidden="true">{attendees.map((person) => <i key={person.name} className={entry.busy === person.first ? styles.markBusy : styles.markFree} />)}</span>
                  <span className={styles.slotCheck} aria-hidden="true"><Check size={14} strokeWidth={2} /></span>
                </button>
              </li>;
            })}
          </motion.ul>
        </AnimatePresence>
      </div>

      <footer className={styles.footer}>
        <div className={styles.selection}>
          <span className={styles.swap}>
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span key={selectionLabel} className={styles.selectionLabel} {...swap} transition={swapTransition}>{selectionLabel}</motion.span>
            </AnimatePresence>
          </span>
          <span className={styles.swap}>
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.strong key={summary} className={styles.selectionValue} {...swap} transition={swapTransition}>{summary}</motion.strong>
            </AnimatePresence>
          </span>
        </div>
        <Button variant={confirmed ? "secondary" : "primary"} onClick={confirmed ? undefined : confirm} aria-disabled={confirmed || undefined} className={styles.confirmButton}>
          <span className={styles.swap}>
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span key={confirmed ? "done" : "idle"} className={styles.buttonLabel} {...swap} transition={swapTransition}>
                {confirmed ? <><Check size={16} aria-hidden="true" />Confirmed</> : "Confirm time"}
              </motion.span>
            </AnimatePresence>
          </span>
        </Button>
        <p className={styles.srOnly} aria-live="polite">{confirmed ? `Confirmed ${summary}.` : ""}</p>
      </footer>
    </div>
  </section>;
}

export default AvailabilityPicker;
