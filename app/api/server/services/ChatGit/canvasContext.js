/**
 * ChatGit canvas context orchestration (pure, no I/O).
 *
 * A node is one Q&A turn. `parentIds` are its context sources: one parent continues a
 * branch, several parents merge branches. The model sees the union of all ancestor
 * turns, ordered by creation, each shared ancestor exactly once. Sibling branches that
 * were not selected never appear.
 *
 * Long paths are compressed: the newest turns and every direct source stay verbatim;
 * older turns are replaced by their stored summary when one exists. A turn without a
 * summary is never dropped — it is sent verbatim — so compression only ever substitutes
 * text the summarizer already produced.
 */

const LIMITS = Object.freeze({
  maxParents: 12,
  maxItems: 20,
  maxQuestionChars: 8000,
  maxQuoteChars: 1500,
  maxNodesInContext: 400,
});

/** Newest turns kept verbatim regardless of length. */
const RAW_TURNS = 3;
/** Above this many characters of history, older turns switch to their summaries. */
const COMPRESS_ABOVE_CHARS = 12000;

const SYSTEM_PROMPT = [
  'You are ChatGit, a research assistant used for learning and exploring ideas.',
  'The conversation is a branching canvas: the history you receive is exactly the path the user chose; other branches are intentionally hidden.',
  'Answer in the language the user writes in. Use Markdown: short paragraphs, "###" headings, "-" or "1." lists and **bold** for key terms. Avoid tables and HTML.',
  'When the user quotes a passage, focus your answer on that passage in the context of where it appeared.',
].join('\n');

function questionText(node) {
  const parts = [];
  for (const item of node.items ?? []) {
    const q = (item.q ?? '').trim() || '请解释这段内容。';
    parts.push(`我引用了上文中的这段内容：\n"""\n${item.quote}\n"""\n${q}`);
  }
  if (node.question?.trim()) {
    parts.push(node.question.trim());
  }
  if (node.files?.length) {
    for (const file of node.files) {
      if (file.text) {
        parts.push(`附件「${file.filename}」：\n"""\n${file.text}\n"""`);
      }
    }
  }
  return parts.join('\n\n');
}

/** Ancestors of the given sources (inclusive), ordered by creation, each once. */
function collectPath(nodesById, sourceIds) {
  const seen = new Set();
  const stack = [...sourceIds];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) {
      continue;
    }
    const node = nodesById.get(id);
    if (!node) {
      throw new CanvasContextError(`unknown source ${id}`);
    }
    seen.add(id);
    if (seen.size > LIMITS.maxNodesInContext) {
      throw new CanvasContextError('context too large');
    }
    stack.push(...(node.parentIds ?? []));
  }
  return [...seen]
    .map((id) => nodesById.get(id))
    .sort((a, b) => order(a) - order(b) || String(a.id).localeCompare(String(b.id)));
}

function order(node) {
  return new Date(node.createdAt ?? 0).getTime();
}

class CanvasContextError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CanvasContextError';
    this.status = 400;
  }
}

/**
 * Decide, per turn, whether it is sent verbatim or as its summary.
 * @returns {{ node, mode: 'raw' | 'summary' }[]}
 */
function planTurns(path, directSources) {
  const total = path.reduce((sum, n) => sum + questionText(n).length + (n.answer ?? '').length, 0);
  const compress = total > COMPRESS_ABOVE_CHARS;
  return path.map((node, index) => {
    const recent = index >= path.length - RAW_TURNS;
    const keep = recent || directSources.has(node.id) || !compress || !node.summary;
    return { node, mode: keep ? 'raw' : 'summary' };
  });
}

/**
 * Build the provider-neutral message list for a new question.
 * @param {Map<string, object>} nodesById every node of the canvas
 * @param {{ parentIds: string[], items?: object[], question?: string, files?: object[] }} next
 */
function buildMessages(nodesById, next) {
  const sources = next.parentIds ?? [];
  const path = collectPath(nodesById, sources);
  const plan = planTurns(path, new Set(sources));
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];

  const summaries = plan.filter((p) => p.mode === 'summary');
  if (summaries.length) {
    const lines = summaries.map(({ node }) => `- 问：${shortQuestion(node)}\n  要点：${node.summary}`);
    messages.push({
      role: 'system',
      content: `Earlier turns on this path, summarized to save space (verbatim text was replaced only for these):\n${lines.join('\n')}`,
    });
  }
  if (sources.length > 1) {
    const titles = sources.map((id) => `「${shortQuestion(nodesById.get(id))}」`).join('、');
    messages.push({
      role: 'system',
      content: `The user is combining ${sources.length} branches: ${titles}. Their shared history appears once below; relate and compare them in the answer.`,
    });
  }
  for (const { node, mode } of plan) {
    if (mode !== 'raw') {
      continue;
    }
    messages.push({ role: 'user', content: questionText(node) });
    if (node.answer) {
      messages.push({ role: 'assistant', content: node.answer });
    }
  }
  messages.push({ role: 'user', content: questionText(next) });
  return { messages, plan };
}

function shortQuestion(node) {
  const text = node.question || node.items?.map((i) => i.q || `「${i.quote}」`).join('；') || '';
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

/** What the next question on top of `sourceIds` would carry, for the UI preview. */
function previewContext(nodesById, sourceIds) {
  if (!sourceIds.length) {
    return { turns: [], merged: false };
  }
  const path = collectPath(nodesById, sourceIds);
  const plan = planTurns(path, new Set(sourceIds));
  return {
    merged: sourceIds.length > 1,
    turns: plan.map(({ node, mode }) => ({ id: node.id, title: shortQuestion(node), mode })),
  };
}

/** Validate and normalize a new-node request body. Throws CanvasContextError. */
function normalizeRequest(body, nodesById) {
  const parentIds = Array.isArray(body.parentIds) ? [...new Set(body.parentIds.map(String))] : [];
  if (parentIds.length > LIMITS.maxParents) {
    throw new CanvasContextError(`at most ${LIMITS.maxParents} sources`);
  }
  for (const id of parentIds) {
    const parent = nodesById.get(id);
    if (!parent) {
      throw new CanvasContextError('source not found');
    }
    if (parent.status !== 'done' && parent.status !== 'stopped') {
      throw new CanvasContextError('source answer is not finished');
    }
  }
  const items = (Array.isArray(body.items) ? body.items : []).map((item) => ({
    quote: String(item?.quote ?? '').trim(),
    q: String(item?.q ?? '').trim(),
    source: String(item?.source ?? ''),
  }));
  if (items.length > LIMITS.maxItems) {
    throw new CanvasContextError(`at most ${LIMITS.maxItems} quoted passages`);
  }
  for (const item of items) {
    if (!item.quote || item.quote.length > LIMITS.maxQuoteChars) {
      throw new CanvasContextError('invalid quoted passage');
    }
    if (item.q.length > LIMITS.maxQuestionChars) {
      throw new CanvasContextError('question too long');
    }
    if (!nodesById.has(item.source) || !collectPath(nodesById, parentIds).some((n) => n.id === item.source)) {
      throw new CanvasContextError('quoted passage is not on the selected path');
    }
  }
  const question = String(body.question ?? '').trim();
  if (question.length > LIMITS.maxQuestionChars) {
    throw new CanvasContextError('question too long');
  }
  if (!question && !items.length) {
    throw new CanvasContextError('empty question');
  }
  return { parentIds, items, question };
}

module.exports = {
  LIMITS,
  RAW_TURNS,
  COMPRESS_ABOVE_CHARS,
  SYSTEM_PROMPT,
  CanvasContextError,
  buildMessages,
  collectPath,
  normalizeRequest,
  previewContext,
  questionText,
  shortQuestion,
};
