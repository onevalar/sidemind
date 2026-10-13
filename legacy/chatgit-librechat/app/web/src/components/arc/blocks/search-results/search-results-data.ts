import { person, photo } from "../../lib/media";
import type { PersonId, PhotoId } from "../../lib/media";

/**
 * Sample workspace content for the search results block: docs, people, and files from one company workspace.
 * Dates are fixed ISO days and every relative label is computed against `referenceDate`, so the first render is the
 * same on the server and the client.
 */

export type SearchKind = "doc" | "person" | "file";
export type FileExtension = "pdf" | "fig" | "xlsx" | "jpg" | "mp4" | "key";

export interface SearchTeam { id: string; label: string }

interface ResultBase {
  id: string;
  kind: SearchKind;
  team: string;
  /** Extra words that count as a match without being shown. */
  keywords?: string;
}

export interface DocResult extends ResultBase {
  kind: "doc";
  title: string;
  /** Where the doc lives, shown as a short path. */
  path: string;
  snippet: string;
  /** Paragraphs shown in the preview. */
  body: string[];
  author: PersonId;
  updated: string;
  readMinutes: number;
}

export interface PersonResult extends ResultBase {
  kind: "person";
  person: PersonId;
  title: string;
  role: string;
  snippet: string;
  email: string;
  location: string;
  /** Docs and files this person owns, for the preview. */
  owns: number;
}

export interface FileResult extends ResultBase {
  kind: "file";
  title: string;
  ext: FileExtension;
  size: string;
  snippet: string;
  owner: PersonId;
  updated: string;
  /** Image files show their photo. */
  photo?: PhotoId;
  pages?: number;
}

export type SearchResult = DocResult | PersonResult | FileResult;

export const referenceDate = "2026-09-24";

export const teams: SearchTeam[] = [
  { id: "success", label: "Customer success" },
  { id: "design", label: "Design" },
  { id: "engineering", label: "Engineering" },
  { id: "growth", label: "Growth" },
  { id: "operations", label: "Operations" },
  { id: "finance", label: "Finance" },
];

export const recentSearches = ["onboarding", "Lisbon offsite", "pricing page", "Marcus"];
export const suggestedSearches = ["roadmap", "brand guidelines", "invoice template", "hiring plan"];

const p = (id: PersonId) => person(id);

export const results: SearchResult[] = [
  {
    id: "doc-onboarding-playbook", kind: "doc", team: "success",
    title: "Customer onboarding playbook",
    path: "Customer success / Playbooks",
    snippet: "Every new enterprise account gets a named lead for the first 30 days. The onboarding call covers workspace setup, SSO, and the first import.",
    body: [
      "Every new enterprise account gets a named lead for the first 30 days. The onboarding call covers workspace setup, SSO, and the first import.",
      "By day 14 the account should have three active teams. If it does not, the lead books a second onboarding session and loops in solutions engineering.",
      "Close the onboarding phase with a short review: what the team shipped, where they got stuck, and who owns the account from here.",
    ],
    author: "hannah-walsh", updated: "2026-09-22", readMinutes: 6,
  },
  {
    id: "person-hannah", kind: "person", team: "success", person: "hannah-walsh",
    title: p("hannah-walsh").name, role: "Customer success lead",
    snippet: "Leads onboarding for enterprise accounts in Europe. Ask about SSO rollouts, data imports, and renewal health.",
    email: "hannah@northwind.co", location: "Dublin", owns: 42,
  },
  {
    id: "file-onboarding-flow", kind: "file", team: "design",
    title: "Onboarding flow v3.fig", ext: "fig", size: "18.2 MB",
    snippet: "Frames: Welcome, Invite your team, Connect Slack, First project. The onboarding checklist moves into the sidebar.",
    owner: "emma-collins", updated: "2026-09-18",
  },
  {
    id: "doc-eng-onboarding", kind: "doc", team: "engineering",
    title: "Onboarding checklist for new engineers",
    path: "Engineering / Handbook",
    snippet: "Your first week: get repo access, run the app locally, ship a small fix, and pair with your onboarding buddy on a production deploy.",
    body: [
      "Your first week: get repo access, run the app locally, ship a small fix, and pair with your onboarding buddy on a production deploy.",
      "Week two is about context. Read the last three incident reviews and sit in on a planning session with your team.",
      "By the end of your first month you should own one small service end to end, including its alerts and runbook.",
    ],
    author: "nathan-cole", updated: "2026-08-30", readMinutes: 4,
  },
  {
    id: "file-onboarding-metrics", kind: "file", team: "growth",
    title: "Q3 onboarding metrics.xlsx", ext: "xlsx", size: "412 KB",
    snippet: "Activation rose from 41% to 48% after the new onboarding checklist. Time to first project fell to 2.3 days.",
    owner: "chloe-nguyen", updated: "2026-09-12",
  },
  {
    id: "person-chloe", kind: "person", team: "growth", person: "chloe-nguyen",
    title: p("chloe-nguyen").name, role: "Data analyst",
    snippet: "Owns the activation dashboards and the weekly onboarding funnel report. Happy to pull numbers for any experiment.",
    email: "chloe@northwind.co", location: "Toronto", owns: 27,
  },
  {
    id: "file-welcome-kit", kind: "file", team: "operations",
    title: "Welcome kit for new hires.pdf", ext: "pdf", size: "3.1 MB", pages: 14,
    snippet: "Page 2: What to expect in your first week, from laptop setup to your onboarding lunch with the team.",
    owner: "sofia-ramirez", updated: "2026-06-04",
  },
  {
    id: "doc-onboarding-emails", kind: "doc", team: "growth",
    title: "Onboarding email sequence",
    path: "Growth / Lifecycle",
    snippet: "Five emails over 14 days. Each one points to a single next step, and the sequence stops as soon as the workspace is active.",
    body: [
      "Five emails over 14 days. Each one points to a single next step, and the sequence stops as soon as the workspace is active.",
      "Day 1 welcomes the admin and links to the import guide. Day 3 suggests inviting two teammates.",
      "We measure the onboarding sequence by activation, not by opens. Anything that does not move activation gets cut.",
    ],
    author: "ava-mitchell", updated: "2026-07-19", readMinutes: 3,
  },
  {
    id: "file-onboarding-walkthrough", kind: "file", team: "success",
    title: "Admin onboarding walkthrough.mp4", ext: "mp4", size: "248 MB",
    snippet: "A 12 minute recording of the admin console: roles, SSO, audit log, and billing. Used in every onboarding call.",
    owner: "jordan-reyes", updated: "2026-03-11",
  },
  {
    id: "doc-lisbon-agenda", kind: "doc", team: "operations",
    title: "Lisbon offsite agenda",
    path: "Operations / Events",
    snippet: "Three days in Lisbon, 14 to 16 October. Day one is planning, day two is team time, day three is a walk to Belém and dinner.",
    body: [
      "Three days in Lisbon, 14 to 16 October. Day one is planning, day two is team time, day three is a walk to Belém and dinner.",
      "Flights land on the 13th. We are staying in Chiado, ten minutes on foot from the venue.",
      "Please add dietary needs to the offsite sheet by 1 October.",
    ],
    author: "sofia-ramirez", updated: "2026-09-20", readMinutes: 2,
  },
  {
    id: "file-lisbon-rooftops", kind: "file", team: "operations",
    title: "Lisbon rooftops.jpg", ext: "jpg", size: "4.8 MB", photo: "lisbon-rooftops",
    snippet: "Venue scouting photo from the Lisbon offsite trip, taken from the Graça viewpoint.",
    owner: "sofia-ramirez", updated: "2026-08-14",
  },
  {
    id: "file-lisbon-tram", kind: "file", team: "operations",
    title: "Tram 28 route.jpg", ext: "jpg", size: "3.9 MB", photo: "lisbon-tram",
    keywords: "lisbon offsite",
    snippet: "Photo for the offsite guide: the tram route from the hotel to the venue.",
    owner: "sofia-ramirez", updated: "2026-08-14",
  },
  {
    id: "person-sofia", kind: "person", team: "operations", person: "sofia-ramirez",
    title: p("sofia-ramirez").name, role: "Operations lead",
    snippet: "Runs travel, offices, and the Lisbon offsite. Send questions about flights and hotels here.",
    email: "sofia@northwind.co", location: "Lisbon", owns: 35,
  },
  {
    id: "doc-pricing-page", kind: "doc", team: "growth",
    title: "Pricing page rewrite",
    path: "Growth / Website",
    snippet: "Lead with the Team plan, move seat pricing above the fold, and answer the three most common pricing questions right under the table.",
    body: [
      "Lead with the Team plan, move seat pricing above the fold, and answer the three most common pricing questions right under the table.",
      "The current page asks visitors to compare nine rows before they see a price. The rewrite cuts that to four.",
      "We will run the new pricing page as a two week test with 50% of traffic.",
    ],
    author: "tyler-hayes", updated: "2026-09-09", readMinutes: 5,
  },
  {
    id: "file-pricing-model", kind: "file", team: "finance",
    title: "Pricing model 2027.xlsx", ext: "xlsx", size: "1.2 MB",
    snippet: "Seat price scenarios for the Team and Business plans, with discount bands and expected pricing impact on net revenue.",
    owner: "andre-williams", updated: "2026-09-02",
  },
  {
    id: "person-andre", kind: "person", team: "finance", person: "andre-williams",
    title: p("andre-williams").name, role: "Finance partner",
    snippet: "Partners with growth on pricing, discounts, and plan packaging. Keeper of the revenue model.",
    email: "andre@northwind.co", location: "New York", owns: 19,
  },
  {
    id: "doc-roadmap", kind: "doc", team: "engineering",
    title: "Q4 product roadmap",
    path: "Product / Planning",
    snippet: "Three bets for Q4: faster search, a calmer inbox, and offline mode for mobile. Each roadmap item lists an owner and a ship date.",
    body: [
      "Three bets for Q4: faster search, a calmer inbox, and offline mode for mobile. Each roadmap item lists an owner and a ship date.",
      "Search ships first. The goal is results in under 200 milliseconds for workspaces with a million items.",
      "The roadmap is reviewed every two weeks. Changes are posted in the product channel.",
    ],
    author: "diane-foster", updated: "2026-09-16", readMinutes: 7,
  },
  {
    id: "file-roadmap-deck", kind: "file", team: "engineering",
    title: "Roadmap review, September.key", ext: "key", size: "36.5 MB", pages: 22,
    snippet: "Slide 4: search latency by workspace size. Slide 9: roadmap risks and what we cut.",
    owner: "nathan-cole", updated: "2026-09-10",
  },
  {
    id: "person-marcus", kind: "person", team: "engineering", person: "marcus-johnson",
    title: p("marcus-johnson").name, role: "Frontend engineer",
    snippet: "Building the new search experience and the keyboard shortcuts across the app.",
    email: "marcus@northwind.co", location: "Berlin", owns: 23,
  },
  {
    id: "doc-brand", kind: "doc", team: "design",
    title: "Brand guidelines",
    path: "Design / Brand",
    snippet: "Our voice is plain and warm. Use sentence case, short words, and one idea per sentence. Logos keep a clear space of one cap height.",
    body: [
      "Our voice is plain and warm. Use sentence case, short words, and one idea per sentence. Logos keep a clear space of one cap height.",
      "Photography shows real places and people at work. No stock handshakes.",
      "When in doubt, ask the brand channel before a launch.",
    ],
    author: "jasmine-brooks", updated: "2026-05-27", readMinutes: 8,
  },
  {
    id: "person-jasmine", kind: "person", team: "design", person: "jasmine-brooks",
    title: p("jasmine-brooks").name, role: "Design lead",
    snippet: "Leads product design and keeps the brand guidelines current. Reviews every launch before it ships.",
    email: "jasmine@northwind.co", location: "London", owns: 51,
  },
  {
    id: "file-invoice-template", kind: "file", team: "finance",
    title: "Invoice template.pdf", ext: "pdf", size: "220 KB", pages: 1,
    snippet: "The standard invoice template with VAT fields for EU customers and a purchase order line.",
    owner: "andre-williams", updated: "2025-11-06",
  },
  {
    id: "doc-hiring-plan", kind: "doc", team: "operations",
    title: "2027 hiring plan",
    path: "People / Planning",
    snippet: "Twelve roles next year, most in engineering and customer success. Each hiring manager owns a scorecard and an onboarding plan.",
    body: [
      "Twelve roles next year, most in engineering and customer success. Each hiring manager owns a scorecard and an onboarding plan.",
      "We hire in Europe and North America, with a preference for overlap with the Lisbon and New York hubs.",
      "Offers are approved by the hiring manager and finance within two working days.",
    ],
    author: "diane-foster", updated: "2026-09-05", readMinutes: 5,
  },
  {
    id: "person-mateo", kind: "person", team: "engineering", person: "mateo-alvarez",
    title: p("mateo-alvarez").name, role: "Mobile engineer",
    snippet: "Working on offline mode for the mobile apps. Previously built the onboarding screens on iOS.",
    email: "mateo@northwind.co", location: "Madrid", owns: 16,
  },
  {
    id: "file-office-photo", kind: "file", team: "operations",
    title: "New Dublin office.jpg", ext: "jpg", size: "5.2 MB", photo: "home-office",
    snippet: "The quiet room on the second floor, ready for the new hires starting in October.",
    owner: "sofia-ramirez", updated: "2026-01-21",
  },
];

/** Resolves a result's person or owner for display. */
export function personOf(id: PersonId) { return person(id); }
export function photoOf(id: PhotoId) { return photo(id); }
