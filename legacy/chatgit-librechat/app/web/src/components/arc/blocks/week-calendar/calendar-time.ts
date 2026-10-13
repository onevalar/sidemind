/**
 * Time math for the week calendar. The grid works in wall clock minutes of one time zone: whole minutes since
 * 1 January 1970 as a clock on the wall in that zone reads them. A wall day is `Math.floor(wall / 1440)`, so the
 * server, the browser and every zone agree on which column an event sits in. Intl does the zone conversion.
 */

export const DAY = 1440;
export type Wall = number;

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();
function zoneFormatter(timeZone?: string) {
  const key = timeZone ?? "";
  let formatter = zoneFormatters.get(key);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" });
    } catch {
      // An unknown zone name falls back to the browser's zone instead of throwing during render.
      formatter = new Intl.DateTimeFormat("en-US", { hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" });
    }
    zoneFormatters.set(key, formatter);
  }
  return formatter;
}

/** An instant as wall clock minutes in `timeZone` (the browser's zone when omitted). */
export function toWall(date: Date, timeZone?: string): Wall {
  let year = 1970, month = 1, day = 1, hour = 0, minute = 0;
  for (const part of zoneFormatter(timeZone).formatToParts(date)) {
    if (part.type === "year") year = +part.value;
    else if (part.type === "month") month = +part.value;
    else if (part.type === "day") day = +part.value;
    else if (part.type === "hour") hour = +part.value % 24;
    else if (part.type === "minute") minute = +part.value;
  }
  return Math.round(Date.UTC(year, month - 1, day, hour, minute) / 60000);
}

/** Wall clock minutes in `timeZone` back to an instant. Two passes settle daylight saving offsets. */
export function fromWall(wall: Wall, timeZone?: string): Date {
  let time = wall * 60000;
  for (let pass = 0; pass < 2; pass++) {
    const drift = toWall(new Date(time), timeZone) - wall;
    if (!drift) break;
    time -= drift * 60000;
  }
  return new Date(time);
}

export const dayOf = (wall: Wall) => Math.floor(wall / DAY);
export const minuteOf = (wall: Wall) => ((wall % DAY) + DAY) % DAY;
/** 0 is Sunday. Day zero, 1 January 1970, was a Thursday. */
export const weekdayOf = (day: number) => ((day + 4) % 7 + 7) % 7;
export const startOfWeek = (day: number, weekStartsOn: number) => day - (weekdayOf(day) - weekStartsOn + 7) % 7;
export const isWeekend = (day: number) => { const weekday = weekdayOf(day); return weekday === 0 || weekday === 6; };
/** Wall day for a calendar date, for writing sample data. */
export const dateDay = (year: number, month: number, date: number) => Math.round(Date.UTC(year, month - 1, date) / 86400000);

/** Formatting for wall values. Every formatter reads a wall value as UTC, so no zone shifts it twice. */
export function createFormat(locale = "en-US") {
  const make = (options: Intl.DateTimeFormatOptions) => { try { return new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }); } catch { return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }); } };
  const clock = make({ hour: "numeric", minute: "2-digit" });
  const hourOnly = make({ hour: "numeric" });
  const weekdayShort = make({ weekday: "short" });
  const weekdayNarrow = make({ weekday: "narrow" });
  const weekdayLong = make({ weekday: "long" });
  const dateNumber = make({ day: "numeric" });
  const monthDay = make({ month: "short", day: "numeric" });
  const longDate = make({ weekday: "long", month: "long", day: "numeric" });
  const shortDate = make({ weekday: "short", month: "short", day: "numeric" });
  const fullDate = make({ weekday: "long", month: "short", day: "numeric", year: "numeric" });
  const rangeDate = make({ month: "short", day: "numeric", year: "numeric" });
  const monthYear = make({ month: "long", year: "numeric" });
  const english = locale.toLowerCase().startsWith("en");
  const at = (wall: Wall) => new Date(wall * 60000);
  const atDay = (day: number) => new Date(day * 86400000);

  /** The parts of a clock time; a 12 hour clock drops ":00" and, when asked, the day period. */
  const clockParts = (wall: Wall, period: boolean) => {
    const parts = clock.formatToParts(at(wall));
    const twelve = parts.some(part => part.type === "dayPeriod");
    const onHour = minuteOf(wall) % 60 === 0;
    let text = "";
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i], next = parts[i + 1];
      if (twelve && onHour && (part.type === "minute" || (part.type === "literal" && next?.type === "minute"))) continue;
      if (!period && (part.type === "dayPeriod" || (part.type === "literal" && next?.type === "dayPeriod"))) continue;
      text += part.value;
    }
    return { text: text.replace(/\u202f/g, " ").trim(), twelve, period: parts.find(part => part.type === "dayPeriod")?.value };
  };

  const time = (wall: Wall) => clockParts(wall, true).text;
  /** Without the day period, for tight spaces: "3:41". */
  const short = (wall: Wall) => clockParts(wall, false).text;
  /** "9 – 10:30 AM", or "11 AM – 12:30 PM" when the period changes. */
  const range = (start: Wall, end: Wall) => {
    const a = clockParts(start, true), b = clockParts(end, true);
    const shared = a.twelve && a.period === b.period && dayOf(start) === dayOf(end);
    return `${shared ? clockParts(start, false).text : a.text} – ${b.text}`;
  };
  /** Screen reader wording: "10:00 AM to 11:30 AM". */
  const spoken = (start: Wall, end: Wall) => `${clock.format(at(start))} to ${clock.format(at(end))}`.replace(/\u202f/g, " ");
  const hour = (minutes: number) => hourOnly.format(at(minutes)).replace(/\u202f/g, " ");
  const length = (minutes: number) => {
    const h = Math.floor(minutes / 60), m = minutes % 60;
    return h && m ? `${h} hr ${m} min` : h ? `${h} hr` : `${m} min`;
  };
  /** "Sep 21 to 27, 2026" for a range of days. */
  const dayRange = (first: number, last: number) => {
    if (first === last) return fullDate.format(atDay(first));
    const formatter = rangeDate as Intl.DateTimeFormat & { formatRangeToParts?: (a: Date, b: Date) => { type: string; value: string; source: string }[] };
    if (!formatter.formatRangeToParts) return `${rangeDate.format(atDay(first))} to ${rangeDate.format(atDay(last))}`;
    return formatter.formatRangeToParts(atDay(first), atDay(last))
      .map(part => english && part.source === "shared" && part.type === "literal" && /[\u2013\u2014-]/.test(part.value) ? " to " : part.value)
      .join("").replace(/\s+/g, " ").trim();
  };

  return {
    time, short, range, spoken, hour, length, dayRange,
    weekdayShort: (day: number) => weekdayShort.format(atDay(day)),
    weekdayNarrow: (day: number) => weekdayNarrow.format(atDay(day)),
    weekdayLong: (day: number) => weekdayLong.format(atDay(day)),
    date: (day: number) => dateNumber.format(atDay(day)),
    monthDay: (day: number) => monthDay.format(atDay(day)),
    longDate: (day: number) => longDate.format(atDay(day)),
    shortDate: (day: number) => shortDate.format(atDay(day)),
    monthYear: (day: number) => monthYear.format(atDay(day)),
    /** yyyy-mm-dd for a date input. */
    iso: (day: number) => atDay(day).toISOString().slice(0, 10),
    fromIso: (value: string) => { const [y, m, d] = value.split("-").map(Number); return y && m && d ? dateDay(y, m, d) : null; },
  };
}
export type CalendarFormat = ReturnType<typeof createFormat>;

/** A short zone label for the gutter, such as "GMT-7" or "PDT". */
export function zoneLabel(timeZone: string | undefined, locale = "en-US") {
  try {
    const parts = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: "short" }).formatToParts(new Date());
    return parts.find(part => part.type === "timeZoneName")?.value ?? "";
  } catch { return ""; }
}

type Span = { id: string; start: Wall; end: Wall };
export type Placement = { column: number; span: number; columns: number };

/**
 * Side by side layout for one day, like Google Calendar: overlapping events form a cluster, each takes the first free
 * column, then stretches right across columns that stay free for its whole time. `minLength` keeps very short
 * events from sharing a visual line with the next one.
 */
export function layoutDay(spans: Span[], minLength = 20): Map<string, Placement> {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end || a.id.localeCompare(b.id));
  const result = new Map<string, Placement>();
  const visualEnd = (span: Span) => Math.max(span.end, span.start + minLength);
  let cluster: Span[] = [], columns: Span[][] = [], clusterEnd = -Infinity;
  const flush = () => {
    const count = columns.length;
    for (const span of cluster) {
      const placed = result.get(span.id)!;
      let width = 1;
      for (let c = placed.column + 1; c < count; c++) {
        if (columns[c].some(other => other.start < visualEnd(span) && visualEnd(other) > span.start)) break;
        width++;
      }
      placed.span = width;
      placed.columns = count;
    }
    cluster = []; columns = [];
  };
  for (const span of sorted) {
    if (span.start >= clusterEnd) { flush(); clusterEnd = -Infinity; }
    let column = columns.findIndex(list => visualEnd(list[list.length - 1]) <= span.start);
    if (column === -1) { column = columns.length; columns.push([span]); } else columns[column].push(span);
    result.set(span.id, { column, span: 1, columns: 1 });
    cluster.push(span);
    clusterEnd = Math.max(clusterEnd, visualEnd(span));
  }
  flush();
  return result;
}

/** Lanes for all day bars: each bar takes the first lane free across all of its days. */
export function layoutLanes(bars: { id: string; from: number; to: number }[]) {
  const sorted = [...bars].sort((a, b) => a.from - b.from || (b.to - b.from) - (a.to - a.from) || a.id.localeCompare(b.id));
  const lanes: number[] = [];
  const result = new Map<string, number>();
  for (const bar of sorted) {
    let lane = lanes.findIndex(end => end < bar.from);
    if (lane === -1) { lane = lanes.length; lanes.push(bar.to); } else lanes[lane] = bar.to;
    result.set(bar.id, lane);
  }
  return { lanes: result, count: lanes.length };
}
