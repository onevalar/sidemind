import { avatar } from "../../lib/media";

/** Sample page and scripted answers for the AI side panel. Replace the script with your model's streamed output and tool calls. */

export type MilestoneStatus = "On track" | "At risk" | "In progress" | "Not started" | "Done";
export interface Owner { name: string; avatar?: string }
export interface Milestone { id: string; name: string; owner?: Owner; due: string; status: MilestoneStatus }
export interface PlanPage { title: string; project: string; status: "On track" | "At risk"; target: string; lead: Owner; intro: string; milestones: Milestone[]; notes: { id: string; title: string; body: string }[] }

export const owners = {
  chloe: { name: "Chloe Nguyen", avatar: avatar("chloe-nguyen") },
  daniel: { name: "Daniel Kim", avatar: avatar("daniel-kim") },
  marcus: { name: "Marcus Johnson", avatar: avatar("marcus-johnson") },
  ava: { name: "Ava Mitchell", avatar: avatar("ava-mitchell") },
  sofia: { name: "Sofia Ramirez", avatar: avatar("sofia-ramirez") },
  nathan: { name: "Nathan Cole", avatar: avatar("nathan-cole") },
  emma: { name: "Emma Collins", avatar: avatar("emma-collins") },
};

export const samplePage: PlanPage = {
  title: "Q4 launch plan",
  project: "Launch",
  status: "On track",
  target: "Oct 28",
  lead: owners.emma,
  intro: "Ship usage based billing to every workspace on October 28, with new pricing, a migration for existing plans, and a launch email to 42,000 admins.",
  milestones: [
    { id: "copy", name: "Pricing page copy", owner: owners.chloe, due: "Oct 3", status: "In progress" },
    { id: "security", name: "Security review", owner: owners.daniel, due: "Oct 10", status: "At risk" },
    { id: "migration", name: "Billing migration", owner: owners.marcus, due: "Oct 14", status: "On track" },
    { id: "email", name: "Launch email", due: "Oct 21", status: "Not started" },
    { id: "press", name: "Press briefing", owner: owners.sofia, due: "Oct 24", status: "Not started" },
    { id: "live", name: "Go live", owner: owners.nathan, due: "Oct 28", status: "Not started" },
  ],
  notes: [],
};

/** A change the assistant proposes. The block applies it to the page and highlights what changed. */
export type PageChange =
  | { kind: "milestone"; id: string; patch: Partial<Milestone> }
  | { kind: "status"; status: PlanPage["status"] }
  | { kind: "note"; id: string; title: string; body: string };
export interface SuggestedAction { id: string; label: string; detail: string; change: PageChange }
export interface ScriptedAnswer { text: string; actions: SuggestedAction[] }

export const prompts = ["What is at risk?", "Summarize this page", "Draft a status update"];

export function scriptedAnswer(question: string, focus: string[], page: PlanPage): ScriptedAnswer {
  const q = question.toLowerCase();
  const picked = page.milestones.filter(item => focus.includes(item.id));
  if (/risk|block|late|slip/.test(q)) return {
    text: "Two milestones could move the **Oct 28** date.\n\n- **Security review** is waiting on the pen test report, which lands Oct 13. The review cannot close by Oct 10.\n- **Launch email** has no owner and depends on final pricing copy.\n\nMoving the review four days still leaves a week of buffer before go live.",
    actions: [
      { id: "a-security", label: "Move Security review to Oct 14", detail: "Due Oct 10 to Oct 14, status On track", change: { kind: "milestone", id: "security", patch: { due: "Oct 14", status: "On track" } } },
      { id: "a-email", label: "Assign Launch email to Ava Mitchell", detail: "Owner none to Ava Mitchell", change: { kind: "milestone", id: "email", patch: { owner: owners.ava, status: "In progress" } } },
    ],
  };
  if (/summar|tl;?dr|overview/.test(q)) return {
    text: `**${page.title}** ships usage based billing on ${page.target}. ${page.milestones.filter(item => item.status === "Done" || item.status === "On track").length} of ${page.milestones.length} milestones are on track, pricing copy is in progress, and the security review is the one date under pressure. The launch email still needs an owner.`,
    actions: [{ id: "a-summary", label: "Add summary to the page", detail: "Inserts a summary block under the intro", change: { kind: "note", id: "summary", title: "Summary", body: "Ships usage based billing on Oct 28. Pricing copy in progress, security review under pressure, launch email needs an owner." } }],
  };
  if (/status|update|draft|weekly/.test(q)) return {
    text: "Here is a draft for this week:\n\n**Q4 launch, week 3.** Pricing copy is in review with Chloe. The billing migration dry run passed on staging with no failed invoices. The security review needs until Oct 14 because the pen test report arrives Oct 13. Go live stays on Oct 28.",
    actions: [
      { id: "a-update", label: "Insert update into the page", detail: "Adds a Weekly update block", change: { kind: "note", id: "update", title: "Weekly update", body: "Pricing copy is in review. Migration dry run passed on staging. Security review moves to Oct 14. Go live stays on Oct 28." } },
      { id: "a-status", label: "Set plan status to At risk", detail: "On track to At risk until the review closes", change: { kind: "status", status: "At risk" } },
    ],
  };
  if (picked.length) {
    const item = picked[0];
    return {
      text: `**${item.name}** is due ${item.due} and is ${item.status.toLowerCase()}${item.owner ? ` with ${item.owner.name}` : " without an owner"}. ${item.status === "At risk" ? "It is the milestone most likely to move the launch." : "Nothing on the page suggests it will slip."}`,
      actions: item.owner ? [] : [{ id: `a-own-${item.id}`, label: `Assign ${item.name} to you`, detail: "Owner none to Emma Collins", change: { kind: "milestone", id: item.id, patch: { owner: owners.emma } } }],
    };
  }
  return {
    text: `I read **${page.title}**. It has ${page.milestones.length} milestones leading to go live on ${page.target}. Ask what is at risk, for a summary, or for a status update, or select a milestone to ask about it.`,
    actions: [],
  };
}
