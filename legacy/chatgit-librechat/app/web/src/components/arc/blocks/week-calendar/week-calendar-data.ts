import { people, type PersonId } from "../../lib/media";
import { DAY, dateDay, fromWall } from "./calendar-time";

export interface CalendarAttendee {
  name: string;
  /** Portrait URL. Initials show when it is missing. */
  avatar?: string;
}

export interface CalendarEvent {
  id: string;
  title: string;
  start: Date;
  /** Exclusive. For an all day event this is midnight after the last day. */
  end: Date;
  calendarId: string;
  allDay?: boolean;
  location?: string;
  attendees?: CalendarAttendee[];
}

/** Built in hues tuned for light and dark; any CSS color works too. */
export type CalendarColor = "blue" | "green" | "violet" | "amber" | "rose" | "teal" | (string & {});

export interface CalendarSource {
  id: string;
  name: string;
  color: CalendarColor;
  /** Start hidden. People can still turn it on from the calendar list. */
  hidden?: boolean;
}

export const SAMPLE_CALENDARS: CalendarSource[] = [
  { id: "work", name: "Work", color: "blue" },
  { id: "meetings", name: "Team", color: "violet" },
  { id: "personal", name: "Personal", color: "green" },
  { id: "travel", name: "Travel", color: "amber" },
];

/** The sample week starts on Monday 21 September 2026. */
export const SAMPLE_WEEK = dateDay(2026, 9, 21);
export const SAMPLE_DATE = new Date(Date.UTC(2026, 8, 24, 12));

/** Portraits from public/media/people, see public/media/CREDITS.md. Names are sample content. */
const who = (...ids: PersonId[]): CalendarAttendee[] => ids.map(id => { const person = people.find(entry => entry.id === id)!; return { name: person.name, avatar: person.src }; });
const TEAM = who("marcus-johnson", "sofia-ramirez", "chloe-nguyen", "daniel-kim", "emma-collins");

type Seed = [day: number, start: string, end: string, title: string, calendarId: string, location?: string, attendees?: CalendarAttendee[]];
type AllDaySeed = [from: number, to: number, title: string, calendarId: string, location?: string];

const minutes = (time: string) => { const [h, m] = time.split(":").map(Number); return h * 60 + m; };

/** Monday is day 0. Times are wall clock times in the calendar's zone. */
const WEEK: Seed[] = [
  [0, "9:00", "9:15", "Team standup", "meetings", "Video call", TEAM],
  [0, "9:30", "11:30", "Focus: Q4 planning doc", "work"],
  [0, "12:00", "13:00", "Lunch with Sofia", "personal", "Tartine Manufactory", who("sofia-ramirez")],
  [0, "13:30", "14:00", "1:1 with Marcus", "meetings", "Marcus's desk", who("marcus-johnson")],
  [0, "14:00", "15:00", "Pricing sync", "work", "Juniper room", who("ava-mitchell", "tyler-hayes", "andre-williams")],
  [0, "14:00", "14:30", "Quick sync with Daniel", "meetings", "Video call", who("daniel-kim")],
  [0, "14:30", "15:15", "Hiring debrief", "meetings", "Atlas room", who("nathan-cole", "olivia-bennett")],
  [0, "18:00", "19:00", "Climbing gym", "personal", "Mission Cliffs"],
  [1, "9:00", "9:15", "Team standup", "meetings", "Video call", TEAM],
  [1, "10:00", "11:30", "Design review: onboarding", "work", "Atlas room, 4th floor", who("jasmine-brooks", "emma-collins", "chloe-nguyen", "marcus-johnson")],
  [1, "11:00", "11:30", "Portfolio chat with Mateo", "meetings", "Video call", who("mateo-alvarez")],
  [1, "13:00", "15:00", "Focus: prototype the new editor", "work"],
  [1, "15:00", "15:45", "Customer call: Northwind", "work", "Video call", who("hannah-walsh", "ryan-sullivan")],
  [1, "17:00", "17:45", "Dentist", "personal", "Valencia Dental"],
  [2, "8:00", "8:30", "Pack for New York", "personal"],
  [2, "9:00", "9:15", "Team standup", "meetings", "Video call", TEAM],
  [2, "9:30", "10:30", "Sprint planning", "meetings", "Juniper room", who("daniel-kim", "olivia-bennett", "marcus-johnson")],
  [2, "10:30", "11:30", "Roadmap review", "work", "Atlas room", who("diane-foster", "nathan-cole")],
  [2, "11:00", "12:00", "Interview: staff engineer", "meetings", "Juniper room", who("olivia-bennett")],
  [2, "12:30", "18:05", "Flight UA 1542 to New York", "travel", "SFO Terminal 3, gate F12"],
  [3, "9:00", "9:15", "Team standup", "meetings", "Video call", TEAM],
  [3, "9:30", "12:00", "Offsite: strategy session", "work", "Brooklyn Navy Yard", who("diane-foster", "nathan-cole", "jasmine-brooks", "tyler-hayes")],
  [3, "12:00", "13:00", "Lunch with the leadership team", "personal", "Olmsted"],
  [3, "13:00", "16:30", "Offsite: team workshops", "work", "Brooklyn Navy Yard", who("diane-foster", "sofia-ramirez", "andre-williams")],
  [3, "16:30", "17:00", "1:1 with Nathan", "meetings", "Walk along the pier", who("nathan-cole")],
  [3, "19:00", "21:00", "Dinner at Lilia", "personal", "567 Union Ave", who("jasmine-brooks", "tyler-hayes")],
  [4, "9:00", "9:15", "Team standup", "meetings", "Video call", TEAM],
  [4, "10:00", "12:00", "Offsite: wrap up and next steps", "work", "Brooklyn Navy Yard", who("diane-foster", "nathan-cole")],
  [4, "13:00", "13:30", "Metrics review", "work", "Video call", who("chloe-nguyen")],
  [4, "15:00", "21:30", "Flight UA 2210 to San Francisco", "travel", "JFK Terminal 7"],
  [5, "8:00", "9:00", "Long run, Golden Gate Park", "personal"],
  [5, "9:30", "11:00", "Farmers market", "personal", "Ferry Building"],
  [6, "11:00", "12:30", "Brunch with Emma", "personal", "Zazie, Cole Valley", who("emma-collins")],
  [6, "17:00", "17:30", "Plan the week", "work"],
];

const WEEK_ALL_DAY: AllDaySeed[] = [
  [2, 4, "Hotel: The Wythe", "travel", "80 Wythe Ave, Brooklyn"],
  [3, 4, "Leadership offsite", "work", "Brooklyn Navy Yard"],
  [3, 3, "Mom's birthday", "personal"],
];

/** A repeating shape for the weeks around the sample week, picked by a seeded random so each week looks lived in and stays the same on every visit. */
const ROTATION: [start: string, end: string, title: string, calendarId: string, location?: string, attendees?: CalendarAttendee[]][] = [
  ["10:00", "11:00", "Product review", "work", "Atlas room", who("sofia-ramirez", "daniel-kim")],
  ["11:30", "12:00", "1:1 with Chloe", "meetings", "Video call", who("chloe-nguyen")],
  ["13:00", "15:00", "Focus: deep work", "work"],
  ["14:00", "14:45", "Partner sync", "meetings", "Video call", who("jordan-reyes")],
  ["15:30", "16:30", "Research readout", "work", "Juniper room", who("emma-collins", "olivia-bennett")],
  ["12:00", "13:00", "Lunch with Daniel", "personal", "Souvla, Hayes Valley", who("daniel-kim")],
  ["9:30", "10:30", "Roadmap grooming", "meetings", "Juniper room", who("marcus-johnson", "sofia-ramirez")],
  ["18:00", "19:00", "Pilates", "personal", "Mission studio"],
  ["10:30", "12:00", "Spec writing", "work"],
  ["14:30", "15:30", "Interview: product designer", "meetings", "Juniper room", who("olivia-bennett")],
];

function random(seed: number) {
  let t = seed + 0x6d2b79f5;
  return () => { t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function seedsForWeek(week: number): { timed: Seed[]; allDay: AllDaySeed[] } {
  if (week === SAMPLE_WEEK) return { timed: WEEK, allDay: WEEK_ALL_DAY };
  const next = random(week);
  const timed: Seed[] = [0, 1, 2, 3, 4].map(day => [day, "9:00", "9:15", "Team standup", "meetings", "Video call", TEAM]);
  for (let day = 0; day < 5; day++) {
    const used = new Set<number>();
    for (let n = 1 + Math.floor(next() * 3); n > 0; n--) {
      const pick = Math.floor(next() * ROTATION.length);
      if (used.has(pick)) continue;
      used.add(pick);
      timed.push([day, ...ROTATION[pick]]);
    }
  }
  if (next() > .4) timed.push([5, "9:30", "11:00", "Farmers market", "personal", "Ferry Building"]);
  if (next() > .5) timed.push([6, "9:00", "10:30", "Long run", "personal", "Golden Gate Park"]);
  return { timed, allDay: next() > .6 ? [[Math.floor(next() * 5), 0, "Company holiday", "work"]] : [] };
}

/**
 * Sample events for the weeks around 21 September 2026, as wall clock times in `timeZone` (the browser's zone when
 * omitted). Replace this with your own events.
 */
export function sampleEvents(timeZone?: string, weeksAround = 4): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  for (let offset = -weeksAround; offset <= weeksAround; offset++) {
    const week = SAMPLE_WEEK + offset * 7;
    const { timed, allDay } = seedsForWeek(week);
    timed.forEach(([day, start, end, title, calendarId, location, attendees], i) => events.push({
      id: `w${week}-${i}`, title, calendarId, location, attendees,
      start: fromWall((week + day) * DAY + minutes(start), timeZone),
      end: fromWall((week + day) * DAY + minutes(end), timeZone),
    }));
    allDay.forEach(([from, to, title, calendarId, location], i) => events.push({
      id: `w${week}-a${i}`, title, calendarId, location, allDay: true,
      start: fromWall((week + from) * DAY, timeZone),
      end: fromWall((week + Math.max(from, to) + 1) * DAY, timeZone),
    }));
  }
  return events;
}
