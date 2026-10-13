/** Pure helpers for the data grid: formatting, parsing, filtering, sorting, clipboard, and CSV. No React in here. */

export type DataGridValue = string | number | null;
export type DataGridRow = { id: string; [key: string]: DataGridValue };
export type DataGridColumnType = "text" | "number" | "currency" | "percent" | "select" | "date";
export type DataGridAggregate = "sum" | "average" | "min" | "max" | "count" | "none";

export interface DataGridColumn {
  key: string;
  label: string;
  /** Starting width in px. Defaults to 140. */
  width?: number;
  /** Narrowest width a resize can reach. Defaults to 72. */
  minWidth?: number;
  /**
   * Number, currency, and percent columns align right, parse typed numbers, and total in the footer. Select columns pick from `options`.
   * Date columns store an ISO day string such as "2026-01-31", show it formatted, and edit with a calendar.
   */
  type?: DataGridColumnType;
  /** How a date column shows its days. Defaults to `{ month: "short", day: "numeric", year: "numeric" }`, so "Jan 31, 2026". */
  dateFormat?: Intl.DateTimeFormatOptions;
  decimals?: number;
  /** Defaults to true. */
  editable?: boolean;
  /** Choices for a select column. Defaults to the distinct values already in the column. */
  options?: string[];
  /** Starts pinned to the left edge. When no column sets this, the first column is pinned. */
  pinned?: boolean;
  /** Starts hidden. People can show it again from the columns menu. */
  hidden?: boolean;
  /** What the sticky footer shows for this column. Defaults to sum for number and currency, average for percent, and none otherwise. */
  aggregate?: DataGridAggregate;
  /** Defaults to true. */
  sortable?: boolean;
  /** Defaults to true. */
  filterable?: boolean;
  /** Offers "Group by" in the header menu. Defaults to true for text, select, and date columns and false for numeric ones. */
  groupable?: boolean;
}

export type DataGridSort = { key: string; dir: "asc" | "desc" };
/** Text and number columns take a query string; select columns take the list of values to keep. */
export type DataGridFilters = Record<string, string | string[]>;
export type DataGridDensity = "compact" | "standard" | "comfortable";

export const isNumeric = (column: DataGridColumn) => column.type === "number" || column.type === "currency" || column.type === "percent";
export const isDate = (column: DataGridColumn) => column.type === "date";
/** The value an emptied cell stores: null for number and date columns, an empty string otherwise. */
export const emptyValue = (column: DataGridColumn): DataGridValue => isNumeric(column) || isDate(column) ? null : "";
export { clamp } from "../lib/clamp";

/** Spreadsheet column letters: A … Z, AA, AB … */
export function letter(index: number) {
  let n = index + 1, out = "";
  while (n > 0) { const m = (n - 1) % 26; out = String.fromCharCode(65 + m) + out; n = Math.floor((n - 1) / 26); }
  return out;
}

/* Dates. A day is an ISO string, "2026-01-31", read and written in UTC so it never shifts with the reader's time zone. */

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DEFAULT_DATE_FORMAT: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" };
const dateFormatters = new Map<string, Intl.DateTimeFormat>();

function isoDay(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day) || year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) return null;
  if (day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** True for a real calendar day written as YYYY-MM-DD. */
export const isIsoDay = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && isoDay(+value.slice(0, 4), +value.slice(5, 7), +value.slice(8, 10)) === value;

/**
 * Reads a typed or pasted day: ISO ("2026-01-31", "2026/1/31") or a form with a month name ("Jan 31, 2026", "31 January 2026").
 * All-number forms like 01/02/2026 are refused, because they read differently in different countries. Returns null when unreadable.
 */
export function parseDay(text: string): string | null {
  const t = text.trim().toLowerCase().replace(/,/g, " ").replace(/\s+/g, " ");
  let m = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return isoDay(+m[1]!, +m[2]!, +m[3]!);
  const month = (name: string) => { const i = MONTHS.indexOf(name.slice(0, 3)); return i >= 0 && (name.length === 3 || name.startsWith(MONTHS[i]!)) ? i + 1 : 0; };
  m = t.match(/^([a-z]+)\.? (\d{1,2}) (\d{4})$/);
  if (m) return isoDay(+m[3]!, month(m[1]!), +m[2]!);
  m = t.match(/^(\d{1,2}) ([a-z]+)\.? (\d{4})$/);
  if (m) return isoDay(+m[3]!, month(m[2]!), +m[1]!);
  return null;
}

/** Whole days between two ISO days, or months when both fall on the same day of the month. Used by the fill series. */
const dayNumber = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 864e5;
const fromDayNumber = (n: number) => new Date(n * 864e5).toISOString().slice(0, 10);
const monthNumber = (iso: string) => +iso.slice(0, 4) * 12 + +iso.slice(5, 7) - 1;
/** A month step keeps the day, clamped to shorter months: Jan 31 plus one month is Feb 28. */
const fromMonthNumber = (n: number, day: number) => { const y = Math.floor(n / 12), mo = n - y * 12 + 1; return isoDay(y, mo, Math.min(day, new Date(Date.UTC(y, mo, 0)).getUTCDate())); };

export function formatDay(iso: string, options: Intl.DateTimeFormatOptions = DEFAULT_DATE_FORMAT) {
  if (!isIsoDay(iso)) return iso;
  const key = JSON.stringify(options);
  let formatter = dateFormatters.get(key);
  if (!formatter) { formatter = new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }); dateFormatters.set(key, formatter); }
  return formatter.format(new Date(dayNumber(iso) * 864e5));
}

export function format(value: DataGridValue | undefined, column: DataGridColumn) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "string" && isDate(column)) return formatDay(value, column.dateFormat);
  if (typeof value !== "number") return value;
  const decimals = column.decimals ?? 0;
  const text = Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  const sign = value < 0 ? "−" : "";
  return column.type === "currency" ? `${sign}$${text}` : column.type === "percent" ? `${sign}${text}%` : `${sign}${text}`;
}

const cleanNumber = (text: string) => text.trim().replace(/[$,%\s]/g, "").replace(/−/g, "-").replace(/^\((.*)\)$/, "-$1");

/**
 * Reads typed or pasted text for a column. Numbers accept $, %, commas, spaces, and accounting parentheses; an empty number cell stores null.
 * Dates accept the forms `parseDay` reads and store an ISO day; an empty date cell stores null.
 */
export function parse(text: string, column: DataGridColumn, options?: string[]): { ok: true; value: DataGridValue } | { ok: false } {
  const trimmed = text.trim();
  if (isDate(column)) {
    if (trimmed === "") return { ok: true, value: null };
    const day = parseDay(trimmed);
    return day ? { ok: true, value: day } : { ok: false };
  }
  if (column.type === "select") {
    if (trimmed === "") return { ok: true, value: "" };
    const match = options?.find(option => option.toLowerCase() === trimmed.toLowerCase());
    return match !== undefined ? { ok: true, value: match } : options?.length ? { ok: false } : { ok: true, value: trimmed };
  }
  if (!isNumeric(column)) return { ok: true, value: trimmed };
  const cleaned = cleanNumber(trimmed);
  if (cleaned === "") return { ok: true, value: null };
  const value = Number(cleaned);
  return Number.isFinite(value) ? { ok: true, value } : { ok: false };
}

/**
 * Values to write when the fill handle drags a run of cells onward. An evenly spaced run of numbers continues its series; anything else repeats.
 * In a date column an evenly spaced run of days continues by days, or by months when every day falls on the same day of the month.
 */
export function extend(source: DataGridValue[], count: number, forward: boolean, type?: DataGridColumnType): DataGridValue[] {
  if (type === "date" && source.length > 1 && source.every(isIsoDay)) {
    const days = source as string[];
    // Month ends (Jan 31, Feb 28, Mar 31) count as one day of the month, so period ends continue as period ends.
    const monthEnd = days.every(d => fromDayNumber(dayNumber(d) + 1).slice(8) === "01");
    const sameDay = monthEnd || days.every(d => d.slice(8) === days[0]!.slice(8));
    const step = sameDay ? monthNumber(days[1]!) - monthNumber(days[0]!) : dayNumber(days[1]!) - dayNumber(days[0]!);
    const at = (d: string) => sameDay ? monthNumber(d) : dayNumber(d);
    if (step && days.every((d, i) => i === 0 || at(d) - at(days[i - 1]!) === step)) {
      const edge = forward ? days[days.length - 1]! : days[0]!, day = monthEnd ? 31 : +edge.slice(8);
      return Array.from({ length: count }, (_, k) => {
        const n = at(edge) + (forward ? 1 : -1) * step * (k + 1);
        return sameDay ? fromMonthNumber(n, day) : n >= dayNumber("0001-01-01") && n <= dayNumber("9999-12-31") ? fromDayNumber(n) : null;
      });
    }
  }
  const numbers = source.every(v => typeof v === "number") ? (source as number[]) : null;
  const step = numbers && numbers.length > 1 ? numbers[1] - numbers[0] : null;
  const series = numbers && step !== null && numbers.every((v, i) => i === 0 || Math.abs(v - numbers[i - 1] - step) < 1e-9);
  return Array.from({ length: count }, (_, k) => {
    if (series && numbers && step !== null) {
      const next = forward ? numbers[numbers.length - 1] + step * (k + 1) : numbers[0] - step * (k + 1);
      return Math.round(next * 1e6) / 1e6;
    }
    return forward ? source[k % source.length] : source[source.length - 1 - (k % source.length)];
  });
}

/* Filtering */

const fold = (text: string) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

type NumberTest = (value: number) => boolean;
/** Number filter syntax: `>100`, `>=100`, `<5`, `!=0`, `=12`, `12`, or a range `10..50`. Returns null when blank and "invalid" when unreadable. */
export function numberFilter(expression: string): NumberTest | null | "invalid" {
  const text = cleanNumber(expression);
  if (!text) return null;
  const num = "(-?\\d*\\.?\\d+)";
  const between = text.match(new RegExp(`^${num}(?:\\.\\.|to|–|—)${num}$`));
  if (between) { const [a, b] = [Number(between[1]), Number(between[2])].sort((x, y) => x - y); return v => v >= a && v <= b; }
  const compare = text.match(new RegExp(`^(>=|<=|!=|<>|>|<|=)?${num}$`));
  if (!compare) return "invalid";
  const n = Number(compare[2]);
  switch (compare[1]) {
    case ">": return v => v > n;
    case ">=": return v => v >= n;
    case "<": return v => v < n;
    case "<=": return v => v <= n;
    case "!=": case "<>": return v => v !== n;
    default: return v => v === n;
  }
}

/**
 * Date filter syntax, read like the number filter: `2026-01-31`, `>2026-01-31`, `<=Mar 1 2026`, `!=2026-01-31`, or a range `2026-01-01..2026-03-31`.
 * A year (`2026`) or a month (`2026-03`) stands for every day in it, so `2026-03` keeps March and `>2026` keeps 2027 onward.
 * Returns null when blank and "invalid" when unreadable.
 */
export function dateFilter(expression: string): ((iso: string) => boolean) | null | "invalid" {
  const text = expression.trim();
  if (!text) return null;
  const span = (part: string): [string, string] | null => {
    const p = part.trim();
    if (/^\d{4}$/.test(p)) return [`${p}-01-01`, `${p}-12-31`];
    const month = p.match(/^(\d{4})[-/](\d{1,2})$/);
    if (month) { const first = isoDay(+month[1]!, +month[2]!, 1); return first ? [first, fromDayNumber(dayNumber(fromMonthNumber(monthNumber(first) + 1, 1)!) - 1)] : null; }
    const day = parseDay(p);
    return day ? [day, day] : null;
  };
  const between = text.split(/\s*(?:\.\.|–|—)\s*|\s+to\s+/i);
  if (between.length === 2) {
    const a = span(between[0]!), b = span(between[1]!);
    if (!a || !b) return "invalid";
    const [lo, hi] = a[0] <= b[0] ? [a[0], b[1]] : [b[0], a[1]];
    return v => v >= lo && v <= hi;
  }
  const compare = text.match(/^(>=|<=|!=|<>|>|<|=)?\s*(.+)$/);
  const range = compare ? span(compare[2]!) : null;
  if (!compare || !range) return "invalid";
  const [lo, hi] = range;
  switch (compare[1]) {
    case ">": return v => v > hi;
    case ">=": return v => v >= lo;
    case "<": return v => v < lo;
    case "<=": return v => v <= hi;
    case "!=": case "<>": return v => v < lo || v > hi;
    default: return v => v >= lo && v <= hi;
  }
}

/** Builds one predicate for every active filter plus the quick search. Invalid number expressions are ignored. */
export function rowMatcher(columns: DataGridColumn[], filters: DataGridFilters, search: string, searchColumns: DataGridColumn[] = columns): ((row: DataGridRow) => boolean) | null {
  const tests: ((row: DataGridRow) => boolean)[] = [];
  for (const column of columns) {
    const filter = filters[column.key];
    if (filter === undefined) continue;
    if (Array.isArray(filter)) {
      const keep = new Set(filter);
      tests.push(row => keep.has(String(row[column.key] ?? "")));
    } else if (isNumeric(column)) {
      const test = numberFilter(filter);
      if (typeof test === "function") tests.push(row => { const v = row[column.key]; return typeof v === "number" && test(v); });
    } else if (isDate(column)) {
      const test = dateFilter(filter);
      if (typeof test === "function") tests.push(row => { const v = row[column.key]; return isIsoDay(v) && test(v); });
    } else if (filter.trim()) {
      const raw = filter.trim(), negate = raw.startsWith("!"), exact = raw.startsWith("=");
      const query = fold(negate || exact ? raw.slice(1) : raw);
      if (query) tests.push(row => {
        const v = fold(String(row[column.key] ?? ""));
        const hit = exact ? v === query : v.includes(query);
        return negate ? !hit : hit;
      });
    }
  }
  const tokens = fold(search).split(/\s+/).filter(Boolean);
  if (tokens.length) tests.push(row => {
    const haystack = searchColumns.map(column => fold(format(row[column.key], column) + " " + String(row[column.key] ?? ""))).join(" ");
    return tokens.every(token => haystack.includes(token));
  });
  if (!tests.length) return null;
  return row => tests.every(test => test(row));
}

export function isFilterActive(column: DataGridColumn, value: string | string[] | undefined) {
  if (value === undefined) return false;
  if (Array.isArray(value)) return true;
  return isNumeric(column) ? typeof numberFilter(value) === "function" : isDate(column) ? typeof dateFilter(value) === "function" : value.trim() !== "";
}

/* Sorting */

const empty = (v: DataGridValue | undefined) => v === null || v === undefined || v === "";
const collator = new Intl.Collator("en-US", { numeric: true, sensitivity: "base" });

/** Stable multi-column sort. Empty cells always sink to the bottom, whichever way the column sorts. */
export function sortRows(rows: DataGridRow[], sort: DataGridSort[], columns: DataGridColumn[]) {
  const keys = sort.filter(s => columns.some(c => c.key === s.key));
  if (!keys.length) return rows;
  const options = new Map(columns.map(c => [c.key, c.type === "select" && c.options ? new Map(c.options.map((o, i) => [o, i])) : null]));
  return rows.map((row, index) => ({ row, index })).sort((a, b) => {
    for (const { key, dir } of keys) {
      const x = a.row[key], y = b.row[key];
      if (empty(x) || empty(y)) { if (empty(x) && empty(y)) continue; return empty(x) ? 1 : -1; }
      const order = options.get(key);
      const diff = order && order.has(String(x)) && order.has(String(y)) ? order.get(String(x))! - order.get(String(y))!
        : typeof x === "number" && typeof y === "number" ? x - y : collator.compare(String(x), String(y));
      if (diff) return dir === "asc" ? diff : -diff;
    }
    return a.index - b.index;
  }).map(entry => entry.row);
}

/* Aggregates */

export function defaultAggregate(column: DataGridColumn): DataGridAggregate {
  if (column.aggregate) return column.aggregate;
  return column.type === "percent" ? "average" : isNumeric(column) ? "sum" : "none";
}

export function aggregate(rows: DataGridRow[], column: DataGridColumn, kind: DataGridAggregate): number | null {
  if (kind === "none") return null;
  let sum = 0, count = 0, min = Infinity, max = -Infinity, filled = 0;
  for (const row of rows) {
    const v = row[column.key];
    if (!empty(v)) filled++;
    if (typeof v !== "number") continue;
    sum += v; count++;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (kind === "count") return filled;
  if (!count) return null;
  return kind === "sum" ? sum : kind === "average" ? sum / count : kind === "min" ? min : max;
}

/** Splits a large number into a short value and a unit so a footer total fits a narrow column: 1,512,300 → 1.5 + "M". */
export function compact(value: number): { value: number; unit: string; decimals: number } {
  const abs = Math.abs(value);
  if (abs >= 1e9) return { value: Math.round(value / 1e8) / 10, unit: "B", decimals: 1 };
  if (abs >= 1e6) return { value: Math.round(value / 1e5) / 10, unit: "M", decimals: 1 };
  if (abs >= 1e5) return { value: Math.round(value / 1e3), unit: "K", decimals: 0 };
  return { value: Math.round(value * 10) / 10, unit: "", decimals: Number.isInteger(Math.round(value * 10) / 10) ? 0 : 1 };
}

/* Clipboard and CSV */

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Tab separated text the way Excel and Sheets write it: a cell with a tab, newline, or quote is quoted. */
export function toTsv(matrix: string[][]) {
  return matrix.map(line => line.map(cell => /[\t\n"]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell).join("\t")).join("\n");
}

/** An HTML table for rich paste targets. Sheets and Excel read display text here, so "$86,400" and "82%" arrive as typed numbers. */
export function toHtml(matrix: string[][]) {
  const body = matrix.map(line => `<tr>${line.map(cell => `<td>${escapeHtml(cell).replace(/\n/g, "<br>")}</td>`).join("")}</tr>`).join("");
  return `<meta charset="utf-8"><table><tbody>${body}</tbody></table>`;
}

/** Parses tab separated clipboard text, honoring quoted cells that contain tabs or line breaks. */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false, i = 0;
  const source = text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
  while (i < source.length) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') { cell += '"'; i += 2; continue; }
      if (ch === '"') { quoted = false; i++; continue; }
      cell += ch; i++; continue;
    }
    if (ch === '"' && cell === "") { quoted = true; i++; continue; }
    if (ch === "\t") { row.push(cell); cell = ""; i++; continue; }
    if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; i++; continue; }
    cell += ch; i++;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

/** Reads the first table in clipboard HTML from Excel, Sheets, Numbers, or a web page. Returns null when there is no table. */
export function parseHtmlTable(html: string): string[][] | null {
  if (typeof DOMParser === "undefined" || !/<table/i.test(html)) return null;
  const table = new DOMParser().parseFromString(html, "text/html").querySelector("table");
  if (!table) return null;
  const rows: string[][] = [];
  table.querySelectorAll("tr").forEach(tr => {
    const line: string[] = [];
    tr.querySelectorAll("td, th").forEach(cell => {
      cell.querySelectorAll("br").forEach(br => br.replaceWith("\n"));
      line.push((cell.textContent ?? "").replace(/\u00a0/g, " ").trim());
      const span = Number(cell.getAttribute("colspan") ?? 1);
      for (let k = 1; k < span; k++) line.push("");
    });
    rows.push(line);
  });
  return rows.length ? rows : null;
}

/** RFC 4180 CSV with a byte order mark so Excel opens UTF-8 names correctly. */
export function toCsv(columns: DataGridColumn[], rows: DataGridRow[]) {
  const quote = (text: string) => /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  const lines = [columns.map(c => quote(c.label)).join(",")];
  for (const row of rows) lines.push(columns.map(c => { const v = row[c.key]; return quote(v === null || v === undefined ? "" : String(v)); }).join(","));
  return "\ufeff" + lines.join("\r\n");
}

export function download(name: string, content: string | Uint8Array, type: string) {
  const url = URL.createObjectURL(new Blob([content as BlobPart], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Writes rich and plain text to the clipboard outside a copy event. Falls back to plain text, then reports failure. */
export async function writeClipboard(text: string, html: string) {
  try {
    if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": new Blob([text], { type: "text/plain" }), "text/html": new Blob([html], { type: "text/html" }) })]);
      return true;
    }
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "data";
