/** The built-in illustrations. Each one is a small, real piece of product UI that acts out its feature on hover. */
export type BentoVisual = "sync" | "command" | "chart" | "flow" | "permissions" | "history";

/** How much of the grid a cell takes on wide screens. `wide` spans two thirds, `tall` two rows, `half` half a row. */
export type BentoSize = "regular" | "wide" | "tall" | "half";

export interface BentoFeature {
  id: string;
  title: string;
  description: string;
  visual: BentoVisual;
  size?: BentoSize;
  /** Turns the title into a link that covers the whole cell. */
  href?: string;
}

export const bentoFeatures: BentoFeature[] = [
  { id: "sync", title: "Edit together in real time", description: "See who is in the doc, what they selected, and what they are typing.", visual: "sync", size: "wide" },
  { id: "command", title: "Everything is a keystroke away", description: "Jump to any page, person, or setting from one menu.", visual: "command", size: "tall" },
  { id: "insights", title: "Numbers that explain themselves", description: "Weekly trends land right next to the work that moved them.", visual: "chart" },
  { id: "automations", title: "Automations that run on their own", description: "Route new signups, enrich them, and tell the right channel.", visual: "flow" },
  { id: "permissions", title: "Access that fits your team", description: "Roles for every workspace, reviewed and changed in one place.", visual: "permissions", size: "half" },
  { id: "history", title: "Every version, one scrub away", description: "Rewind a page to any moment and bring back what you need.", visual: "history", size: "half" },
];

/** Sample content drawn inside the illustrations. */
export const bentoSamples = {
  doc: {
    title: "Q3 launch plan",
    lines: ["Ship onboarding by", "Pricing review with finance", "Draft the launch post"],
    selected: "Sept 30",
    typed: " for Tuesday",
  },
  commands: ["Invite people", "Invoices", "Integrations", "Insights", "Inbox"],
  chart: { label: "Weekly active", value: "12,480", delta: "+24%", bars: [38, 46, 42, 55, 51, 63, 60, 78] },
  flow: ["New signup", "Enrich company", "Post to #sales"],
  roles: [
    { name: "Admins", access: "Full access", on: true },
    { name: "Editors", access: "Can edit", on: true },
    { name: "Guests", access: "Can comment", on: false },
  ],
  history: { current: "Launch on September 30", past: "Launch in early October", times: ["9:02", "Now"], viewing: "Viewing 10:14" },
};
