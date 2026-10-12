/**
 * Types, sample data, and the scripted sample responder for the AI chat block.
 * Replace `sampleResponder` with a function that streams events from your model; the shapes below are the whole contract.
 */

export interface ChatSource {
  /** Where the source lives. The card shows its domain. */
  url: string;
  title: string;
  /** One or two sentences quoted from the source. */
  snippet?: string;
}

export interface ChatToolCall {
  id: string;
  /** Label while the tool runs, such as "Searching the web". */
  running: string;
  /** Label once it has finished, such as "Searched 5 sources". */
  done: string;
  kind: "search" | "read" | "image" | "code";
  status: "running" | "done" | "error";
  /** The arguments or a short result, shown when the chip is opened. */
  detail?: string;
}

export interface AiChatAttachment {
  id: string;
  name: string;
  /** An image URL, an object URL, or a data URL. */
  url: string;
  width?: number;
  height?: number;
}

/** One generated answer. Regenerating adds another version to the same message. */
export interface ChatAnswer {
  /** Markdown with inline citations written as [1], [2], matching `sources`. */
  text: string;
  thinking?: string;
  /** Seconds spent thinking, shown once the answer starts. */
  thoughtFor?: number;
  tools?: ChatToolCall[];
  sources?: ChatSource[];
  model: string;
  status: "thinking" | "streaming" | "done" | "stopped" | "error";
}

export type AiChatMessage =
  | { id: string; role: "user"; text: string; attachments?: AiChatAttachment[] }
  | { id: string; role: "assistant"; versions: ChatAnswer[]; current: number };

export interface ChatConversation {
  id: string;
  title: string;
  /** Groups the conversation in the sidebar, such as "Today" or "Previous 7 days". */
  group: string;
  messages: AiChatMessage[];
}

export interface ChatModel {
  id: string;
  name: string;
  description: string;
}

export interface ChatSuggestion {
  label: string;
  prompt: string;
  attachments?: AiChatAttachment[];
}

export type ChatStreamEvent =
  /** Appends reasoning text. */
  | { type: "thinking"; text: string }
  /** Adds or updates a tool call by id. */
  | { type: "tool"; tool: ChatToolCall }
  /** Replaces the sources that inline citations point at. */
  | { type: "sources"; sources: ChatSource[] }
  /** Appends answer markdown. The first text event closes the thinking panel. */
  | { type: "text"; text: string };

export interface ChatRequest {
  conversationId: string;
  /** Everything before the answer being generated, including the prompt. */
  messages: AiChatMessage[];
  prompt: string;
  attachments: AiChatAttachment[];
  model: string;
}

export type ChatResponder = (request: ChatRequest, signal: AbortSignal) => AsyncIterable<ChatStreamEvent>;

export const sampleModels: ChatModel[] = [
  { id: "atlas-deep", name: "Atlas 4 Deep", description: "Thinks longer for analysis and code" },
  { id: "atlas", name: "Atlas 4", description: "Balanced for everyday work" },
  { id: "atlas-swift", name: "Atlas 4 Swift", description: "Fastest answers, no reasoning" },
];

const livingRoom: AiChatAttachment = { id: "sample-living-room", name: "living-room.jpg", url: "/media/photos/living-room.jpg", width: 1200, height: 1600 };

export const sampleSuggestions: ChatSuggestion[] = [
  { label: "Compare Postgres and SQLite for offline sync", prompt: "Should our mobile app use Postgres or SQLite for offline sync?" },
  { label: "Write a query for weekly active teams", prompt: "Write a SQL query for weekly active teams over the last 12 weeks." },
  { label: "Draft a launch email for offline mode", prompt: "Draft a short launch email for offline mode. Keep it plain." },
  { label: "Suggest a palette for this room", prompt: "Suggest a color palette for this room.", attachments: [livingRoom] },
];

type Script = { thinking?: string; tools?: Omit<ChatToolCall, "status">[]; sources?: ChatSource[]; text: string };

const scripts: Record<"sync" | "query" | "email" | "palette" | "fallback", Script> = {
  sync: {
    thinking: "The team ships a mobile app that has to work offline. The real question is where the source of truth lives and how conflicts resolve. SQLite runs on the device and Postgres on the server, so the answer is probably both. I should compare the jobs each one does and suggest a simple sync model to start with.",
    tools: [{ id: "search", kind: "search", running: "Searching the web", done: "Searched 3 sources", detail: "postgres sqlite offline sync mobile" }],
    sources: [
      { url: "https://www.sqlite.org/whentouse.html", title: "Appropriate uses for SQLite", snippet: "SQLite does not compete with client/server databases. SQLite competes with fopen()." },
      { url: "https://www.postgresql.org/docs/current/logical-replication.html", title: "Logical replication", snippet: "Logical replication is a method of replicating data objects and their changes, based upon their replication identity." },
      { url: "https://www.inkandswitch.com/local-first/", title: "Local-first software", snippet: "You own your data, in spite of the cloud. Local-first apps keep the primary copy of the data on the device." },
    ],
    text: `Use both. SQLite on the device and Postgres on the server, with a sync layer between them. They solve different halves of the problem [1].

## Where each one fits

- **SQLite** lives inside the app, so reads and writes work with no connection at all [1].
- **Postgres** stays the source of truth. Logical replication can stream row changes to your sync service [2].
- **The sync layer** decides what happens when two people edit the same record offline [3].

| | SQLite | Postgres |
| --- | --- | --- |
| Runs on | Each device | Your servers |
| Works offline | Yes | No |
| Concurrent writers | One at a time | Thousands |
| Typical size | A few GB | Terabytes |

## A starting schema

Track a version on every row so a device can ask for only what changed:

\`\`\`sql
create table tasks (
  id uuid primary key,
  title text not null,
  done boolean default false,
  version bigint not null default 1
);

select * from tasks
where version > $1
order by version;
\`\`\`

Start with last write wins per field. Reach for a CRDT only on fields people truly edit together, like shared notes [3].`,
  },
  query: {
    thinking: "Weekly active teams means a team with at least one member doing something meaningful that week. Page views should not count. I will check the schema for the events table first.",
    tools: [{ id: "schema", kind: "read", running: "Reading schema.sql", done: "Read schema.sql", detail: "events, teams, memberships" }],
    text: `This counts a team as active when any member creates or edits something that week. Page views are left out on purpose.

\`\`\`sql
select
  date_trunc('week', e.created_at) as week,
  count(distinct m.team_id) as active_teams
from events e
join memberships m on m.user_id = e.user_id
where e.name in ('doc_created', 'doc_edited', 'task_completed')
  and e.created_at >= now() - interval '12 weeks'
group by 1
order by 1;
\`\`\`

A few notes:

1. \`date_trunc\` starts weeks on Monday in Postgres.
2. A person in two teams counts toward both.
3. Add an index on \`events (name, created_at)\` if this runs on a schedule.`,
  },
  email: {
    thinking: "Plain tone, short, and it should say what changed and what to do next.",
    text: `**Subject:** Tandem now works offline

Hi Jordan,

Tandem now opens, saves, and syncs without a connection. Write on a flight, check tasks in a tunnel, and everything catches up the moment you are back online.

### What changed

- Notes, tasks, and comments load straight from your device.
- Edits made offline sync in the order you made them.
- If two people change the same note, you see both versions side by side.

Offline mode is on for every plan starting today. Update to version 4.3 to get it.

Thanks for waiting on this one,
Sofia`,
  },
  palette: {
    thinking: "A bright living room with timber beams, arched windows, and cream sofas. The palette should build on the warm wood and the pale plaster, with one deeper accent to ground it.",
    tools: [{ id: "image", kind: "image", running: "Looking at living-room.jpg", done: "Looked at living-room.jpg", detail: "Timber beams, arched windows, cream sofas" }],
    sources: [
      { url: "https://www.energy.gov/energysaver/lighting-choices-save-you-money", title: "Lighting choices to save you money", snippet: "Warm white bulbs give off a yellowish light that suits living rooms and bedrooms." },
      { url: "https://www.nps.gov/articles/000/preservation-brief-10-exterior-paint.htm", title: "Paint and wood surfaces", snippet: "Choose finishes that let natural wood read as a material rather than a flat color." },
    ],
    text: `The room already has a strong base in the pale plaster and the honey timber. Build on those and add one grounded accent.

### Suggested palette

| Role | Color | Hex |
| --- | --- | --- |
| Walls | Limewash white | \`#F2EDE4\` |
| Wood | Honey oak | \`#B98A5A\` |
| Textiles | Oat linen | \`#DCCFBC\` |
| Accent | Olive | \`#6B6B47\` |

- Keep the sofas cream and bring olive in through cushions or one armchair.
- Use warm white bulbs so the timber reads golden at night [1].
- Repeat the oak once more, such as a side table, so the beams do not float [2].`,
  },
  fallback: {
    thinking: "This preview only has scripted answers, so I should say so and show what a formatted reply looks like.",
    sources: [{ url: "https://commonmark.org", title: "CommonMark", snippet: "A strongly defined, highly compatible specification of Markdown." }],
    text: `This preview runs on scripted answers, so it cannot read your question yet. Connect \`respond\` to your model and the same surface streams real replies.

A reply can include:

- **Markdown** with headings, lists, tables, and code
- **Citations** that open a source card on hover [1]
- **Tool calls** that show what the assistant did along the way

Try one of the suggested prompts to see a full answer.`,
  },
};

function pickScript(prompt: string, attachments: AiChatAttachment[]): Script {
  const text = prompt.toLowerCase();
  if (attachments.length || /palette|color|colour|room/.test(text)) return scripts.palette;
  if (/sqlite|postgres|offline sync|database/.test(text)) return scripts.sync;
  if (/sql|query|active teams|weekly/.test(text)) return scripts.query;
  if (/email|launch|announce/.test(text)) return scripts.email;
  return scripts.fallback;
}

/** Splits markdown into streamable chunks. Line markers stay with their first word, emphasis and code spans stay whole, and table rows and code lines arrive one at a time. */
export function chunkMarkdown(markdown: string) {
  const chunks: string[] = [];
  const lines = markdown.split("\n");
  let inCode = false;
  let pending = "";
  const push = (chunk: string) => { chunks.push(pending + chunk); pending = ""; };
  lines.forEach((line, index) => {
    // A table separator travels with its header row.
    if (!inCode && /^\|\s*-/.test(line)) return;
    pending += index === 0 ? "" : "\n";
    if (line.startsWith("```")) { inCode = !inCode; push(line); return; }
    if (inCode) { push(line); return; }
    if (!line.trim()) return;
    if (line.startsWith("|")) {
      const next = lines[index + 1] ?? "";
      push(/^\|\s*-/.test(next) ? `${line}\n${next}` : line);
      return;
    }
    const marker = line.match(/^(#{1,3} |- |\d+\. |> )/)?.[0] ?? "";
    const body = line.slice(marker.length);
    const words = body.match(/\*\*[^*]+\*\*\S*|`[^`]+`\S*|\S+/g) ?? [];
    words.forEach((word, position) => push(position === 0 ? marker + word : ` ${word}`));
  });
  if (pending) chunks.push(pending);
  return chunks;
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) { reject(signal.reason); return; }
  const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  signal.addEventListener("abort", abort, { once: true });
});

/** Streams a scripted answer: reasoning, tool calls, then markdown in small chunks. Every answer is a sample. */
export async function* sampleResponder(request: ChatRequest, signal: AbortSignal): AsyncIterable<ChatStreamEvent> {
  const script = pickScript(request.prompt, request.attachments);
  const deep = request.model === "atlas-deep", swift = request.model === "atlas-swift";
  await sleep(swift ? 250 : 450, signal);
  if (script.thinking && !swift) {
    const words = script.thinking.split(" ");
    const size = deep ? 1 : 2;
    for (let index = 0; index < words.length; index += size) {
      yield { type: "thinking", text: (index ? " " : "") + words.slice(index, index + size).join(" ") };
      await sleep(deep ? 70 : 55, signal);
    }
    await sleep(300, signal);
  }
  for (const tool of script.tools ?? []) {
    yield { type: "tool", tool: { ...tool, status: "running" } };
    await sleep(swift ? 600 : 1100, signal);
    yield { type: "tool", tool: { ...tool, status: "done" } };
    await sleep(220, signal);
  }
  if (script.sources) yield { type: "sources", sources: script.sources };
  for (const chunk of chunkMarkdown(script.text)) {
    yield { type: "text", text: chunk };
    const long = chunk.length > 24;
    await sleep((swift ? 18 : 30) + (long ? 50 : Math.random() * 26), signal);
  }
}

const done = (answer: Omit<ChatAnswer, "status" | "model"> & { model?: string }): ChatAnswer => ({ model: "atlas", status: "done", ...answer });

export const sampleConversations: ChatConversation[] = [
  {
    id: "pricing-test",
    title: "Annual discount test",
    group: "Today",
    messages: [
      { id: "pricing-q", role: "user", text: "Summarize the annual discount test so far." },
      { id: "pricing-a", role: "assistant", current: 0, versions: [done({
        thoughtFor: 3,
        thinking: "Two weeks of data. Compare annual share, refunds, and revenue per visitor between control and the 20% discount.",
        text: `After 14 days, the 20% annual discount lifts annual plan share without hurting refunds.

| | Control | Discount |
| --- | --- | --- |
| Annual share | 29% | 38% |
| Refund requests | 1.2% | 1.1% |
| Revenue per visitor | $4.10 | $4.06 |

Revenue per visitor has not moved yet, because more people pick Starter. Offering the discount only on Team and above should keep the lift without the downgrade.`,
      })] },
    ],
  },
  {
    id: "checklist-copy",
    title: "Onboarding checklist copy",
    group: "Today",
    messages: [
      { id: "checklist-q", role: "user", text: "Make these onboarding steps shorter: connect your calendar so we can suggest meeting times, invite at least two teammates to your workspace, create your first project from a template." },
      { id: "checklist-a", role: "assistant", current: 0, versions: [done({
        model: "atlas-swift",
        text: `Here are shorter versions that still say what happens:

1. **Connect your calendar** to get suggested times
2. **Invite two teammates**
3. **Start a project** from a template

Each one starts with the action, so the list scans in a second.`,
      })] },
    ],
  },
  {
    id: "churn-interviews",
    title: "Churn interview themes",
    group: "Previous 7 days",
    messages: [
      { id: "churn-q", role: "user", text: "What came up most in the September churn interviews?" },
      { id: "churn-a", role: "assistant", current: 0, versions: [done({
        thoughtFor: 5,
        tools: [{ id: "read", kind: "read", running: "Reading interviews.md", done: "Read 14 interviews", status: "done", detail: "september-interviews.md" }],
        text: `Three themes came up across the 14 interviews.

- **Setup took longer than the trial.** Seven teams never connected their calendar.
- **Managers had no shared view**, so the tool stayed with one person.
- **Budget freezes** ended two accounts that would not have stayed at any price.

Fix setup first. Every team that finished it within two days is still paying.`,
      })] },
    ],
  },
  {
    id: "incident-review",
    title: "Status page incident draft",
    group: "Previous 7 days",
    messages: [
      { id: "incident-q", role: "user", text: "Draft a status update for the sync delay this morning." },
      { id: "incident-a", role: "assistant", current: 0, versions: [done({
        model: "atlas-swift",
        text: `**Resolved: delayed sync on mobile**

Between 8:12 and 8:47 AM Eastern, changes made on mobile took up to 20 minutes to appear on other devices. No data was lost. A queue worker stopped after a configuration change, and we have added an alert so a stalled queue pages the on call engineer within two minutes.`,
      })] },
    ],
  },
];
