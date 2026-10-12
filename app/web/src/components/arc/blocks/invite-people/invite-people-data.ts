import { people, type PersonId } from "../../lib/media";

export type Role = "admin" | "member" | "guest";

export const ROLES: { value: Role; label: string; description: string }[] = [
  { value: "admin", label: "Admin", description: "Manages members and billing" },
  { value: "member", label: "Member", description: "Creates and edits projects" },
  { value: "guest", label: "Guest", description: "Views shared projects only" },
];
export const roleLabel = (role: Role) => ROLES.find(entry => entry.value === role)!.label;

/** Someone who can be invited: a directory person with a photo, or a bare email address. */
export interface Entry {
  email: string;
  name?: string;
  title?: string;
  src?: string;
}

export const DOMAIN = "fieldwork.example";
export const emailFor = (id: string) => `${id.replace("-", ".")}@${DOMAIN}`;

/** The workspace directory, from the shared demo portraits in `public/media/people`. */
export const DIRECTORY: Entry[] = people.map(person => ({ email: emailFor(person.id), name: person.name, title: person.role, src: person.src }));
const byId = (id: PersonId) => DIRECTORY.find(entry => entry.email === emailFor(id))!;

export const TEAM: Entry[] = (["diane-foster", "nathan-cole", "jasmine-brooks", "daniel-kim", "chloe-nguyen"] as PersonId[]).map(byId);
export const INVITED = { entry: byId("tyler-hayes"), role: "member" as Role, note: "Sent 2 days ago" };

export const PLANS = {
  starter: { name: "Starter", seats: 10 },
  team: { name: "Team", seats: 25 },
} as const;
export type PlanId = keyof typeof PLANS;

/** A mixed list, as it might come out of a spreadsheet: good addresses, names, typos, a teammate, and a duplicate. */
export const SAMPLE_LIST = [
  "emma.collins@fieldwork.example",
  "Marcus Johnson",
  "sofia.ramirez@fieldwork.example",
  "olivia@northwind",
  "jordan.reyes@",
  "Nathan Cole",
  "Ava Mitchell <ava.mitchell@fieldwork.example>",
  "hannah.walsh@fieldwork.example",
  "alex turner",
  "emma.collins@fieldwork.example",
].join(", ");

const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[a-z]{2,}$/i;
export const isEmail = (text: string) => EMAIL.test(text);

/** Splits pasted text on commas, semicolons, and new lines. Plain spaces only separate when several addresses sit on one line. */
export function splitList(text: string) {
  if (/[,;\n]/.test(text)) return text.split(/[,;\n]+/);
  if ((text.match(/@/g)?.length ?? 0) > 1) return text.split(/\s+/);
  return [text];
}

export type Parsed = { kind: "ok"; entry: Entry } | { kind: "error"; text: string; message: string };

/** Resolves one token to a person, or explains in plain words why it cannot be invited. */
export function parseToken(raw: string, taken: { team: Set<string>; pending: Set<string> }): Parsed | null {
  const bracketed = raw.match(/<\s*([^<>\s]+)\s*>/);
  const text = (bracketed ? bracketed[1] : raw).trim().replace(/^["']+|["']+$/g, "").trim();
  if (!text) return null;
  const lower = text.toLowerCase().replace(/\s+/g, " ");
  const entry = DIRECTORY.find(person => person.name?.toLowerCase() === lower)
    ?? (isEmail(text) ? DIRECTORY.find(person => person.email === lower) ?? { email: lower } : undefined);
  if (entry) {
    const label = entry.name ?? entry.email;
    if (taken.team.has(entry.email)) return { kind: "error", text, message: `${label} is already on the team` };
    if (taken.pending.has(entry.email)) return { kind: "error", text, message: `${label} already has a pending invite` };
    return { kind: "ok", entry };
  }
  const quoted = `“${text}”`;
  if (!text.includes("@")) return { kind: "error", text, message: `${quoted} isn’t an email address` };
  const at = text.lastIndexOf("@");
  const local = text.slice(0, at), domain = text.slice(at + 1);
  if (!local) return { kind: "error", text, message: `${quoted} is missing a name before the @` };
  if (!domain) return { kind: "error", text, message: `${quoted} is missing a domain` };
  if (!domain.includes(".")) return { kind: "error", text, message: `${quoted} needs a full domain, like ${DOMAIN}` };
  return { kind: "error", text, message: `${quoted} isn’t a valid email address` };
}
