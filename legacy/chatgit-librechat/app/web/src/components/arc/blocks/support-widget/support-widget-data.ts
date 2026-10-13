/** Sample help center content for the support widget. Replace with articles from your help center or CMS. */
export type Article = { id: string; title: string; category: string; minutes: number; updated: string; author: Person; summary: string; intro: string; steps: string[]; note: string; keywords: string };
export type Person = { name: string; src: string };

export const TEAM = {
  ava: { name: "Ava Mitchell", src: "/media/people/ava-mitchell.jpg" },
  marcus: { name: "Marcus Johnson", src: "/media/people/marcus-johnson.jpg" },
  sofia: { name: "Sofia Ramirez", src: "/media/people/sofia-ramirez.jpg" },
  emma: { name: "Emma Collins", src: "/media/people/emma-collins.jpg" },
  jasmine: { name: "Jasmine Brooks", src: "/media/people/jasmine-brooks.jpg" },
} satisfies Record<string, Person>;

export const ARTICLES: Article[] = [
  { id: "export-missing", title: "Why didn’t my scheduled export arrive?", category: "Troubleshooting", minutes: 2, updated: "Sep 18, 2026", author: TEAM.sofia, summary: "Check the run history, the recipient list, and your email provider’s spam filter.", intro: "Most missing exports come from a paused schedule, a changed data source, or a filter at the recipient’s email provider.", steps: ["Open Exports, then History, and find the run.", "If it says Paused, fix the error it shows and choose Resume.", "If it says Delivered, ask the recipient to check spam and allow exports@harbor.example.", "Choose Run now to send a fresh copy while you wait."], note: "History keeps 90 days of runs, with the file size and who received each copy.", keywords: "missing email failed paused not arrived spam csv pdf" },
  { id: "schedule-export", title: "Schedule a recurring export", category: "Exports", minutes: 3, updated: "Sep 12, 2026", author: TEAM.emma, summary: "Send any report as a CSV or PDF every day, week, or month.", intro: "Scheduled exports run in your workspace time zone and send a fresh copy of the report to everyone on the list.", steps: ["Open the report and choose Export, then Schedule.", "Pick CSV or PDF and how often it should run.", "Add recipients. People outside your workspace get a secure download link.", "Choose Save schedule. The first export runs at the next 6:00."], note: "An export that fails twice in a row pauses on its own, so nobody receives an empty file.", keywords: "csv pdf email send weekly daily monthly time zone report" },
  { id: "okta-sso", title: "Set up single sign-on with Okta", category: "Security", minutes: 5, updated: "Aug 30, 2026", author: TEAM.jasmine, summary: "Connect Okta over SAML 2.0 and require it for your whole workspace.", intro: "You need Owner access in Harbor and admin access in Okta. Setup takes about ten minutes.", steps: ["In Okta, add a SAML 2.0 app and paste Harbor’s ACS URL and entity ID.", "Download the Okta metadata XML file.", "In Harbor, open Settings, then Security, and upload the file under Single sign-on.", "Sign in once with your own account, then turn on Require SSO."], note: "Keep one owner on password sign-in until everyone has signed in with SSO at least once.", keywords: "sso saml login sign in okta identity security" },
  { id: "roles", title: "Invite teammates and choose roles", category: "Workspace", minutes: 2, updated: "Sep 4, 2026", author: TEAM.sofia, summary: "Owners, editors, and viewers, and what each of them can change.", intro: "Everyone you invite takes a seat, except viewers on the Growth and Scale plans.", steps: ["Open Settings, then Members, and choose Invite.", "Enter one or more email addresses.", "Pick a role: Owner, Editor, or Viewer.", "Choose Send invites. Invitations expire after 7 days."], note: "Only owners can change billing, security settings, or another owner’s role.", keywords: "invite seat seats member team permission viewer editor owner" },
  { id: "change-plan", title: "Change your plan or billing cycle", category: "Billing", minutes: 2, updated: "Sep 9, 2026", author: TEAM.emma, summary: "Upgrades are prorated right away. Downgrades take effect at renewal.", intro: "Any owner can change the plan. The new limits apply the moment an upgrade goes through.", steps: ["Open Settings, then Billing, and choose Change plan.", "Pick a plan and monthly or yearly billing.", "Review the prorated amount, then confirm."], note: "Yearly billing costs 20% less and keeps your price for twelve months.", keywords: "upgrade downgrade seats price yearly monthly subscription plan billing" },
  { id: "invoices", title: "Download invoices and receipts", category: "Billing", minutes: 1, updated: "Jul 22, 2026", author: TEAM.jasmine, summary: "Every invoice since your first payment, as a PDF you can forward.", intro: "Invoices are issued on your renewal date and show your VAT ID once you add it.", steps: ["Open Settings, then Billing, then Invoices.", "Choose Download next to any invoice.", "To have them sent automatically, add an address under Billing contacts."], note: "Need a different company name or address on past invoices? Ask us and we’ll reissue them.", keywords: "invoice receipt vat tax pdf billing" },
  { id: "postgres", title: "Connect a Postgres database", category: "Data sources", minutes: 4, updated: "Sep 15, 2026", author: TEAM.jasmine, summary: "Use read-only credentials, allow Harbor’s IP addresses, and keep SSL on.", intro: "Harbor only reads from your database, so a read-only user is all it needs.", steps: ["Create a read-only user for Harbor in your database.", "Allow connections from 34.120.18.7 and 34.120.18.9.", "In Harbor, open Data sources, choose Add, then Postgres, and enter the host and credentials.", "Keep Require SSL on and choose Test connection."], note: "When a password changes, update it here too. Exports that read from the source pause until you do.", keywords: "postgres database sql connection warehouse ssl ip password" },
  { id: "slow-dashboard", title: "Speed up a slow dashboard", category: "Troubleshooting", minutes: 3, updated: "Aug 26, 2026", author: TEAM.sofia, summary: "Cached queries, row limits, and when to split one dashboard into two.", intro: "A dashboard loads as fast as its slowest chart. Start by finding that one.", steps: ["Open the dashboard and choose Performance to see each chart’s query time.", "Turn on caching for charts that don’t need live data.", "Add a date filter so charts read fewer rows.", "Move charts slower than 5 seconds to a dashboard of their own."], note: "Dashboards with more than 25 charts load in pages of 10.", keywords: "slow performance cache loading speed dashboard" },
  { id: "public-link", title: "Share a dashboard with a public link", category: "Sharing", minutes: 2, updated: "Sep 2, 2026", author: TEAM.emma, summary: "Links can expire, ask for a password, and hide your filters.", intro: "Anyone with a public link can view the dashboard without a Harbor account.", steps: ["Open the dashboard and choose Share.", "Turn on Public link.", "Set an expiry date and, if you like, a password.", "Copy the link. You can turn it off at any time."], note: "Owners can turn off public links for the whole workspace under Settings, then Security.", keywords: "share link public password embed dashboard" },
  { id: "api-key", title: "Create and rotate API keys", category: "Developers", minutes: 3, updated: "Aug 19, 2026", author: TEAM.jasmine, summary: "Give each integration its own key and rotate it without downtime.", intro: "Keys belong to the workspace, not to a person, so they keep working when someone leaves.", steps: ["Open Settings, then API keys, and choose Create key.", "Name it after the integration and pick its scopes.", "Copy the secret now. It is shown only once.", "To rotate, create a new key, update the integration, then revoke the old one."], note: "Keys that haven’t been used for 90 days are flagged in the list.", keywords: "api key token secret developer rotate revoke integration" },
];

export const POPULAR = ["export-missing", "schedule-export", "okta-sso", "roles", "change-plan"];
export const SUGGESTIONS = ["Our Churned accounts export didn’t arrive", "Can we add two more seats?"];

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const tokensOf = (query: string) => Array.from(new Set(query.toLowerCase().split(/\s+/).filter(Boolean))).slice(0, 6);
export const matcherOf = (tokens: string[]) => tokens.length ? new RegExp(`(${tokens.map(escape).join("|")})`, "gi") : null;

/** Every word has to appear somewhere; title hits rank above summary hits, then the original order breaks ties. */
export function searchArticles(query: string) {
  const tokens = tokensOf(query);
  if (!tokens.length) return POPULAR.map(id => ARTICLES.find(article => article.id === id)!);
  return ARTICLES
    .map((article, index) => {
      const title = article.title.toLowerCase(), summary = article.summary.toLowerCase();
      const haystack = `${title} ${summary} ${article.category.toLowerCase()} ${article.keywords}`;
      if (!tokens.every(token => haystack.includes(token))) return null;
      const score = tokens.reduce((total, token) => total + (title.includes(token) ? 3 : 0) + (summary.includes(token) ? 1 : 0), 0);
      return { article, score, index };
    })
    .filter(hit => hit !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(hit => hit.article);
}

/** Canned replies keyed on what the person wrote. Every reply in the preview is simulated. */
export function replyTo(text: string) {
  const value = text.toLowerCase();
  if (/export|arrive|csv|pdf|report|churn/.test(value)) return "Found it. The Churned accounts export paused on Sep 21 because the Postgres password changed. Update it under Data sources and I’ll rerun the export for you.";
  if (/seat|plan|invite|billing|upgrade|invoice/.test(value)) return "You’re using 12 of 15 seats on Growth, so two more fit without changing plans. Invite them from Settings, then Members.";
  if (/sso|okta|saml|login|sign in/.test(value)) return "Happy to help with SSO. Send me the error from Okta’s sign-in log and I’ll check the SAML settings on our side.";
  if (/thank|great|perfect|works|worked/.test(value)) return "Anytime, Jordan. I’ll keep this thread open in case anything else comes up.";
  return "Thanks, Jordan. I’m looking at your workspace now and will reply here within a few minutes.";
}
export const greetingFor = (article?: Article) => article ? `Hi Jordan, I’m Ava. I have “${article.title}” open too, so we can pick up from there. What’s going on?` : "Hi Jordan, I’m Ava from Harbor support. What can I help with today?";
export const FOLLOW_UP = "No rush, Jordan. I’ll keep this conversation open, and my replies will wait for you here.";
