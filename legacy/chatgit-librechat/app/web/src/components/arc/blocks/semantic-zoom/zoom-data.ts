/** Northstar Studio: five teams, their projects and tasks, laid out on one world plane. Seeded, so server and client agree. */

export type Status = "done" | "review" | "progress" | "todo" | "blocked";
export type Health = "on-track" | "at-risk" | "off-track";
export type Kind = 0 | 1 | 2 | 3 | 4;
export const KIND_LABEL = ["Company", "Team", "Project", "Task", "Person"] as const;

export interface Person { name: string; first: string; initials: string; role: string; portrait?: string }
export interface Task { id: number; project: number; title: string; base: Status; assignee: number; due: number; points: number; comments: number; checklist: string[]; baseChecks: boolean[] }
export interface Project { id: number; team: number; name: string; brief: string; health: Health; due: number; lead: number; blocker: string; tasks: number[]; people: number[] }
export interface Team { id: number; name: string; lead: number; mission: string; members: number[]; projects: number[] }
export interface MapNode { id: number; kind: Kind; parent: number; children: number[]; x: number; y: number; w: number; h: number; ref: number; name: string }

export const STATUS_LABEL: Record<Status, string> = { done: "Done", review: "In review", progress: "In progress", todo: "To do", blocked: "Blocked" };
export const HEALTH_LABEL: Record<Health, string> = { "on-track": "On track", "at-risk": "At risk", "off-track": "Off track" };

function seeded(seed: number) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const person = (name: string, role: string, portrait?: string): Person => {
  const parts = name.split(" ");
  return { name, first: parts[0], initials: (parts[0][0] + parts[parts.length - 1][0]).toUpperCase(), role, portrait };
};

export const PEOPLE: Person[] = [
  person("Jasmine Brooks", "Engineering lead", "/media/people/jasmine-brooks.jpg"),
  person("Emma Collins", "Design lead", "/media/people/emma-collins.jpg"),
  person("Marcus Johnson", "Growth lead", "/media/people/marcus-johnson.jpg"),
  person("Ava Mitchell", "Mobile lead", "/media/people/ava-mitchell.jpg"),
  person("Sofia Ramirez", "Data lead", "/media/people/sofia-ramirez.jpg"),
  person("Nathan Cole", "Staff engineer", "/media/people/nathan-cole.jpg"), person("Daniel Kim", "Backend engineer", "/media/people/daniel-kim.jpg"), person("Olivia Bennett", "Site reliability engineer", "/media/people/olivia-bennett.jpg"), person("Aiko Tanaka", "Security engineer"),
  person("Chloe Nguyen", "Product designer", "/media/people/chloe-nguyen.jpg"), person("Ben Okafor", "Product designer"), person("Hannah Walsh", "Content designer", "/media/people/hannah-walsh.jpg"),
  person("Mateo Alvarez", "Growth engineer", "/media/people/mateo-alvarez.jpg"), person("Ryan Sullivan", "Lifecycle marketer", "/media/people/ryan-sullivan.jpg"), person("Andre Williams", "Data analyst", "/media/people/andre-williams.jpg"),
  person("Tyler Hayes", "iOS engineer", "/media/people/tyler-hayes.jpg"), person("Mei Lin", "Android engineer"), person("Jordan Reyes", "Mobile QA engineer", "/media/people/jordan-reyes.jpg"),
  person("Nina Petrov", "Analytics engineer"), person("Elif Kaya", "Data scientist"), person("Diane Foster", "Data engineer", "/media/people/diane-foster.jpg"),
];

interface ProjectSeed { name: string; brief: string; health: Health; due: number; done: number; blocker: string; tasks: string[] }
interface TeamSeed { name: string; lead: number; members: number[]; mission: string; cols: number; rows: number; x: number; y: number; cw: number; projects: ProjectSeed[] }

const TEAM_SEEDS: TeamSeed[] = [
  { name: "Platform", lead: 0, members: [0, 5, 6, 7, 8], mission: "Billing, identity and the infrastructure under every request.", cols: 3, rows: 2, x: 0, y: 0, cw: 200, projects: [
    { name: "Billing v2", brief: "Move invoicing onto the new usage ledger.", health: "at-risk", due: 23, done: .42, blocker: "the ledger schema review with finance", tasks: ["Backfill invoices into the ledger", "Dual-write usage events", "Proration for mid-cycle upgrades", "Tax lines for EU customers", "Invoice PDF renderer", "Dunning email retries", "Reconcile Stripe payouts", "Migrate legacy coupons", "Load test month-end close", "Finance sign-off on totals"] },
    { name: "SSO for enterprise", brief: "SAML and SCIM for Enterprise workspaces.", health: "on-track", due: 30, done: .43, blocker: "", tasks: ["SAML metadata upload", "SCIM user provisioning", "Group to role mapping", "Just-in-time accounts", "Enforce SSO setting", "Okta integration test", "Admin audit events"] },
    { name: "Edge caching", brief: "Serve published pages from 30 edge regions.", health: "on-track", due: 12, done: .67, blocker: "", tasks: ["Cache key design", "Purge on publish", "Stale-while-revalidate headers", "Regional failover drill", "Cache hit dashboard", "Roll out to 10% of workspaces"] },
    { name: "Postgres 17 upgrade", brief: "Upgrade the primary cluster with zero downtime.", health: "on-track", due: 8, done: .72, blocker: "", tasks: ["Replica on Postgres 17", "Replication lag alerts", "Extension compatibility", "Cutover runbook", "Rehearse cutover on staging", "Book maintenance window", "Retire old primary"] },
    { name: "Audit log export", brief: "Stream audit events to customer SIEM tools.", health: "off-track", due: 41, done: .13, blocker: "the event schema sign-off from security", tasks: ["Event schema v1", "Splunk connector", "Datadog connector", "Retention settings", "Export screen in admin", "Backfill 90 days of events", "Signed delivery with HMAC", "Rate limits per workspace"] },
    { name: "Rate limiting", brief: "Fair usage limits for the public API.", health: "on-track", due: 19, done: .5, blocker: "", tasks: ["Token bucket per key", "Document 429 responses", "Burst allowance for Enterprise", "Limit headers on responses", "Usage alert at 80%", "Shadow mode rollout"] },
  ] },
  { name: "Product design", lead: 1, members: [1, 9, 10, 11], mission: "The design system and every first-run experience.", cols: 2, rows: 2, x: 704, y: 0, cw: 200, projects: [
    { name: "Design system 3.0", brief: "New tokens, dark mode and 40 rebuilt components.", health: "on-track", due: 27, done: .56, blocker: "", tasks: ["Color tokens in OKLCH", "Dark mode surfaces", "Button and input specs", "Table component", "Motion guidelines", "Icon set at 1.75 stroke", "Figma library release", "Migration guide", "Deprecate v2 components"] },
    { name: "Onboarding redesign", brief: "First project in under five minutes.", health: "at-risk", due: 16, done: .38, blocker: "the template picker API from Platform", tasks: ["Map current drop-off", "Welcome checklist", "Template picker", "Invite teammates step", "Empty state artwork", "Usability test with 8 teams", "Copy review", "A/B test plan"] },
    { name: "Mobile navigation", brief: "One tab bar for iOS and Android.", health: "on-track", due: 34, done: .33, blocker: "", tasks: ["Audit current navigation", "Tab bar prototype", "Search entry point", "Gesture spec", "Handoff to Mobile", "Accessibility review"] },
    { name: "Accessibility audit", brief: "WCAG 2.2 AA across the web app.", health: "on-track", due: 44, done: .29, blocker: "", tasks: ["Keyboard paths in editor", "Screen reader labels", "Contrast in charts", "Reduced motion pass", "Focus order in dialogs", "Report for customers", "Fix list for Q4"] },
  ] },
  { name: "Growth", lead: 2, members: [2, 12, 13, 14], mission: "Trials, pricing and the first 30 days.", cols: 2, rows: 2, x: 1192, y: 0, cw: 200, projects: [
    { name: "Pricing page test", brief: "Test annual-first pricing with 50% of visitors.", health: "on-track", due: 9, done: .71, blocker: "", tasks: ["Hypothesis and metrics", "Annual toggle design", "Experiment flag", "Stripe price IDs", "QA in five currencies", "Launch to 50%", "Readout doc"] },
    { name: "Referral program", brief: "A free month for every team that joins.", health: "at-risk", due: 25, done: .25, blocker: "legal review of the referral terms", tasks: ["Reward rules", "Referral link service", "Fraud checks", "Invite page", "Credit on invoice", "Legal review of terms", "Launch email", "Referral dashboard"] },
    { name: "Lifecycle emails", brief: "Rewrite the first 30 days of email.", health: "on-track", due: 14, done: .57, blocker: "", tasks: ["Audit current sends", "Day 1 welcome", "Day 3 template nudge", "Day 7 invite reminder", "Day 14 trial ending", "Plain text versions", "Unsubscribe center"] },
    { name: "Trial conversion", brief: "Lift trial to paid from 18% to 24%.", health: "on-track", due: 38, done: .33, blocker: "", tasks: ["Cohort analysis of trials", "Paywall moments", "In-app upgrade prompt", "Sales assist for large teams", "Trial extension flow", "Win-back offer"] },
  ] },
  { name: "Mobile", lead: 3, members: [3, 15, 16, 17], mission: "Northstar on iOS and Android.", cols: 4, rows: 1, x: 0, y: 588, cw: 208, projects: [
    { name: "Offline mode", brief: "Edit projects offline and sync later.", health: "at-risk", due: 31, done: .25, blocker: "sync conflict rules from Platform", tasks: ["Local database schema", "Sync conflict rules", "Queue writes offline", "Offline banner", "Attachment caching", "Conflict resolution screen", "Airplane mode test plan", "Beta for 500 people"] },
    { name: "iOS widgets", brief: "Today and project widgets for the home screen.", health: "on-track", due: 11, done: .67, blocker: "", tasks: ["Widget sizes", "Timeline provider", "Deep links into projects", "Lock screen widget", "App Store screenshots", "Release notes"] },
    { name: "Android performance", brief: "Cold start under 1.5 seconds.", health: "on-track", due: 20, done: .5, blocker: "", tasks: ["Baseline profiles", "Lazy load the editor", "Trace cold start", "Reduce APK size", "Image cache tuning", "Play Console vitals review"] },
    { name: "Notification settings", brief: "Per-project push notification controls.", health: "off-track", due: 6, done: .29, blocker: "the preferences API migration", tasks: ["Settings screen", "Server-side preferences", "Quiet hours", "Digest mode", "Migrate old settings", "Permission prompt timing", "QA on 12 devices"] },
  ] },
  { name: "Data and insights", lead: 4, members: [4, 18, 19, 20], mission: "Metrics everyone trusts.", cols: 3, rows: 1, x: 952, y: 588, cw: 208, projects: [
    { name: "Usage analytics", brief: "Show workspace admins who uses what.", health: "on-track", due: 18, done: .5, blocker: "", tasks: ["Event tracking plan", "Daily active members chart", "Feature adoption table", "CSV export", "Admin permissions", "Loading and empty states", "Help center article", "Beta feedback review"] },
    { name: "Revenue dashboard", brief: "One trusted view of MRR for leadership.", health: "on-track", due: 10, done: .67, blocker: "", tasks: ["MRR definition", "Subscription models in dbt", "Expansion and churn split", "Board deck export", "Reconcile with finance", "Data freshness alert"] },
    { name: "Churn model", brief: "Flag at-risk accounts two months early.", health: "at-risk", due: 36, done: .25, blocker: "labelled churn data from Customer success", tasks: ["Feature set", "Label historical churn", "Train baseline model", "Calibration check", "Score accounts nightly", "Surface scores in the CRM", "Review with success team", "Model card"] },
  ] },
];

const CHECKLIST = ["Write the spec", "Agree on scope", "Build behind a flag", "Add tests", "Review with the team", "QA on staging", "Update the docs", "Ship to 10%"];

/* World geometry in units. The stage camera scales these; labels read their size from it. */
export const HEADER = 84, PAD = 20, GAP_IN = 16, CARD_H = 218;
export const CARD = { pad: 12, title: 10, meta: 32, bar: 50, tiles: 60, cols: 3, tileH: 28, tileGap: 4, people: 190, avatar: 16, step: 19 };
export const WORLD = { w: 1648, h: 910 };

export const TEAMS: Team[] = [];
export const PROJECTS: Project[] = [];
export const TASKS: Task[] = [];
export const NODES: MapNode[] = [{ id: 0, kind: 0, parent: -1, children: [], x: 0, y: 0, w: WORLD.w, h: WORLD.h, ref: 0, name: "Northstar Studio" }];
export const TEAM_NODE: number[] = [];
export const PROJECT_NODE: number[] = [];
export const TASK_NODE: number[] = [];

const addNode = (n: Omit<MapNode, "id" | "children">) => {
  const node: MapNode = { ...n, id: NODES.length, children: [] };
  NODES.push(node);
  NODES[n.parent].children.push(node.id);
  return node.id;
};

(() => {
  const rand = seeded(20260922);
  TEAM_SEEDS.forEach((ts, ti) => {
    const team: Team = { id: ti, name: ts.name, lead: ts.lead, mission: ts.mission, members: ts.members, projects: [] };
    TEAMS.push(team);
    const tw = PAD * 2 + ts.cols * ts.cw + (ts.cols - 1) * GAP_IN, th = HEADER + ts.rows * CARD_H + (ts.rows - 1) * GAP_IN + PAD;
    const teamNode = addNode({ kind: 1, parent: 0, x: ts.x, y: ts.y, w: tw, h: th, ref: ti, name: ts.name });
    TEAM_NODE.push(teamNode);
    ts.projects.forEach((ps, pi) => {
      const pid = PROJECTS.length;
      const project: Project = { id: pid, team: ti, name: ps.name, brief: ps.brief, health: ps.health, due: ps.due, lead: ts.members[pi % ts.members.length], blocker: ps.blocker, tasks: [], people: [] };
      PROJECTS.push(project);
      team.projects.push(pid);
      const cx = ts.x + PAD + (pi % ts.cols) * (ts.cw + GAP_IN), cy = ts.y + HEADER + Math.floor(pi / ts.cols) * (CARD_H + GAP_IN);
      const projectNode = addNode({ kind: 2, parent: teamNode, x: cx, y: cy, w: ts.cw, h: CARD_H, ref: pid, name: ps.name });
      PROJECT_NODE.push(projectNode);

      const n = ps.tasks.length, nDone = Math.round(n * ps.done);
      const blocked = ps.health === "off-track" ? 2 : ps.health === "at-risk" ? 1 : 0;
      const tileW = (ts.cw - CARD.pad * 2 - CARD.tileGap * (CARD.cols - 1)) / CARD.cols;
      ps.tasks.forEach((title, k) => {
        const open = k - nDone;
        const base: Status = open < 0 ? "done" : open === 0 && n - nDone > 3 ? "review" : open <= (n - nDone > 3 ? 2 : 1) ? "progress" : open <= (n - nDone > 3 ? 2 : 1) + blocked ? "blocked" : "todo";
        const pool = ts.members;
        const assignee = k === 0 ? project.lead : pool[Math.floor(rand() * pool.length)];
        const due = base === "done" ? -3 - (nDone - k) * 3 - Math.floor(rand() * 3) : Math.max(1, Math.round(((open + 1) / (n - nDone)) * ps.due) - Math.floor(rand() * 3));
        const len = 3 + Math.floor(rand() * 3), start = Math.floor(rand() * (CHECKLIST.length - len + 1));
        const checklist = CHECKLIST.slice(start, start + len);
        const doneCount = base === "done" ? len : base === "review" ? len - 1 : base === "progress" ? Math.max(1, Math.floor(len / 2)) : base === "blocked" ? 1 : 0;
        const tid = TASKS.length;
        TASKS.push({ id: tid, project: pid, title, base, assignee, due, points: [1, 2, 3, 5, 8][Math.floor(rand() * 5)], comments: Math.floor(rand() * 13), checklist, baseChecks: checklist.map((_, i) => i < doneCount) });
        project.tasks.push(tid);
        const tx = cx + CARD.pad + (k % CARD.cols) * (tileW + CARD.tileGap), ty = cy + CARD.tiles + Math.floor(k / CARD.cols) * (CARD.tileH + CARD.tileGap);
        TASK_NODE.push(addNode({ kind: 3, parent: projectNode, x: tx, y: ty, w: tileW, h: CARD.tileH, ref: tid, name: title }));
      });
      const people = [project.lead, ...project.tasks.map(t => TASKS[t].assignee)];
      project.people = people.filter((p, i) => people.indexOf(p) === i).slice(0, 5);
      project.people.forEach((p, j) => addNode({ kind: 4, parent: projectNode, x: cx + CARD.pad + j * CARD.step, y: cy + CARD.people, w: CARD.avatar, h: CARD.avatar, ref: p, name: PEOPLE[p].name }));
    });
  });
})();

/* Dates are offsets in days from Tuesday, September 22, 2026. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function formatDay(offset: number) {
  const d = new Date(Date.UTC(2026, 8, 22 + offset));
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
export const formatCount = (n: number) => n.toLocaleString("en-US");

/** Live task state. Checklist ticks are local to one mounted map and roll up to every level. */
export class WorkModel {
  checks: boolean[][] = TASKS.map(t => [...t.baseChecks]);

  status(task: number): Status {
    const t = TASKS[task], c = this.checks[task];
    if (c.every(Boolean)) return "done";
    return t.base === "done" ? "review" : t.base;
  }
  completion(task: number) {
    const c = this.checks[task];
    return this.status(task) === "done" ? 1 : (c.filter(Boolean).length / c.length) * .8;
  }
  toggle(task: number, item: number) { this.checks[task][item] = !this.checks[task][item]; }
  done(task: number) { return this.checks[task].filter(Boolean).length; }

  describe(task: number) {
    const t = TASKS[task], p = PROJECTS[t.project], team = TEAMS[p.team], who = PEOPLE[t.assignee].first;
    const reviewer = PEOPLE[t.assignee !== p.lead ? p.lead : team.lead !== t.assignee ? team.lead : team.members[1]].first;
    const s = this.status(task);
    const lead = s === "done" ? `Done. ${who} shipped it ${t.due < 0 ? `on ${formatDay(t.due)}` : "today"}.`
      : s === "review" ? `${who} opened it for review by ${reviewer}.`
      : s === "progress" ? `${who} is on it and plans to finish by ${formatDay(t.due)}.`
      : s === "blocked" ? `Blocked by ${p.blocker || "an open dependency"}.`
      : `Not started. ${who} picks it up before ${formatDay(t.due)}.`;
    return `${lead} ${p.name}: ${p.brief}`;
  }

  tasksOf(node: number): number[] {
    const n = NODES[node];
    if (n.kind === 3) return [n.ref];
    if (n.kind === 2) return PROJECTS[n.ref].tasks;
    if (n.kind === 1) return TEAMS[n.ref].projects.flatMap(p => PROJECTS[p].tasks);
    if (n.kind === 4) return this.tasksOf(n.parent).filter(t => TASKS[t].assignee === n.ref);
    return TASKS.map(t => t.id);
  }

  stats(node: number) {
    const tasks = this.tasksOf(node);
    let points = 0, earned = 0, open = 0, blocked = 0, nextDue = Infinity;
    for (const t of tasks) {
      const s = this.status(t), p = TASKS[t].points;
      points += p; earned += p * this.completion(t);
      if (s !== "done") { open++; nextDue = Math.min(nextDue, TASKS[t].due); }
      if (s === "blocked") blocked++;
    }
    const n = NODES[node];
    const people = n.kind === 0 ? PEOPLE.map((_, i) => i) : n.kind === 1 ? TEAMS[n.ref].members : n.kind === 2 ? PROJECTS[n.ref].people : n.kind === 3 ? [TASKS[n.ref].assignee] : [n.ref];
    const projects = n.kind === 0 ? PROJECTS : n.kind === 1 ? TEAMS[n.ref].projects.map(p => PROJECTS[p]) : [];
    return {
      progress: points ? earned / points : 0, open, blocked, total: tasks.length, nextDue: Number.isFinite(nextDue) ? nextDue : null, people,
      projects: projects.length, atRisk: projects.filter(p => p.health !== "on-track").length,
    };
  }
}
export type Stats = ReturnType<WorkModel["stats"]>;

export const pathTo = (node: number) => {
  const path: number[] = [];
  for (let n = node; n >= 0; n = NODES[n].parent) path.unshift(n);
  return path;
};
