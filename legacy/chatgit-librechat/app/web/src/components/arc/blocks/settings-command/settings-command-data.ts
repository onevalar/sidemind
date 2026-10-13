/** Sample workspace settings for the settings command block. Replace with your own schema and saved values. */

export type SettingsSectionId = "general" | "appearance" | "notifications" | "security" | "members" | "billing";
export type SettingOption = { value: string; label: string };
export type SettingValue = string | boolean;
export type SettingValues = Record<string, SettingValue>;

export type SettingsSection = { id: SettingsSectionId; label: string; description: string };

export type SettingDefinition = {
  id: string;
  section: SettingsSectionId;
  label: string;
  description: string;
  /** switch: on or off. segmented: two or three short options. select: a longer list. text: a single line. */
  kind: "switch" | "segmented" | "select" | "text";
  options?: SettingOption[];
  /** Extra words people search for, such as "2fa" for two-step verification. */
  keywords?: string[];
  placeholder?: string;
  prefix?: string;
};

export const settingsSections: SettingsSection[] = [
  { id: "general", label: "General", description: "Name, address, and regional defaults for Northwind Studio." },
  { id: "appearance", label: "Appearance", description: "How the app looks for you on this device." },
  { id: "notifications", label: "Notifications", description: "Choose what reaches you and how often." },
  { id: "security", label: "Security", description: "Sign in rules and session policy for everyone." },
  { id: "members", label: "Members", description: "Who can join and what new people can do." },
  { id: "billing", label: "Billing", description: "Where invoices go and how they are issued." },
];

const languages: SettingOption[] = [
  { value: "en-us", label: "English (US)" }, { value: "en-gb", label: "English (UK)" }, { value: "de", label: "Deutsch" },
  { value: "fr", label: "Français" }, { value: "pt", label: "Português" }, { value: "ja", label: "日本語" },
];
const timezones: SettingOption[] = [
  { value: "lisbon", label: "Lisbon (GMT+1)" }, { value: "london", label: "London (GMT+1)" }, { value: "berlin", label: "Berlin (GMT+2)" },
  { value: "new-york", label: "New York (GMT-4)" }, { value: "san-francisco", label: "San Francisco (GMT-7)" }, { value: "tokyo", label: "Tokyo (GMT+9)" },
];

export const settingDefinitions: SettingDefinition[] = [
  { id: "workspace-name", section: "general", label: "Workspace name", description: "Shown in the sidebar, invites, and emails.", kind: "text", keywords: ["title", "company", "rename"] },
  { id: "workspace-url", section: "general", label: "Workspace URL", description: "Changing it breaks old links for 30 days.", kind: "text", prefix: "arc.so/", keywords: ["slug", "address", "domain", "link"] },
  { id: "language", section: "general", label: "Language", description: "Used for dates, numbers, and interface text.", kind: "select", options: languages, keywords: ["locale", "translation", "english"] },
  { id: "timezone", section: "general", label: "Time zone", description: "Due dates and digests follow this zone.", kind: "select", options: timezones, keywords: ["timezone", "clock", "region", "utc", "gmt"] },
  { id: "week-start", section: "general", label: "Week starts on", description: "Affects calendars and weekly reports.", kind: "segmented", options: [{ value: "mon", label: "Monday" }, { value: "sun", label: "Sunday" }], keywords: ["calendar", "monday", "sunday"] },

  { id: "theme", section: "appearance", label: "Theme", description: "Match the system or pick one.", kind: "segmented", options: [{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }, { value: "system", label: "System" }], keywords: ["dark mode", "light mode", "color", "night"] },
  { id: "density", section: "appearance", label: "Density", description: "Compact fits more rows in lists and tables.", kind: "segmented", options: [{ value: "comfortable", label: "Comfortable" }, { value: "compact", label: "Compact" }], keywords: ["spacing", "rows", "dense"] },
  { id: "font-size", section: "appearance", label: "Text size", description: "Scales text across the app.", kind: "select", options: [{ value: "sm", label: "Small" }, { value: "md", label: "Default" }, { value: "lg", label: "Large" }], keywords: ["font", "zoom", "accessibility"] },
  { id: "sidebar-counts", section: "appearance", label: "Sidebar counts", description: "Show unread counts beside each view.", kind: "switch", keywords: ["badges", "numbers", "navigation"] },
  { id: "smooth-motion", section: "appearance", label: "Interface motion", description: "Turn off to swap movement for fades.", kind: "switch", keywords: ["animation", "reduce motion", "accessibility"] },

  { id: "mentions", section: "notifications", label: "Mentions", description: "When someone @mentions you or your team.", kind: "switch", keywords: ["at", "tag", "ping"] },
  { id: "assigned", section: "notifications", label: "Assigned to me", description: "New issues and reviews that land on you.", kind: "switch", keywords: ["assignee", "tasks", "review"] },
  { id: "deploy-failures", section: "notifications", label: "Failed deploys", description: "Builds that fail on a branch you own.", kind: "switch", keywords: ["ci", "build", "error", "release"] },
  { id: "weekly-digest", section: "notifications", label: "Weekly digest", description: "A Monday summary of what shipped.", kind: "switch", keywords: ["summary", "newsletter", "report"] },
  { id: "email-cadence", section: "notifications", label: "Email delivery", description: "Batch emails to cut down on noise.", kind: "select", options: [{ value: "instant", label: "Right away" }, { value: "hourly", label: "Hourly digest" }, { value: "daily", label: "Daily digest" }, { value: "never", label: "Never" }], keywords: ["frequency", "inbox", "batch", "digest"] },

  { id: "two-step", section: "security", label: "Require two-step sign in", description: "Everyone adds an authenticator app or key.", kind: "switch", keywords: ["2fa", "mfa", "otp", "authenticator", "passkey"] },
  { id: "saml", section: "security", label: "Enforce SAML single sign-on", description: "Members sign in through Okta only.", kind: "switch", keywords: ["sso", "okta", "identity", "login"] },
  { id: "session-length", section: "security", label: "Session length", description: "Idle people are signed out after this.", kind: "select", options: [{ value: "1h", label: "1 hour" }, { value: "8h", label: "8 hours" }, { value: "24h", label: "24 hours" }, { value: "7d", label: "7 days" }, { value: "30d", label: "30 days" }], keywords: ["timeout", "logout", "idle", "expire"] },
  { id: "ip-allowlist", section: "security", label: "IP allowlist", description: "Only office and VPN addresses can sign in.", kind: "switch", keywords: ["network", "firewall", "vpn", "ip address"] },
  { id: "audit-retention", section: "security", label: "Audit log retention", description: "How long sign ins and changes are kept.", kind: "select", options: [{ value: "90d", label: "90 days" }, { value: "1y", label: "1 year" }, { value: "2y", label: "2 years" }], keywords: ["history", "compliance", "logs", "soc 2"] },

  { id: "default-role", section: "members", label: "Default role", description: "Given to everyone who joins by invite link.", kind: "select", options: [{ value: "viewer", label: "Viewer" }, { value: "member", label: "Member" }, { value: "admin", label: "Admin" }], keywords: ["permissions", "access", "new members"] },
  { id: "invite-policy", section: "members", label: "Who can invite", description: "Admins approve requests from everyone else.", kind: "segmented", options: [{ value: "admins", label: "Admins" }, { value: "everyone", label: "Everyone" }], keywords: ["invitations", "permissions", "join"] },
  { id: "guests", section: "members", label: "Guest access", description: "Guests see only projects shared with them.", kind: "switch", keywords: ["external", "clients", "contractors"] },
  { id: "domains", section: "members", label: "Allowed email domains", description: "People with these addresses join without an invite.", kind: "text", placeholder: "example.com", keywords: ["domain", "auto join", "email"] },

  { id: "billing-email", section: "billing", label: "Billing email", description: "Receipts and payment alerts go here.", kind: "text", keywords: ["invoice", "finance", "receipt", "accounting"] },
  { id: "currency", section: "billing", label: "Invoice currency", description: "Applies from the next billing period.", kind: "select", options: [{ value: "eur", label: "Euro (EUR)" }, { value: "usd", label: "US dollar (USD)" }, { value: "gbp", label: "Pound sterling (GBP)" }, { value: "chf", label: "Swiss franc (CHF)" }], keywords: ["money", "euro", "dollar", "pricing"] },
  { id: "spend-alerts", section: "billing", label: "Spend alerts", description: "Email admins at 80% of the monthly budget.", kind: "switch", keywords: ["budget", "limit", "usage", "cost"] },
  { id: "tax-id", section: "billing", label: "VAT number", description: "Printed on every invoice.", kind: "text", placeholder: "PT 000 000 000", keywords: ["tax", "vat", "company", "invoice"] },
];

export const savedSettings: SettingValues = {
  "workspace-name": "Northwind Studio", "workspace-url": "northwind", language: "en-gb", timezone: "lisbon", "week-start": "mon",
  theme: "system", density: "comfortable", "font-size": "md", "sidebar-counts": true, "smooth-motion": true,
  mentions: true, assigned: true, "deploy-failures": true, "weekly-digest": false, "email-cadence": "hourly",
  "two-step": true, saml: false, "session-length": "24h", "ip-allowlist": false, "audit-retention": "1y",
  "default-role": "member", "invite-policy": "admins", guests: true, domains: "northwind.studio",
  "billing-email": "finance@northwind.studio", currency: "eur", "spend-alerts": true, "tax-id": "PT 516 283 947",
};

/** Shown before anything is typed: the settings people look for most. */
export const suggestedSettingIds = ["two-step", "theme", "billing-email", "session-length", "email-cadence"];
