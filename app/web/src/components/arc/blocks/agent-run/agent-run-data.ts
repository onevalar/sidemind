/**
 * The scripted run. Every step has a fixed length and token cost, so the whole run is a pure function of one clock:
 * pausing stops the clock, and the view derives what has streamed so far from where the clock stands.
 */

export type StepKind = "think" | "search" | "read" | "edit" | "test";

export type SearchHit = { file: string; line: number; text: string };
export type CodeLine = { n: number; text: string };
export type DiffLine = { kind: "same" | "add" | "remove"; n: number; text: string };
export type TestLine = { file: string; name: string; time: string };

type Base = {
  id: string;
  /** Title while the step runs, then once it has finished. */
  running: string;
  done: string;
  /** Milliseconds of run time. */
  duration: number;
  tokens: number;
};

export type Step =
  | (Base & { kind: "think"; text: string })
  | (Base & { kind: "search"; query: string; scope: string; hits: SearchHit[] })
  | (Base & { kind: "read"; path: string; lines: CodeLine[] })
  | (Base & { kind: "edit"; path: string; diff: DiffLine[] })
  | (Base & { kind: "test"; command: string; results: TestLine[]; passed: number });

export const REQUEST = {
  author: "Olivia Bennett",
  avatar: "/media/people/olivia-bennett.jpg",
  repo: "northwind/checkout",
  prompt: "Customers are being charged twice when the payment gateway times out. Find the cause in the retry logic, fix it, and make sure the payment tests pass.",
};

export const STEPS: Step[] = [
  {
    id: "plan", kind: "think", running: "Thinking", done: "Planned the investigation", duration: 2400, tokens: 420,
    text: "A double charge that only happens on timeouts points at the retry path. If each retry sends the gateway a fresh idempotency key, the gateway has no way to tell a retry from a new charge. I'll find where the key is created.",
  },
  {
    id: "search", kind: "search", running: "Searching the codebase", done: "Searched for idempotencyKey", duration: 1700, tokens: 910,
    query: "idempotencyKey", scope: "src/payments",
    hits: [
      { file: "retry.ts", line: 40, text: "const idempotencyKey = crypto.randomUUID();" },
      { file: "gateway.ts", line: 18, text: "headers[\"Idempotency-Key\"] = idempotencyKey;" },
      { file: "charge.test.ts", line: 73, text: "expect(gateway.charge).toHaveBeenCalledTimes(1);" },
    ],
  },
  {
    id: "read", kind: "read", running: "Reading retry.ts", done: "Read src/payments/retry.ts", duration: 1900, tokens: 2640,
    path: "src/payments/retry.ts",
    lines: [
      { n: 36, text: "export async function chargeWithRetry(order: Order, attempts = 3) {" },
      { n: 37, text: "  let lastError: unknown;" },
      { n: 38, text: "  for (let attempt = 1; attempt <= attempts; attempt++) {" },
      { n: 39, text: "    try {" },
      { n: 40, text: "      const idempotencyKey = crypto.randomUUID();" },
      { n: 41, text: "      return await gateway.charge(order, { idempotencyKey });" },
      { n: 42, text: "    } catch (error) {" },
      { n: 43, text: "      lastError = error;" },
      { n: 44, text: "      if (!isTimeout(error)) throw error;" },
      { n: 45, text: "      await sleep(backoff(attempt));" },
      { n: 46, text: "    }" },
      { n: 47, text: "  }" },
    ],
  },
  {
    id: "cause", kind: "think", running: "Thinking", done: "Found the cause", duration: 2100, tokens: 380,
    text: "Line 40 creates a new key inside the loop, so every attempt after a timeout looks like a brand-new charge. The key belongs to the order, not the attempt: create it once, before the loop, and reuse it.",
  },
  {
    id: "edit", kind: "edit", running: "Editing retry.ts", done: "Edited src/payments/retry.ts", duration: 1800, tokens: 1240,
    path: "src/payments/retry.ts",
    diff: [
      { kind: "same", n: 36, text: "export async function chargeWithRetry(order: Order, attempts = 3) {" },
      { kind: "add", n: 37, text: "  // One key per order, so the gateway drops a repeated charge." },
      { kind: "add", n: 38, text: "  const idempotencyKey = order.idempotencyKey ?? crypto.randomUUID();" },
      { kind: "same", n: 39, text: "  let lastError: unknown;" },
      { kind: "same", n: 40, text: "  for (let attempt = 1; attempt <= attempts; attempt++) {" },
      { kind: "same", n: 41, text: "    try {" },
      { kind: "remove", n: 40, text: "      const idempotencyKey = crypto.randomUUID();" },
      { kind: "same", n: 42, text: "      return await gateway.charge(order, { idempotencyKey });" },
    ],
  },
  {
    id: "test", kind: "test", running: "Running payment tests", done: "Ran payment tests", duration: 3300, tokens: 1680,
    command: "npm test -- src/payments", passed: 24,
    results: [
      { file: "charge.test.ts", name: "charges a new order once", time: "38 ms" },
      { file: "charge.test.ts", name: "reuses the key when the gateway times out", time: "412 ms" },
      { file: "charge.test.ts", name: "stops after three attempts", time: "1.2 s" },
      { file: "refund.test.ts", name: "refunds the captured amount", time: "22 ms" },
      { file: "webhook.test.ts", name: "ignores a duplicate charge.succeeded event", time: "17 ms" },
    ],
  },
  {
    id: "summary", kind: "think", running: "Writing the summary", done: "Wrote the summary", duration: 1500, tokens: 520,
    text: "The fix is one moved line and a comment. Every payment test passes, including the timeout retry case that now asserts a single charge.",
  },
];

/** When each step starts and ends on the run clock. */
export const TIMING = STEPS.reduce<{ start: number; end: number }[]>((all, step) => {
  const start = all.length ? all[all.length - 1].end : 0;
  return [...all, { start, end: start + step.duration }];
}, []);

export const TOTAL = TIMING[TIMING.length - 1].end;
export const GATE = STEPS.findIndex(step => step.kind === "edit");
export const GATE_END = TIMING[GATE].end;
export const TOTAL_TOKENS = STEPS.reduce((sum, step) => sum + step.tokens, 0);

export const RESULT = {
  title: "Retries reuse one idempotency key",
  body: "chargeWithRetry created a new key on every attempt, so a gateway timeout followed by a retry charged the card again. The key is now created once per order, and all 24 payment tests pass.",
  pr: 482,
};

/** Tokens spent by a clock position. Stepped to a third of a second so the counter rolls in beats instead of every frame. */
export function tokensAt(clock: number) {
  const t = Math.floor(clock / 300) * 300;
  return STEPS.reduce((sum, step, i) => {
    const { start, end } = TIMING[i];
    const part = Math.min(1, Math.max(0, (t - start) / (end - start)));
    return sum + Math.round(step.tokens * part);
  }, 0);
}

export const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
