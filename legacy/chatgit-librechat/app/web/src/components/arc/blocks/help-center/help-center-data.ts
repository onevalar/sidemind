/** Sample help content for the help center block. Replace with articles from your docs or support CMS. */

export type HelpIcon = "start" | "billing" | "team" | "integrations" | "security" | "troubleshooting";

export interface HelpCategory {
  id: string;
  name: string;
  description: string;
  icon: HelpIcon;
}

export interface HelpSection {
  id: string;
  heading: string;
  paragraphs: string[];
  /** Optional numbered steps shown after the paragraphs. */
  steps?: string[];
}

export interface HelpArticle {
  id: string;
  title: string;
  categoryId: string;
  summary: string;
  updated: string;
  minutes: number;
  popular?: boolean;
  sections: HelpSection[];
}

export const sampleCategories: HelpCategory[] = [
  { id: "start", name: "Getting started", description: "Set up your workspace and invite your team.", icon: "start" },
  { id: "billing", name: "Account and billing", description: "Plans, invoices, payment methods, and receipts.", icon: "billing" },
  { id: "team", name: "Workspaces and teams", description: "Roles, permissions, and guest access.", icon: "team" },
  { id: "integrations", name: "Integrations", description: "Connect Slack, GitHub, Google Drive, and more.", icon: "integrations" },
  { id: "security", name: "Security and privacy", description: "Single sign-on, two-factor, and data exports.", icon: "security" },
  { id: "troubleshooting", name: "Troubleshooting", description: "Fix sync issues, sign-in problems, and errors.", icon: "troubleshooting" },
];

export const sampleArticles: HelpArticle[] = [
  {
    id: "invite-teammates", title: "Invite teammates to your workspace", categoryId: "start", summary: "Send invites by email or share a link, and choose what each person can do.", updated: "Sep 18, 2026", minutes: 3, popular: true,
    sections: [
      { id: "before", heading: "Before you start", paragraphs: ["Only workspace owners and admins can invite people. Members can request an invite, and an admin approves it from Settings, then Members.", "Each invite uses a seat on paid plans. Guests do not use a seat and can only see the projects you share with them."] },
      { id: "email", heading: "Invite by email", paragraphs: ["Invites expire after 7 days. You can resend or revoke a pending invite at any time."], steps: ["Open Settings, then Members.", "Select Invite people and enter one or more email addresses.", "Choose a role for everyone on the list.", "Select Send invites."] },
      { id: "link", heading: "Share an invite link", paragraphs: ["An invite link lets anyone with an allowed email domain join as a member. Turn on the link under Settings, then Members, then Invite link, and add your company domain.", "Reset the link if it was shared somewhere it should not be. The old link stops working right away."] },
      { id: "roles", heading: "Choose the right role", paragraphs: ["Owners manage billing and can delete the workspace. Admins manage members and settings. Members create and edit projects. Guests only see what is shared with them.", "You can change someone's role later from the Members list."] },
    ],
  },
  {
    id: "update-payment", title: "Update your payment method", categoryId: "billing", summary: "Change the card on file or switch to invoice billing for annual plans.", updated: "Sep 2, 2026", minutes: 2, popular: true,
    sections: [
      { id: "card", heading: "Change the card on file", paragraphs: ["Your new card is charged from the next billing date. We never store full card numbers."], steps: ["Open Settings, then Billing.", "Select Update next to your current card.", "Enter the new card details and select Save."] },
      { id: "invoice", heading: "Pay by invoice", paragraphs: ["Annual plans with 20 seats or more can pay by bank transfer. Contact us from this page and we will switch your workspace to invoice billing within one business day."] },
      { id: "failed", heading: "If a payment fails", paragraphs: ["We retry a failed payment three times over 10 days and email the billing contact each time. Your workspace stays fully available while we retry."] },
    ],
  },
  {
    id: "download-invoices", title: "Download invoices and receipts", categoryId: "billing", summary: "Find every invoice in one place and add your company details.", updated: "Aug 27, 2026", minutes: 2, popular: true,
    sections: [
      { id: "find", heading: "Find your invoices", paragraphs: ["Every invoice is listed under Settings, then Billing, then Invoices. Select Download to save a PDF."] },
      { id: "details", heading: "Add company details", paragraphs: ["Add your legal company name, address, and VAT number under Billing details. They appear on every invoice from then on."] },
    ],
  },
  {
    id: "sso", title: "Set up single sign-on with SAML", categoryId: "security", summary: "Let your team sign in with Okta, Microsoft Entra ID, or Google Workspace.", updated: "Sep 20, 2026", minutes: 6, popular: true,
    sections: [
      { id: "requirements", heading: "Requirements", paragraphs: ["Single sign-on is available on the Business and Enterprise plans. You need to be a workspace owner and an admin in your identity provider.", "Verify your email domain first, under Settings, then Security, then Domains."] },
      { id: "configure", heading: "Configure your identity provider", paragraphs: ["Create a new SAML application in your identity provider and paste the values from Settings, then Security, then Single sign-on."], steps: ["Copy the ACS URL and Entity ID from Northwind.", "Paste them into a new SAML app in your provider.", "Map the email attribute to the user's primary email.", "Download the metadata XML from your provider."] },
      { id: "connect", heading: "Connect Northwind", paragraphs: ["Upload the metadata XML in Northwind and select Test connection. You will be asked to sign in through your provider once.", "When the test passes, choose whether single sign-on is optional or required for everyone on your domain."] },
      { id: "enforce", heading: "Enforce sign-in", paragraphs: ["When single sign-on is required, people with a verified domain email can only sign in through your provider. Owners keep a backup password so you never lock yourself out."] },
    ],
  },
  {
    id: "two-factor", title: "Turn on two-factor authentication", categoryId: "security", summary: "Protect your account with an authenticator app or a security key.", updated: "Jul 14, 2026", minutes: 3,
    sections: [
      { id: "app", heading: "Use an authenticator app", paragraphs: ["Open Account, then Security, and select Turn on two-factor. Scan the code with your authenticator app and enter the six digit code it shows."] },
      { id: "backup", heading: "Save your backup codes", paragraphs: ["Store your backup codes somewhere safe. Each code works once if you lose access to your phone."] },
    ],
  },
  {
    id: "connect-slack", title: "Connect Slack", categoryId: "integrations", summary: "Get project updates in a channel and create tasks from messages.", updated: "Sep 11, 2026", minutes: 4, popular: true,
    sections: [
      { id: "install", heading: "Install the app", paragraphs: ["Open Settings, then Integrations, and select Connect next to Slack. Sign in to Slack and choose the workspace to connect."] },
      { id: "channels", heading: "Send updates to a channel", paragraphs: ["In any project, open the menu and select Notifications. Pick a channel and the events you want to post, such as new tasks, comments, and status changes."] },
      { id: "tasks", heading: "Create tasks from messages", paragraphs: ["Hover a Slack message, open More actions, and select Create task. The message and a link back to it are added to the task."] },
    ],
  },
  {
    id: "github", title: "Link GitHub pull requests", categoryId: "integrations", summary: "Show pull request status on tasks and close them when code merges.", updated: "Aug 30, 2026", minutes: 3,
    sections: [
      { id: "connect", heading: "Connect a repository", paragraphs: ["Select Connect next to GitHub, install the Northwind app on your organization, and pick the repositories to share."] },
      { id: "link", heading: "Link a pull request", paragraphs: ["Add the task key, like WEB-214, to a branch name or pull request title. The task shows the pull request and its checks, and moves to Done when it merges."] },
    ],
  },
  {
    id: "roles", title: "Roles and permissions", categoryId: "team", summary: "What owners, admins, members, and guests can do.", updated: "Sep 5, 2026", minutes: 4,
    sections: [
      { id: "overview", heading: "Overview", paragraphs: ["Every person in a workspace has one role. Roles decide who can manage billing, invite people, and change settings."] },
      { id: "guests", heading: "Guests", paragraphs: ["Guests are ideal for clients and contractors. They only see the projects you share with them and cannot browse the rest of the workspace."] },
    ],
  },
  {
    id: "sync-issues", title: "Changes are not syncing", categoryId: "troubleshooting", summary: "What to check when edits do not appear for your teammates.", updated: "Sep 21, 2026", minutes: 3, popular: true,
    sections: [
      { id: "status", heading: "Check the connection", paragraphs: ["A small cloud icon in the sidebar shows your sync status. If it shows a slash, you are offline and changes are saved locally until you reconnect."] },
      { id: "refresh", heading: "Refresh and sign in again", paragraphs: ["Reload the page. If changes still do not appear, sign out and sign back in to refresh your session."] },
      { id: "extensions", heading: "Browser extensions", paragraphs: ["Ad blockers and privacy extensions can block the sync connection. Allow northwind.app in the extension, or try a private window to confirm."] },
    ],
  },
  {
    id: "reset-password", title: "Reset your password", categoryId: "troubleshooting", summary: "Get back into your account when you cannot sign in.", updated: "Jun 30, 2026", minutes: 1,
    sections: [
      { id: "reset", heading: "Send a reset link", paragraphs: ["On the sign-in page select Forgot password and enter your email. The link is valid for 30 minutes."] },
      { id: "sso", heading: "Signing in with single sign-on", paragraphs: ["If your company uses single sign-on, reset your password with your identity provider instead."] },
    ],
  },
  {
    id: "create-workspace", title: "Create your first workspace", categoryId: "start", summary: "Name your workspace, pick a URL, and set up your first project.", updated: "Sep 1, 2026", minutes: 2,
    sections: [
      { id: "create", heading: "Create the workspace", paragraphs: ["After you sign up, choose a name and a URL for your workspace. You can change both later in Settings."] },
      { id: "project", heading: "Start a project", paragraphs: ["Select New project, pick a template or start blank, and invite the people you work with."] },
    ],
  },
];
