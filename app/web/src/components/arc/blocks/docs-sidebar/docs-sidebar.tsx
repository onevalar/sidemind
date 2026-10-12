"use client";

import { Fragment, useCallback, useEffect, useEffectEvent, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactElement, ReactNode, RefObject } from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { AnimatePresence, LayoutGroup, animate, motion, useMotionValue, useReducedMotion, useTransform, type TargetAndTransition } from "motion/react";
import { Boxes, Check, ChevronDown, ChevronLeft, ChevronRight, Code, CreditCard, Info, Menu, Rocket, TableOfContents, TriangleAlert, Webhook, X, type LucideIcon } from "lucide-react";
import { Avatar } from "../../avatar/avatar";
import { Badge } from "../../badge/badge";
import { Button } from "../../button/button";
import { CodeBlock } from "../../code-block/code-block";
import { CopyButton } from "../../copy-button/copy-button";
import { DropdownMenu } from "../../dropdown-menu/dropdown-menu";
import { SearchField } from "../../search-field/search-field";
import { motionTokens } from "../../lib/motion-tokens";
import styles from "./docs-sidebar.module.css";

type Version = "4.12" | "4.11" | "3.9";
type Author = "ava" | "emma" | "marcus" | "jasmine" | "sofia";
type Section = { id: string; title: string; text: string[]; steps?: string[]; code?: { code: string; file?: string; language: string }; note?: string };
type Page = { id: string; title: string; lede: string; author: Author; updated: string; since?: Version; until?: Version; sections: Section[] };
type Group = { id: string; title: string; icon: LucideIcon; pages: Page[] };
type Result = { page: Page; heading?: Section };
type Jump = { page: string; section?: string; key: number };

const people: Record<Author, { name: string; photo: string }> = {
  ava: { name: "Ava Mitchell", photo: "/media/people/ava-mitchell.jpg" },
  emma: { name: "Emma Collins", photo: "/media/people/emma-collins.jpg" },
  marcus: { name: "Marcus Johnson", photo: "/media/people/marcus-johnson.jpg" },
  jasmine: { name: "Jasmine Brooks", photo: "/media/people/jasmine-brooks.jpg" },
  sofia: { name: "Sofia Ramirez", photo: "/media/people/sofia-ramirez.jpg" },
};

const latest: Version = "4.12";
const versions: { id: Version; label: string }[] = [{ id: "4.12", label: "v4.12 (latest)" }, { id: "4.11", label: "v4.11" }, { id: "3.9", label: "v3.9 (legacy)" }];
const rank: Record<Version, number> = { "3.9": 1, "4.11": 2, "4.12": 3 };

const groups: Group[] = [
  { id: "start", title: "Getting started", icon: Rocket, pages: [
    { id: "introduction", title: "Introduction", author: "emma", updated: "Aug 4, 2026", lede: "Halden is a commerce API for catalogs, orders, and payments. Every object is a REST resource with a predictable URL and a JSON response.", sections: [
      { id: "base-url", title: "Base URL", text: ["All requests go to `https://api.halden.example/v4` over HTTPS. Calls over plain HTTP are refused rather than redirected, so a leaked key never travels unencrypted."] },
      { id: "modes", title: "Test and live mode", text: ["Every account has a sandbox. Keys that start with `sk_test_` only touch test data, so you can build and demo a full checkout without moving money."] },
    ] },
    { id: "quickstart", title: "Quickstart", author: "marcus", updated: "Sep 9, 2026", lede: "Make your first request in about five minutes: create a key, install the SDK, and list your products.", sections: [
      { id: "create-key", title: "Create an API key", text: ["Open Developers → API keys and choose Create secret key. Copy it right away, because Halden shows a secret key only once."] },
      { id: "install", title: "Install the SDK", text: ["The Node SDK supports Node 18 and later. The Python and Go clients use the same method names."], code: { code: "npm install @halden/node", language: "bash" } },
      { id: "first-request", title: "Make your first request", text: ["Lists come back newest first, with a cursor you pass as `starting_after` to fetch the next page."], code: { file: "list-products.ts", language: "ts", code: `import { Halden } from "@halden/node";\n\nconst halden = new Halden(process.env.HALDEN_SECRET_KEY!);\nconst products = await halden.products.list({ limit: 3 });\n\nconsole.log(products.data.map((product) => product.name));` } },
      { id: "go-live", title: "Go live", text: ["Swap your `sk_test_` key for an `sk_live_` key and register a production webhook endpoint. Nothing else in your code changes."] },
    ] },
    { id: "authentication", title: "Authentication", author: "jasmine", updated: "Aug 26, 2026", lede: "Authenticate every request with a secret key in the Authorization header.", sections: [
      { id: "key-types", title: "Secret and publishable keys", text: ["Secret keys can read and write everything in your account and must stay on your server. Publishable keys start with `pk_` and can only create checkout sessions from the browser."] },
      { id: "send", title: "Send the key", text: ["Pass the key as a bearer token. Requests without a valid key return 401 with the code `invalid_api_key`."], code: { language: "bash", code: `curl https://api.halden.example/v4/orders \\\n  -H "Authorization: Bearer sk_test_51Hq2Lx8vYc"` } },
      { id: "restricted", title: "Restricted keys", text: ["Give each service only what it needs. A restricted key for your warehouse can read orders and update inventory, and nothing else."] },
      { id: "rotate", title: "Rotate a key", text: ["Rolling a key issues a new one and keeps the old key valid for up to 7 days, so you can deploy the change without downtime."] },
    ] },
    { id: "rate-limits", title: "Rate limits", author: "jasmine", updated: "Jul 30, 2026", lede: "Each live key can make 100 read and 50 write requests per second.", sections: [
      { id: "429", title: "Handle 429 responses", text: ["Over the limit, the API answers with 429 and a `Retry-After` header in seconds. Wait that long, then retry with the same idempotency key."] },
      { id: "headroom", title: "Watch your headroom", text: ["Every response carries `RateLimit-Remaining` and `RateLimit-Reset`, so a busy import can slow down before it reaches the limit."] },
    ] },
  ] },
  { id: "resources", title: "Resources", icon: Boxes, pages: [
    { id: "products", title: "Products", author: "sofia", updated: "Sep 2, 2026", lede: "A product is something you sell, with a variant for each size, color, or material.", sections: [
      { id: "variants", title: "Variants and prices", text: ["Each variant has its own SKU, stock count, and a price in every currency you sell in."] },
      { id: "archive", title: "Archive instead of delete", text: ["Products that appear on past orders can't be deleted. Archive them to hide them from your storefront and keep order history intact."] },
    ] },
    { id: "orders", title: "Orders", author: "marcus", updated: "Aug 21, 2026", lede: "An order records what a customer bought, what they paid, and where it ships.", sections: [
      { id: "lifecycle", title: "Order lifecycle", text: ["Orders move from `pending` to `paid`, `fulfilled`, and `delivered`. A refund can happen at any point after payment."] },
      { id: "expand", title: "Expand related objects", text: ["Pass `expand[]=customer` to receive the full customer in the same response instead of an ID."] },
    ] },
    { id: "customers", title: "Customers", author: "sofia", updated: "Jul 14, 2026", lede: "Customers keep contact details, saved addresses, and payment methods for returning buyers.", sections: [
      { id: "find", title: "Find a customer", text: ["Search by email with `GET /v4/customers?email=`. Matching is exact and ignores case."] },
      { id: "erase", title: "Erase personal data", text: ["Erasing a customer removes their personal data within 30 days. Their past orders keep only the country and totals."] },
    ] },
  ] },
  { id: "payments", title: "Payments", icon: CreditCard, pages: [
    { id: "payment-intents", title: "Payment intents", author: "emma", updated: "Sep 11, 2026", since: "4.11", lede: "A payment intent tracks one attempt to collect money, from authorization to capture.", sections: [
      { id: "confirm", title: "Confirm on the client", text: ["Create the intent on your server, then confirm it in the browser with its client secret. If the bank asks for authentication, it happens in between."] },
      { id: "capture", title: "Capture later", text: ["Set `capture_method` to `manual` to hold funds and capture when the order ships. Uncaptured authorizations expire after 7 days."] },
    ] },
    { id: "charges", title: "Charges", author: "emma", updated: "Mar 3, 2026", until: "3.9", lede: "In v3, a charge moves money in one step and can't pause for bank authentication.", sections: [
      { id: "move", title: "Move to payment intents", text: ["Charges keep working in v3.9. New integrations should use payment intents, which handle bank authentication without extra code."] },
      { id: "refund-charge", title: "Refund a charge", text: ["Refunds use the same `/refunds` endpoint. Pass `charge` instead of `payment_intent`."] },
    ] },
    { id: "refunds", title: "Refunds", author: "ava", updated: "Aug 18, 2026", lede: "Refund all or part of a payment. Money returns to the original payment method in 5 to 10 business days.", sections: [
      { id: "partial", title: "Partial refunds", text: ["Pass an `amount` in the smallest currency unit. You can issue several partial refunds until the payment is fully refunded."] },
      { id: "reasons", title: "Refund reasons", text: ["Set `reason` to `duplicate`, `fraudulent`, or `requested_by_customer`. Fraudulent refunds also block the card for future payments."] },
    ] },
    { id: "disputes", title: "Disputes", author: "ava", updated: "Sep 18, 2026", since: "4.12", lede: "When a customer disputes a payment with their bank, Halden opens a dispute and holds the amount.", sections: [
      { id: "evidence", title: "Submit evidence", text: ["Upload receipts, shipping confirmation, and customer messages before the due date. You can submit once, so send everything together."] },
      { id: "outcomes", title: "Dispute outcomes", text: ["Banks usually decide within 60 to 75 days. A won dispute returns the held amount and the dispute fee."] },
    ] },
  ] },
  { id: "webhooks", title: "Webhooks", icon: Webhook, pages: [
    { id: "webhooks-overview", title: "Overview", author: "marcus", updated: "Sep 2, 2026", lede: "Webhooks tell your server when something happens in your account, such as a paid order or a new refund.", sections: [
      { id: "register", title: "Register an endpoint", text: ["Add an HTTPS URL under Developers → Webhooks and choose the events it should receive. Each endpoint gets its own signing secret."] },
      { id: "respond", title: "Respond quickly", text: ["Return a 2xx status within 10 seconds, then do slow work in a background job. Slow responses count as failures and are retried."] },
    ] },
    { id: "verify-signatures", title: "Verify signatures", author: "ava", updated: "Sep 18, 2026", lede: "Every webhook request is signed, so you can confirm it came from Halden and wasn't changed on the way.", sections: [
      { id: "how", title: "How signing works", text: ["Each request carries a `Halden-Signature` header with a timestamp and an HMAC-SHA256 signature. The signature covers the timestamp and the raw request body, computed with your endpoint's signing secret."], code: { file: "Request header", language: "http", code: "Halden-Signature: t=1758451200,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd" } },
      { id: "secret", title: "Find your signing secret", text: ["Each endpoint has its own secret that starts with `whsec_`. You'll find it under Developers → Webhooks, in the endpoint's details.", "Rolling a secret keeps the previous one valid for 24 hours, so events sent during a deploy still verify."] },
      { id: "sdk", title: "Verify with the SDK", text: ["Pass the raw body, not parsed JSON. Parsing and serializing again changes the whitespace, and the signature no longer matches."], code: { file: "app/webhooks/route.ts", language: "ts", code: `import { verifyWebhook } from "@halden/node";\n\nconst secret = process.env.HALDEN_WEBHOOK_SECRET!;\n\nexport async function POST(request: Request) {\n  const body = await request.text();\n  const event = verifyWebhook(body, request.headers, secret);\n\n  if (event.type === "order.paid") await fulfil(event.data.order);\n  return new Response(null, { status: 204 });\n}` }, note: "Test locally with `halden listen --forward-to localhost:3000/webhooks`. The CLI signs each event with a temporary secret it prints on start." },
      { id: "manual", title: "Verify without the SDK", text: ["If there's no SDK for your language, verification takes four steps."], steps: ["Split the header on commas and read `t` and `v1`.", "Join `t`, a period, and the raw body into one string.", "Compute an HMAC-SHA256 of that string with your signing secret.", "Compare the result with `v1`."] },
      { id: "constant-time", title: "Compare signatures in constant time", text: ["Use `timingSafeEqual` or your language's equivalent. A plain string comparison stops at the first byte that differs, which can reveal how much of a forged signature was right."], code: { file: "verify.ts", language: "ts", code: `import { createHmac, timingSafeEqual } from "node:crypto";\n\nconst expected = createHmac("sha256", secret).update(\`\${t}.\${body}\`).digest();\nconst valid = timingSafeEqual(expected, Buffer.from(v1, "hex"));` } },
      { id: "replay", title: "Reject old events", text: ["Refuse requests whose timestamp is more than 5 minutes old, so a captured request can't be replayed later. The SDKs use a 300 second tolerance; pass `tolerance` to change it."] },
    ] },
    { id: "retries", title: "Retries and backoff", author: "marcus", updated: "Sep 4, 2026", lede: "If your endpoint doesn't answer with a 2xx status, Halden retries with growing delays for up to 72 hours.", sections: [
      { id: "schedule", title: "Retry schedule", text: ["Each attempt carries the same event ID and a fresh signature timestamp."], steps: ["After 1 minute", "After 5 minutes", "After 30 minutes", "After 2 hours", "Then every 8 hours until 72 hours have passed"] },
      { id: "idempotent", title: "Make handlers idempotent", text: ["Store each event ID once you've handled it and skip duplicates. Retries and network timeouts can deliver the same event twice."], code: { file: "handle-event.ts", language: "ts", code: `if (await db.events.has(event.id)) return new Response(null, { status: 200 });\n\nawait handle(event);\nawait db.events.add(event.id);` } },
      { id: "disabled", title: "Disabled endpoints", text: ["An endpoint that fails every attempt for 3 days is turned off, and the account owner gets an email. Fix the endpoint, then turn it back on."] },
      { id: "replay-missed", title: "Replay missed events", text: ["Open the endpoint in the dashboard, filter by failed, and choose Resend. Replays are signed with the current secret."] },
    ] },
    { id: "event-types", title: "Event types", author: "sofia", updated: "Aug 12, 2026", since: "4.11", lede: "Every event has a type in the form resource.action, like `order.paid` or `refund.created`.", sections: [
      { id: "order-events", title: "Order events", text: ["`order.created`, `order.paid`, `order.fulfilled`, and `order.cancelled` cover the full order lifecycle."] },
      { id: "wildcards", title: "Subscribe with wildcards", text: ["Use `order.*` to receive every order event, including ones added in later versions."] },
    ] },
  ] },
  { id: "sdks", title: "SDKs", icon: Code, pages: [
    { id: "node", title: "Node.js", author: "jasmine", updated: "Sep 16, 2026", lede: "The official Node client is written in TypeScript, with full types for every resource.", sections: [
      { id: "node-install", title: "Install", text: ["Supports Node 18 and later, Bun, and Deno."], code: { code: "npm install @halden/node", language: "bash" } },
      { id: "node-retries", title: "Network retries", text: ["The client retries failed network calls twice with backoff. Set `maxNetworkRetries` to change it."] },
    ] },
    { id: "python", title: "Python", author: "emma", updated: "Aug 29, 2026", lede: "A typed client for Python 3.9 and later, with sync and async interfaces.", sections: [
      { id: "python-install", title: "Install", text: ["Wheels are published for every supported Python version."], code: { code: "pip install halden", language: "bash" } },
      { id: "python-async", title: "Async client", text: ["Import `AsyncHalden` to call the same methods with `await` inside asyncio applications."] },
    ] },
    { id: "go", title: "Go", author: "marcus", updated: "Sep 18, 2026", since: "4.12", lede: "A Go module with context support on every call and typed errors you can match with `errors.As`.", sections: [
      { id: "go-install", title: "Install", text: ["Requires Go 1.22 or later."], code: { code: "go get github.com/halden/halden-go/v4", language: "bash" } },
      { id: "go-errors", title: "Handle errors", text: ["API errors return `*halden.Error` with the HTTP status, a code like `card_declined`, and the request ID for support."] },
    ] },
  ] },
];

const allPages = groups.flatMap(group => group.pages);
const pageById = new Map(allPages.map(page => [page.id, page]));
const groupByPage = new Map(groups.flatMap(group => group.pages.map(page => [page.id, group] as const)));

const inVersion = (page: Page, version: Version) => (!page.since || rank[version] >= rank[page.since]) && (!page.until || rank[version] <= rank[page.until]);

/** Pages whose title (or group title) matches come back whole; otherwise the first matching heading is attached to its page. */
function search(version: Version, query: string) {
  return groups.flatMap(group => {
    const pages = group.pages.filter(page => inVersion(page, version));
    if (!query) return [{ group, results: pages.map((page): Result => ({ page })) }];
    const groupHit = group.title.toLowerCase().includes(query);
    const results = pages.flatMap((page): Result[] => {
      if (groupHit || page.title.toLowerCase().includes(query)) return [{ page }];
      const heading = page.sections.find(section => section.title.toLowerCase().includes(query));
      return heading ? [{ page, heading }] : [];
    });
    return results.length ? [{ group, results }] : [];
  });
}

const still = { duration: 0 } as const;
const blur = (px: number) => `blur(${px}px)`;
const soft = { duration: motionTokens.duration.standard, ease: [...motionTokens.ease.enter] } as const;
const folded: TargetAndTransition = { height: 0, opacity: 0, overflow: "hidden" };
const unfold: TargetAndTransition = { height: "auto", opacity: 1, transitionEnd: { overflow: "visible" }, transition: { height: motionTokens.spring.smooth, opacity: { duration: .22, delay: .04, ease: [...motionTokens.ease.standard] } } };
const fold: TargetAndTransition = { ...folded, transition: { height: motionTokens.spring.smooth, opacity: { duration: .14, ease: [...motionTokens.ease.standard] } } };
const unfoldStill: TargetAndTransition = { height: "auto", opacity: 1, transitionEnd: { overflow: "visible" }, transition: still };
const foldStill: TargetAndTransition = { ...folded, transition: still };
/** Height springs open and closed. Overflow is clipped only while moving, so the shared highlight can glide across rows. */
const foldProps = (reduce: boolean | null) => ({ initial: folded, animate: reduce ? unfoldStill : unfold, exit: reduce ? foldStill : fold });
const swapIn: TargetAndTransition = { opacity: 0, y: "0.35em", filter: blur(motionTokens.blur.soft) };
const swapOut: TargetAndTransition = { opacity: 0, y: "-0.35em", filter: blur(motionTokens.blur.subtle), transition: { duration: .14, ease: [...motionTokens.ease.standard] } };
const swapShown: TargetAndTransition = { opacity: 1, y: "0em", filter: blur(0) };

/** Rail width in px. The open width is the --full custom property, which the container queries set. */
const RAIL = 64;
/** At or below this width the tree folds into a menu under the header, and the rail does not apply. Matches the container query in the CSS. */
const PHONE = 479;
/** Below this width the navigation starts as the icon rail so the article keeps room to read. It can still be opened. */
const ROOMY = 900;
/** The phone drawer parks this far past its edge, so its floating shadow never shows on the block's edge. */
const DRAWER_PARK = 64;

/** The width follows one value from 0 (rail) to 1 (open) on the smooth spring, so the article reflows every frame instead of jumping. */
function useRailWidth(rail: boolean, reduce: boolean) {
  const open = useMotionValue(rail ? 0 : 1);
  const width = useTransform(open, value => `calc(${RAIL}px + (var(--full) - ${RAIL}px) * ${value})`);
  useEffect(() => {
    const target = rail ? 0 : 1;
    if (reduce) { open.jump(target); return; }
    const controls = animate(open, target, motionTokens.spring.smooth);
    return () => controls.stop();
  }, [rail, reduce, open]);
  return width;
}

/**
 * One value drives the phone drawer from 0 (parked off the left edge) to 1 (open) on the smooth spring, and the scrim
 * fades with it, so a quick open and close reverses mid-flight with its velocity. Outside phones it rests at 1.
 */
function useDrawer(phone: boolean, open: boolean, reduce: boolean) {
  const progress = useMotionValue(phone ? 0 : 1);
  const x = useTransform(progress, value => value >= 1 ? "0px" : `calc(${(value - 1) * 100}% - ${(1 - value) * DRAWER_PARK}px)`);
  const wasPhone = useRef(phone);
  useEffect(() => {
    const target = phone && !open ? 0 : 1;
    const crossed = wasPhone.current !== phone;
    wasPhone.current = phone;
    // Crossing the breakpoint changes the form, not the state, so it never animates.
    if (reduce || crossed || !phone) { progress.jump(target); return; }
    const controls = animate(progress, target, motionTokens.spring.smooth);
    return () => controls.stop();
  }, [phone, open, reduce, progress]);
  return { progress, x };
}

/** [ toggles the rail while the block is on screen. It stays out of text fields, menus, and dialogs. */
function useRailShortcut(frame: RefObject<HTMLElement | null>, onToggle: () => void) {
  const handle = useEffectEvent((event: globalThis.KeyboardEvent) => {
    if (event.key !== "[" || event.repeat || event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
    const node = frame.current;
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (!node || (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.closest('[role="menu"], [role="dialog"]')))) return;
    const box = node.getBoundingClientRect();
    if (!box.width || box.bottom < 0 || box.top > window.innerHeight) return;
    event.preventDefault();
    onToggle();
  });
  useEffect(() => {
    const listener = (event: globalThis.KeyboardEvent) => handle(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
}

/** In the rail every item names itself on hover and focus. Opening the rail disarms any open tip. */
function RailTip({ enabled = true, label, note, shortcut, side = "right", children }: { enabled?: boolean; label: string; note?: string; shortcut?: string; side?: "right" | "bottom"; children: ReactElement }) {
  const [open, setOpen] = useState(false);
  if (!enabled && open) setOpen(false);
  return <TooltipPrimitive.Root open={enabled && open} onOpenChange={next => setOpen(next && enabled)}>
    <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content className={styles.tip} side={side} sideOffset={side === "right" ? 14 : 8} collisionPadding={8}>{label}{note && <span className={styles.tipNote}>{note}</span>}{shortcut && <kbd>{shortcut}</kbd>}</TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  </TooltipPrimitive.Root>;
}

/** The divider in the panel icon slides with the sidebar, so the control shows what it is about to do. */
function PanelGlyph({ collapsed, reduce }: { collapsed: boolean; reduce: boolean }) {
  return <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
    <rect x="2.75" y="3.75" width="14.5" height="12.5" rx="3.5" />
    <motion.path d="M8.25 4.25v11.5" initial={false} animate={{ x: collapsed ? -2.5 : 0 }} transition={reduce ? still : motionTokens.spring.smooth} />
  </svg>;
}

/** Backticks mark inline code in the sample copy. */
function Rich({ text }: { text: string }) {
  return <>{text.split("`").map((part, index) => index % 2 ? <code key={index} className={styles.inlineCode}>{part}</code> : <Fragment key={index}>{part}</Fragment>)}</>;
}

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const lower = text.toLowerCase();
  const parts: ReactNode[] = [];
  let from = 0;
  for (let at = lower.indexOf(query); at !== -1; at = lower.indexOf(query, from)) {
    if (at > from) parts.push(text.slice(from, at));
    parts.push(<mark key={at}>{text.slice(at, at + query.length)}</mark>);
    from = at + query.length;
  }
  if (from < text.length) parts.push(text.slice(from));
  return <>{parts}</>;
}

/** Springs its height to follow content that changes size, instead of snapping in a single frame. */
function FitHeight({ children, className }: { children: ReactNode; className?: string }) {
  const reduce = useReducedMotion();
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const height = useMotionValue<number | "auto">("auto");
  useLayoutEffect(() => {
    const box = outer.current;
    const content = inner.current;
    if (!box || !content) return;
    let last = content.offsetHeight;
    let width = content.offsetWidth;
    const observer = new ResizeObserver(() => {
      const next = content.offsetHeight;
      const resized = content.offsetWidth !== width;
      width = content.offsetWidth;
      if (next === last) return;
      const current = height.get();
      const from = typeof current === "number" ? current : last;
      last = next;
      if (reduce || resized) { height.jump("auto"); return; }
      box.style.height = `${from}px`;
      animate(height, [from, next], { ...motionTokens.spring.smooth, onComplete: () => height.jump("auto") });
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [height, reduce]);
  return <motion.div ref={outer} className={className} style={{ height, overflow: "clip" }}><div ref={inner} className={styles.fitInner}>{children}</div></motion.div>;
}

type NavProps = { id: string; version: Version; activeId: string; expanded: ReadonlySet<string>; rail: boolean; toggle: ReactNode; onExpand: () => void; onToggle: (groupId: string, open: boolean) => void; onOpen: (pageId: string, section?: string) => void };

function DocsNav({ id, version, activeId, expanded, rail, toggle, onExpand, onToggle, onOpen }: NavProps) {
  const reduce = useReducedMotion();
  const layoutGroup = useId();
  const [query, setQuery] = useState("");
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());
  const navRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const q = query.trim().toLowerCase();
  const found = useMemo(() => search(version, q), [version, q]);
  const count = found.reduce((total, entry) => total + entry.results.length, 0);

  // Keep the current page in view when it changes from the article, e.g. through next and previous.
  useEffect(() => {
    const nav = navRef.current;
    const row = nav?.querySelector<HTMLElement>(`[data-page="${activeId}"]`);
    if (!nav || !row) return;
    const top = row.getBoundingClientRect().top - nav.getBoundingClientRect().top;
    if (top < 8 || top + 40 > nav.clientHeight) nav.scrollTo({ top: nav.scrollTop + top - nav.clientHeight / 3, behavior: reduce ? "auto" : "smooth" });
  }, [activeId, reduce]);

  function changeQuery(value: string) {
    setQuery(value);
    setClosed(new Set());
  }

  function setGroup(groupId: string, open: boolean) {
    // In the rail a group has nowhere to open, so the sidebar widens to reveal it.
    if (rail) {
      if (!open) return;
      onExpand();
    }
    if (!q) return onToggle(groupId, open);
    setClosed(current => {
      const next = new Set(current);
      if (open) next.delete(groupId); else next.add(groupId);
      return next;
    });
  }

  const items = () => Array.from(navRef.current?.querySelectorAll<HTMLButtonElement>("[data-nav-item]") ?? []);

  function onNavKey(event: KeyboardEvent<HTMLElement>) {
    const list = items();
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    if (index === -1) return;
    const groupId = list[index].dataset.group;
    if (groupId && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
      event.preventDefault();
      setGroup(groupId, event.key === "ArrowRight");
      return;
    }
    const target = event.key === "ArrowDown" ? list[index + 1] : event.key === "ArrowUp" ? list[index - 1] ?? searchRef.current : event.key === "Home" ? list[0] : event.key === "End" ? list[list.length - 1] : undefined;
    if (!target) return;
    event.preventDefault();
    target.focus();
  }

  function onSearchKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape" && query) {
      event.preventDefault();
      changeQuery("");
    } else if (event.key === "Enter" && q) {
      const first = found[0]?.results[0];
      if (!first) return;
      event.preventDefault();
      onOpen(first.page.id, first.heading?.id);
    } else if (event.key === "ArrowDown") {
      const first = items()[0];
      if (!first) return;
      event.preventDefault();
      first.focus();
    }
  }

  return <div className={styles.navInner}>
    {/* The toggle rides the sidebar's edge, so it settles on the rail's icon axis as the width closes. */}
    <div className={styles.searchRow}>
      <div className={styles.searchClip} data-rail-hidden="" inert={rail}>
        <div className={styles.search}>
          <SearchField ref={searchRef} label="Search docs" placeholder="Search docs" value={query} onValueChange={changeQuery} onKeyDown={onSearchKey} aria-controls={`${id}-tree`} autoComplete="off" spellCheck={false} />
        </div>
      </div>
      {toggle}
    </div>
    <motion.nav ref={navRef} id={`${id}-tree`} className={styles.nav} aria-label="Documentation" layoutScroll onKeyDown={onNavKey}>
      <LayoutGroup id={layoutGroup}>
        <AnimatePresence initial={false}>
          {found.map(({ group, results }) => {
            // The rail shows each group as its icon, with its pages folded away and the current page's group lit.
            const open = !rail && (q ? !closed.has(group.id) : expanded.has(group.id));
            const current = results.find(result => result.page.id === activeId)?.page;
            const holdsActive = !open && !!current;
            const lit = rail && !!current;
            const GroupIcon = group.icon;
            return <motion.div key={group.id} className={styles.group} {...foldProps(reduce)}>
              <div className={styles.groupInner}>
                <RailTip enabled={rail} label={group.title} note={current?.title}>
                  <button type="button" className={styles.groupButton} data-nav-item data-group={group.id} data-lit={lit || undefined} data-holds={holdsActive || undefined} aria-expanded={open} aria-controls={open ? `${id}-${group.id}` : undefined} onClick={() => setGroup(group.id, !open)}>
                    {lit && <motion.span layoutId="docs-active-page" className={styles.groupHighlight} style={{ borderRadius: 8 }} transition={reduce ? still : motionTokens.spring.morph} aria-hidden="true" />}
                    <GroupIcon className={styles.groupIcon} size={16} strokeWidth={1.75} aria-hidden="true" />
                    <span className={styles.groupLabel}><Highlight text={group.title} query={q} /></span>
                    {holdsActive && <span className={styles.activeDot}><span className={styles.srOnly}>Contains the current page</span></span>}
                    <ChevronRight className={styles.chevron} size={14} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                </RailTip>
                <AnimatePresence initial={false}>
                  {open && <motion.div key="pages" {...foldProps(reduce)}>
                    <ul id={`${id}-${group.id}`} className={styles.pages}>
                      <AnimatePresence initial={false}>
                        {results.map(({ page, heading }) => {
                          const active = page.id === activeId;
                          return <motion.li key={page.id} {...foldProps(reduce)}>
                            <button type="button" className={styles.page} data-nav-item data-page={page.id} aria-current={active ? "page" : undefined} onClick={() => onOpen(page.id, heading?.id)}>
                              {active && !rail && <motion.span layoutId="docs-active-page" className={styles.pageHighlight} style={{ borderRadius: 8 }} transition={reduce ? still : motionTokens.spring.morph} aria-hidden="true" />}
                              <span className={styles.pageText}>
                                <span className={styles.pageTitle}><Highlight text={page.title} query={q} /></span>
                                {heading && <span className={styles.pageHeading}><Highlight text={heading.title} query={q} /></span>}
                              </span>
                              {page.since === latest && version === latest && <span className={styles.pageTag}><Badge size="sm" tone="info">New</Badge></span>}
                            </button>
                          </motion.li>;
                        })}
                      </AnimatePresence>
                    </ul>
                  </motion.div>}
                </AnimatePresence>
              </div>
            </motion.div>;
          })}
        </AnimatePresence>
      </LayoutGroup>
      <AnimatePresence initial={false}>
        {q && count === 0 && <motion.div key="empty" className={styles.empty} data-rail-hidden="" inert={rail} initial={{ opacity: 0, y: 6, filter: blur(motionTokens.blur.subtle) }} animate={{ opacity: 1, y: 0, filter: blur(0) }} exit={{ opacity: 0, transition: { duration: reduce ? 0 : motionTokens.duration.instant } }} transition={reduce ? still : { ...soft, delay: .08 }}>
          <div className={styles.emptyBody}>
            <p>No pages match “{query.trim()}”</p>
            <span>Check the spelling, or try a broader word like orders or refunds.</span>
            <Button type="button" variant="secondary" size="sm" onClick={() => { changeQuery(""); searchRef.current?.focus(); }}>Clear search</Button>
          </div>
        </motion.div>}
      </AnimatePresence>
    </motion.nav>
    <p className={styles.srOnly} role="status" aria-live="polite">{q ? count ? `${count} ${count === 1 ? "page matches" : "pages match"} ${query.trim()}` : `No pages match ${query.trim()}` : ""}</p>
  </div>;
}

type ReaderProps = { id: string; page: Page; group: Group; version: Version; fallback: string | null; prev?: Page; next?: Page; jump: Jump | null; covered: boolean; onOpen: (pageId: string) => void; onVersion: (version: Version) => void };

function DocsReader({ id, page, group, version, fallback, prev, next, jump, covered, onOpen, onVersion }: ReaderProps) {
  const reduce = useReducedMotion();
  const [spy, setSpy] = useState({ page: page.id, section: page.sections[0].id });
  const [outlineOpen, setOutlineOpen] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const outlineBody = useRef<HTMLDivElement>(null);
  const sectionNodes = useRef(new Map<string, HTMLElement>());
  const locked = useRef(false);
  const unlockTimer = useRef(0);
  const frame = useRef(0);
  const placed = useRef(false);
  const markY = useMotionValue(0);
  const markHeight = useMotionValue(0);
  const activeSection = spy.page === page.id ? spy.section : page.sections[0].id;
  const current = page.sections.find(section => section.id === activeSection) ?? page.sections[0];
  const author = people[page.author];
  const legacy = version === "3.9";
  const banner = version === latest ? fallback : [fallback, legacy ? "v3.9 is a legacy version and gets security fixes until March 31, 2027." : "You're reading v4.11. Version 4.12 adds disputes and the Go SDK."].filter(Boolean).join(" ");

  useEffect(() => () => { window.clearTimeout(unlockTimer.current); cancelAnimationFrame(frame.current); }, []);

  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
    locked.current = false;
  }, [page.id]);

  /** The active section is the last one whose top has passed a reading line near the top of the article. */
  const measure = useCallback(() => {
    const node = scroller.current;
    if (!node || locked.current) return;
    const origin = node.getBoundingClientRect().top;
    const line = Math.min(120, node.clientHeight * .3);
    let nextSection = page.sections[0].id;
    for (const section of page.sections) {
      const element = sectionNodes.current.get(`${page.id}:${section.id}`);
      if (element && element.getBoundingClientRect().top - origin <= line) nextSection = section.id;
    }
    if (node.scrollHeight - node.clientHeight > 8 && node.scrollTop + node.clientHeight >= node.scrollHeight - 8) nextSection = page.sections[page.sections.length - 1].id;
    setSpy(state => state.page === page.id && state.section === nextSection ? state : { page: page.id, section: nextSection });
  }, [page]);

  /** A chosen section wins until the scroll it started comes to rest, so the indicator travels once instead of stepping through every heading. */
  const goTo = useCallback((sectionId: string | undefined, smooth: boolean, focus: boolean) => {
    const node = scroller.current;
    if (!node) return;
    const target = sectionId ? sectionNodes.current.get(`${page.id}:${sectionId}`) : undefined;
    const top = target ? target.getBoundingClientRect().top - node.getBoundingClientRect().top + node.scrollTop : 0;
    setSpy({ page: page.id, section: sectionId ?? page.sections[0].id });
    locked.current = true;
    window.clearTimeout(unlockTimer.current);
    unlockTimer.current = window.setTimeout(() => { locked.current = false; }, 180);
    node.scrollTo({ top: Math.max(0, top), behavior: smooth && !reduce ? "smooth" : "auto" });
    if (focus) target?.querySelector<HTMLElement>("h3")?.focus({ preventScroll: true });
  }, [page, reduce]);

  useEffect(() => {
    if (!jump || jump.page !== page.id) return;
    const handle = requestAnimationFrame(() => goTo(jump.section, !jump.section, false));
    return () => cancelAnimationFrame(handle);
  }, [jump, page.id, goTo]);

  // The outline indicator glides to the active link and takes its height, so a two line title stretches it.
  useLayoutEffect(() => {
    const body = outlineBody.current;
    if (!body) return;
    let width = body.offsetWidth;
    const place = (glide: boolean) => {
      const link = body.querySelector<HTMLElement>(`[data-section="${page.id}:${activeSection}"]`);
      if (!link) return;
      if (!glide || !placed.current || reduce) {
        markY.jump(link.offsetTop);
        markHeight.jump(link.offsetHeight);
        placed.current = true;
        return;
      }
      animate(markY, link.offsetTop, motionTokens.spring.morph);
      animate(markHeight, link.offsetHeight, motionTokens.spring.morph);
    };
    place(true);
    const observer = new ResizeObserver(() => {
      if (body.offsetWidth === width) return;
      width = body.offsetWidth;
      place(false);
    });
    observer.observe(body);
    return () => observer.disconnect();
  }, [page.id, activeSection, reduce, markY, markHeight]);

  function onScroll() {
    if (locked.current) {
      window.clearTimeout(unlockTimer.current);
      unlockTimer.current = window.setTimeout(() => { locked.current = false; }, 140);
      return;
    }
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(measure);
  }

  const release = () => { locked.current = false; };

  return <div className={styles.main} inert={covered}>
    <div className={styles.outline}>
      <button type="button" className={styles.outlineToggle} aria-expanded={outlineOpen} aria-controls={`${id}-outline`} aria-label={`On this page, ${current.title}`} onClick={() => setOutlineOpen(open => !open)}>
        <TableOfContents size={16} strokeWidth={1.75} aria-hidden="true" />
        <span className={styles.togglePrefix} aria-hidden="true">On this page</span>
        <span className={styles.currentSection} aria-hidden="true">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span key={`${page.id}:${current.id}`} initial={swapIn} animate={swapShown} exit={reduce ? { opacity: 0, transition: still } : swapOut} transition={reduce ? still : soft}>{current.title}</motion.span>
          </AnimatePresence>
        </span>
        <ChevronDown className={styles.toggleChevron} size={16} strokeWidth={1.75} aria-hidden="true" />
      </button>
      <div id={`${id}-outline`} className={styles.outlinePanel} data-open={outlineOpen}>
        <nav className={styles.outlineNav} aria-label="On this page">
          <p className={styles.outlineTitle} aria-hidden="true">On this page</p>
          <div ref={outlineBody} className={styles.outlineBody}>
            <motion.span className={styles.indicator} style={{ y: markY, height: markHeight }} aria-hidden="true" />
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.ol key={page.id} className={styles.outlineList} initial={{ opacity: 0, filter: blur(motionTokens.blur.subtle) }} animate={{ opacity: 1, filter: blur(0) }} exit={{ opacity: 0, transition: { duration: reduce ? 0 : .1 } }} transition={reduce ? still : soft}>
                {page.sections.map(section => <li key={section.id}>
                  <a href={`#${id}-${page.id}-${section.id}`} data-section={`${page.id}:${section.id}`} aria-current={section.id === activeSection ? "location" : undefined} onClick={event => { event.preventDefault(); setOutlineOpen(false); goTo(section.id, true, true); }}>{section.title}</a>
                </li>)}
              </motion.ol>
            </AnimatePresence>
          </div>
        </nav>
      </div>
    </div>

    <AnimatePresence initial={false}>
      {banner && <motion.div key="banner" className={styles.bannerWrap} {...foldProps(reduce)}>
        <div className={styles.banner} data-tone={legacy ? "warning" : "info"}>
          <span className={styles.bannerIcon} aria-hidden="true">
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span key={legacy ? "warning" : "info"} initial={{ opacity: 0, scale: .6, filter: blur(motionTokens.blur.subtle) }} animate={{ opacity: 1, scale: 1, filter: blur(0) }} exit={{ opacity: 0, scale: .6, transition: { duration: reduce ? 0 : motionTokens.duration.instant } }} transition={reduce ? still : motionTokens.spring.snappy}>{legacy ? <TriangleAlert size={16} strokeWidth={1.75} /> : <Info size={16} strokeWidth={1.75} />}</motion.span>
            </AnimatePresence>
          </span>
          <FitHeight className={styles.bannerText}>
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.p key={banner} initial={swapIn} animate={swapShown} exit={reduce ? { opacity: 0, transition: still } : swapOut} transition={reduce ? still : soft}>{banner}</motion.p>
            </AnimatePresence>
          </FitHeight>
          {version !== latest && <Button type="button" variant="secondary" size="sm" onClick={() => onVersion(latest)}>Use v{latest}</Button>}
        </div>
      </motion.div>}
    </AnimatePresence>

    <div ref={scroller} className={styles.scroller} onScroll={onScroll} onWheel={release} onTouchStart={release}>

      <AnimatePresence mode="popLayout" initial={false}>
        <motion.article key={page.id} className={styles.article} aria-labelledby={`${id}-${page.id}-title`} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: { duration: reduce ? 0 : .1 } }} transition={reduce ? still : { duration: .36, ease: [...motionTokens.ease.enter] }}>
          <motion.h2 id={`${id}-${page.id}-title`} tabIndex={-1} initial={{ filter: blur(motionTokens.blur.soft) }} animate={{ filter: blur(0) }} transition={reduce ? still : soft}>{page.title}</motion.h2>
          <p className={styles.lede}><Rich text={page.lede} /></p>
          <div className={styles.byline}>
            <Avatar name={author.name} src={author.photo} size="sm" />
            <span className={styles.bylineText}><strong>{author.name}</strong><span>Updated {page.updated}</span></span>
            <CopyButton value={`https://docs.halden.example/v${version}/${group.id}/${page.id}`} label="Copy link" variant="plain" />
          </div>
          {page.sections.map(section => <section key={section.id} className={styles.section} aria-labelledby={`${id}-${page.id}-${section.id}`} ref={node => { const key = `${page.id}:${section.id}`; if (node) sectionNodes.current.set(key, node); else sectionNodes.current.delete(key); }}>
            <h3 id={`${id}-${page.id}-${section.id}`} tabIndex={-1}>{section.title}</h3>
            {section.text.map(paragraph => <p key={paragraph}><Rich text={paragraph} /></p>)}
            {section.steps && <ol className={styles.steps}>{section.steps.map(step => <li key={step}><Rich text={step} /></li>)}</ol>}
            {section.code && <div className={styles.code}><CodeBlock code={section.code.code} filename={section.code.file} language={section.code.language} /></div>}
            {section.note && <aside className={styles.note}><Info size={16} strokeWidth={1.75} aria-hidden="true" /><p><Rich text={section.note} /></p></aside>}
          </section>)}
          <nav className={styles.pager} aria-label="Previous and next page">
            {prev ? <button type="button" className={styles.pagerLink} onClick={() => onOpen(prev.id)}><span><ChevronLeft size={14} strokeWidth={1.75} aria-hidden="true" />Previous</span><strong>{prev.title}</strong></button> : <span />}
            {next && <button type="button" className={`${styles.pagerLink} ${styles.pagerNext}`} onClick={() => onOpen(next.id)}><span>Next<ChevronRight size={14} strokeWidth={1.75} aria-hidden="true" /></span><strong>{next.title}</strong></button>}
          </nav>
        </motion.article>
      </AnimatePresence>
    </div>
  </div>;
}

export interface DocsSidebarProps {
  /** Start with the navigation collapsed to its icon rail. The sidebar is expanded by default. */
  defaultCollapsed?: boolean;
  /** Called when the navigation collapses to its icon rail or expands again, from the toggle or the [ shortcut. */
  onCollapsedChange?: (collapsed: boolean) => void;
}

export function DocsSidebar({ defaultCollapsed = false, onCollapsedChange }: DocsSidebarProps) {
  const id = useId();
  const prefersReduced = useReducedMotion();
  // The first measurement settles the layout before paint, so it never animates.
  const [settling, setSettling] = useState(true);
  const reduce = prefersReduced || settling;
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  // On phones the tree is a menu under the header, so the rail steps aside until the layout is wide again.
  const [phone, setPhone] = useState(false);
  const rail = collapsed && !phone;
  const width = useRailWidth(rail, !!reduce);
  const frameRef = useRef<HTMLElement>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const [version, setVersion] = useState<Version>(latest);
  const [pageId, setPageId] = useState("verify-signatures");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(["start", "webhooks"]));
  const [menuOpen, setMenuOpen] = useState(false);
  const drawerOpen = phone && menuOpen;
  const drawer = useDrawer(phone, drawerOpen, !!reduce);
  const panelRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const [jump, setJump] = useState<Jump | null>(null);
  const [fallback, setFallback] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const jumps = useRef(0);
  const page = pageById.get(pageId) ?? allPages[0];
  const group = groupByPage.get(page.id) ?? groups[0];
  const visible = useMemo(() => allPages.filter(item => inVersion(item, version)), [version]);
  const index = visible.findIndex(item => item.id === page.id);

  function reveal(groupId: string) {
    setExpanded(current => current.has(groupId) ? current : new Set(current).add(groupId));
  }

  function open(nextId: string, section?: string) {
    const target = pageById.get(nextId);
    if (!target) return;
    const wasMenuOpen = menuOpen;
    jumps.current += 1;
    setPageId(nextId);
    setJump({ page: nextId, section, key: jumps.current });
    setFallback(null);
    reveal(groupByPage.get(nextId)?.id ?? "");
    setMenuOpen(false);
    setStatus(`${target.title}${section ? `, ${target.sections.find(item => item.id === section)?.title ?? ""}` : ""}`);
    if (wasMenuOpen) requestAnimationFrame(() => document.getElementById(`${id}-${nextId}-title`)?.focus({ preventScroll: true }));
  }

  // A mid-width frame starts on the rail; crossing the threshold later folds or opens it once.
  const roomy = useRef<boolean | null>(null);
  useLayoutEffect(() => {
    const node = frameRef.current;
    if (!node) return;
    const fit = () => {
      const size = node.clientWidth;
      setPhone(size <= PHONE);
      // The drawer is a phone form; widening the layout puts the tree back beside the article, closed.
      if (size > PHONE) setMenuOpen(false);
      const next = size >= ROOMY;
      if (roomy.current === next) return;
      const first = roomy.current === null;
      roomy.current = next;
      if (!first || !next) setCollapsed(!next);
    };
    fit();
    const settle = requestAnimationFrame(() => setSettling(false));
    const observer = new ResizeObserver(fit);
    observer.observe(node);
    return () => { observer.disconnect(); cancelAnimationFrame(settle); };
  }, []);

  function setRail(next: boolean) {
    if (next === collapsed) return;
    // Focus never stays behind in a part of the sidebar the rail hides: a page hands it to its group, anything else to the toggle.
    const active = document.activeElement;
    if (next && active instanceof HTMLElement && sidebarRef.current?.contains(active)) {
      const pageGroup = active.dataset.page ? groupByPage.get(active.dataset.page)?.id : undefined;
      if (pageGroup) sidebarRef.current.querySelector<HTMLElement>(`[data-group="${pageGroup}"]`)?.focus();
      else if (active.closest("[data-rail-hidden]")) toggleRef.current?.focus();
    }
    setCollapsed(next);
    setStatus(next ? "Sidebar collapsed" : "Sidebar expanded");
    onCollapsedChange?.(next);
  }
  useRailShortcut(frameRef, () => { if (!phone) setRail(!collapsed); });

  function closeDrawer(restoreFocus: boolean) {
    setMenuOpen(false);
    if (restoreFocus) menuButtonRef.current?.focus({ preventScroll: true });
  }

  // Opening the drawer hands focus to the current page, so arrow keys and Tab start where the reader is.
  useEffect(() => {
    if (!drawerOpen) return;
    const handle = requestAnimationFrame(() => {
      const panel = panelRef.current;
      (panel?.querySelector<HTMLElement>('[aria-current="page"]') ?? panel?.querySelector<HTMLElement>("[data-nav-item]"))?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(handle);
  }, [drawerOpen]);

  // Escape closes the drawer, after the search field has had its turn to clear a query and outside any open menu.
  const onDrawerKey = useEffectEvent((event: globalThis.KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    const layer = target?.closest('[role="menu"], [role="dialog"]');
    if (layer && layer !== panelRef.current) return;
    event.preventDefault();
    closeDrawer(true);
  });
  useEffect(() => {
    if (!drawerOpen) return;
    const listener = (event: globalThis.KeyboardEvent) => onDrawerKey(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [drawerOpen]);

  function toggle(groupId: string, openGroup: boolean) {
    setExpanded(current => {
      const next = new Set(current);
      if (openGroup) next.add(groupId); else next.delete(groupId);
      return next;
    });
  }

  function chooseVersion(nextVersion: Version) {
    if (nextVersion === version) return;
    setVersion(nextVersion);
    if (inVersion(page, nextVersion)) {
      setFallback(null);
      setStatus(`Showing v${nextVersion}`);
      return;
    }
    const replacement = group.pages.find(item => inVersion(item, nextVersion)) ?? allPages.find(item => inVersion(item, nextVersion)) ?? allPages[0];
    const note = `${page.title} isn't part of v${nextVersion}, so you're on ${replacement.title}.`;
    setPageId(replacement.id);
    setJump(null);
    setFallback(note);
    setStatus(`Showing v${nextVersion}. ${note}`);
  }

  const railToggle = <RailTip label={collapsed ? "Expand sidebar" : "Collapse sidebar"} shortcut="[" side={rail ? "right" : "bottom"}>
    <button ref={toggleRef} type="button" className={styles.railToggle} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-expanded={!collapsed} aria-keyshortcuts="[" onClick={() => setRail(!collapsed)}><PanelGlyph collapsed={rail} reduce={!!reduce} /></button>
  </RailTip>;

  return <TooltipPrimitive.Provider delayDuration={250} skipDelayDuration={300}>
    <section ref={frameRef} className={styles.docs} aria-label="Halden API documentation">
      <div className={styles.frame}>
        <motion.div ref={sidebarRef} className={styles.sidebar} style={{ width }} data-rail={rail || undefined}>
          {/* The brand row has no rail form, so it folds up and the toggle takes the top of the rail. */}
          <motion.div className={styles.brand} data-rail-hidden="" inert={rail} initial={false} animate={{ height: rail ? 8 : 52 }} transition={reduce ? still : motionTokens.spring.smooth}>
            <span className={styles.wordmark}>Halden <span>docs</span></span>
            <div className={styles.brandActions}>
              <div role="group" aria-label="Documentation version">
                <DropdownMenu label={`v${version}`} items={versions.map(item => ({ label: item.label, icon: item.id === version ? <Check size={15} strokeWidth={1.75} /> : <span className={styles.menuSpacer} />, onSelect: () => chooseVersion(item.id) }))} />
              </div>
              <button ref={menuButtonRef} type="button" className={styles.menuButton} aria-label={menuOpen ? "Close documentation menu" : "Documentation menu"} aria-expanded={menuOpen} aria-controls={`${id}-panel`} onClick={() => setMenuOpen(value => !value)}>
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.span key={menuOpen ? "close" : "open"} className={styles.menuIcon} initial={{ opacity: 0, scale: .6, filter: blur(motionTokens.blur.subtle) }} animate={{ opacity: 1, scale: 1, filter: blur(0) }} exit={{ opacity: 0, scale: .6, filter: blur(motionTokens.blur.subtle), transition: { duration: reduce ? 0 : motionTokens.duration.instant } }} transition={reduce ? still : motionTokens.spring.snappy}>{menuOpen ? <X size={18} strokeWidth={1.75} aria-hidden="true" /> : <Menu size={18} strokeWidth={1.75} aria-hidden="true" />}</motion.span>
                </AnimatePresence>
              </button>
            </div>
          </motion.div>
          {/* On phones the tree is an off-canvas drawer under the header; elsewhere it is the sidebar's body. */}
          <motion.div ref={panelRef} id={`${id}-panel`} className={styles.navPanel} style={{ x: drawer.x }} data-open={drawerOpen || undefined} inert={phone && !menuOpen} role={phone ? "dialog" : undefined} aria-modal={drawerOpen || undefined} aria-label={phone ? "Documentation menu" : undefined}>
            <DocsNav id={id} version={version} activeId={page.id} expanded={expanded} rail={rail} toggle={railToggle} onExpand={() => setRail(false)} onToggle={toggle} onOpen={open} />
          </motion.div>
        </motion.div>
        <motion.div className={styles.scrim} style={{ opacity: drawer.progress }} data-open={drawerOpen || undefined} aria-hidden="true" onClick={() => closeDrawer(true)} />
        <DocsReader id={id} page={page} group={group} version={version} fallback={fallback} prev={visible[index - 1]} next={index === -1 ? undefined : visible[index + 1]} jump={jump} covered={drawerOpen} onOpen={open} onVersion={chooseVersion} />
      </div>
      <p className={styles.srOnly} role="status" aria-live="polite">{status}</p>
    </section>
  </TooltipPrimitive.Provider>;
}

export default DocsSidebar;
