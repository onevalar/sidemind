/**
 * ChatGit canvas API: /api/chatgit/*
 *
 * Canvases hold a graph of Q&A nodes. A new node is answered from the context the server
 * assembles (services/ChatGit/canvasContext.js); the answer streams as SSE and keeps being
 * generated and saved if the browser goes away, so a reload shows the finished result.
 */
const crypto = require('crypto');
const express = require('express');
const { logger } = require('@librechat/data-schemas');
const { requireJwtAuth, configMiddleware } = require('~/server/middleware');
const { Canvas, CanvasNode, toNode, toCanvas } = require('~/server/services/ChatGit/canvasModels');
const ctx = require('~/server/services/ChatGit/canvasContext');
const llm = require('~/server/services/ChatGit/canvasLLM');

const router = express.Router();
router.use(requireJwtAuth, configMiddleware);

/** In-flight generations by node id → { controller, listeners:Set<res> }. */
const running = new Map();
const MAX_CANVASES = 500;
const MAX_NODES_PER_CANVAS = 2000;
const SAVE_EVERY_MS = 800;

const userId = (req) => req.user.id;
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function fail(res, status, message) {
  return res.status(status).json({ message });
}

async function loadCanvas(req, res) {
  const canvas = await Canvas.findOne({ _id: req.params.id, user: userId(req) }).catch(() => null);
  if (!canvas) {
    fail(res, 404, 'canvas not found');
    return null;
  }
  return canvas;
}

async function loadNodes(req, canvasId) {
  const docs = await CanvasNode.find({ user: userId(req), canvas: canvasId }).sort({ createdAt: 1 }).lean();
  // A "streaming" node without a live generation was interrupted by a restart.
  const stale = docs.filter((d) => d.status === 'streaming' && !running.has(d.nodeId));
  if (stale.length) {
    await CanvasNode.updateMany(
      { user: userId(req), nodeId: { $in: stale.map((d) => d.nodeId) }, status: 'streaming' },
      { $set: { status: 'error', error: 'interrupted' } },
    );
    stale.forEach((d) => Object.assign(d, { status: 'error', error: 'interrupted' }));
  }
  return docs.map(toNode);
}

const byId = (nodes) => new Map(nodes.map((n) => [n.id, n]));

/* ---------- canvases ---------- */

router.get('/canvases', asyncRoute(async (req, res) => {
  const docs = await Canvas.find({ user: userId(req) }).sort({ updatedAt: -1 }).limit(MAX_CANVASES).lean();
  res.json({ canvases: docs.map((d) => ({ id: String(d._id), name: d.name, updatedAt: d.updatedAt })) });
}));

router.post('/canvases', asyncRoute(async (req, res) => {
  if ((await Canvas.countDocuments({ user: userId(req) })) >= MAX_CANVASES) {
    return fail(res, 400, 'too many canvases');
  }
  const doc = await Canvas.create({
    user: userId(req),
    name: String(req.body?.name ?? '').slice(0, 120),
    endpoint: String(req.body?.endpoint ?? ''),
    model: String(req.body?.model ?? ''),
  });
  res.status(201).json({ canvas: toCanvas(doc), nodes: [] });
}));

router.get('/canvases/:id', asyncRoute(async (req, res) => {
  const canvas = await loadCanvas(req, res);
  if (!canvas) {
    return;
  }
  res.json({ canvas: toCanvas(canvas), nodes: await loadNodes(req, String(canvas._id)) });
}));

const DRAFT_LIMIT = 12;
router.patch('/canvases/:id', asyncRoute(async (req, res) => {
  const canvas = await loadCanvas(req, res);
  if (!canvas) {
    return;
  }
  const body = req.body ?? {};
  if (typeof body.name === 'string') {
    canvas.name = body.name.trim().slice(0, 120);
  }
  for (const key of ['endpoint', 'model']) {
    if (typeof body[key] === 'string') {
      canvas[key] = body[key].slice(0, 200);
    }
  }
  if (typeof body.active === 'string' || body.active === null) {
    canvas.active = body.active ?? '';
  }
  if (Array.isArray(body.drafts)) {
    if (body.drafts.length > DRAFT_LIMIT) {
      return fail(res, 400, `at most ${DRAFT_LIMIT} drafts`);
    }
    canvas.drafts = body.drafts.map((d) => ({
      id: String(d.id).slice(0, 64),
      letter: String(d.letter ?? '').slice(0, 4),
      name: String(d.name ?? '').slice(0, 60),
      items: (Array.isArray(d.items) ? d.items : []).slice(0, ctx.LIMITS.maxItems).map((i) => ({
        quote: String(i.quote ?? '').slice(0, ctx.LIMITS.maxQuoteChars),
        q: String(i.q ?? '').slice(0, ctx.LIMITS.maxQuestionChars),
        source: String(i.source ?? ''),
      })),
    }));
    canvas.activeDraft = String(body.activeDraft ?? canvas.drafts[0]?.id ?? '');
    canvas.draftSeq = Number.isInteger(body.draftSeq) ? body.draftSeq : canvas.draftSeq;
  }
  await canvas.save();
  res.json({ canvas: toCanvas(canvas) });
}));

router.delete('/canvases/:id', asyncRoute(async (req, res) => {
  const canvas = await loadCanvas(req, res);
  if (!canvas) {
    return;
  }
  const ids = await CanvasNode.find({ user: userId(req), canvas: String(canvas._id) }).distinct('nodeId');
  ids.forEach((id) => running.get(id)?.controller.abort());
  await CanvasNode.deleteMany({ user: userId(req), canvas: String(canvas._id) });
  await canvas.deleteOne();
  res.status(204).end();
}));

router.get('/canvases/:id/context', asyncRoute(async (req, res) => {
  const canvas = await loadCanvas(req, res);
  if (!canvas) {
    return;
  }
  const sources = String(req.query.sources ?? '').split(',').filter(Boolean).slice(0, ctx.LIMITS.maxParents);
  const nodes = byId(await loadNodes(req, String(canvas._id)));
  try {
    res.json(ctx.previewContext(nodes, sources));
  } catch (error) {
    fail(res, error.status ?? 500, error.message);
  }
}));

/* ---------- generation ---------- */

function sse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    // no-transform keeps the compression middleware from buffering the stream.
    'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  return (event, data) => {
    if (!res.writableEnded) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      res.flush?.();
    }
  };
}

/** Run one generation for an already-saved node. Never throws. */
async function generate(req, canvas, doc, nodesById, send) {
  const controller = new AbortController();
  running.set(doc.nodeId, { controller });
  let answer = '';
  let lastSave = Date.now();
  try {
    const { messages } = ctx.buildMessages(nodesById, toNode(doc));
    answer = await llm.streamAnswer(req, {
      endpoint: doc.endpoint,
      model: doc.model,
      messages,
      signal: controller.signal,
      onText: (delta, full) => {
        send('delta', { id: doc.nodeId, text: delta });
        if (Date.now() - lastSave > SAVE_EVERY_MS) {
          lastSave = Date.now();
          CanvasNode.updateOne({ _id: doc._id, status: 'streaming' }, { $set: { answer: full } }).catch(() => {});
        }
        answer = full;
      },
    });
    doc.status = 'done';
    doc.answer = answer;
    doc.error = '';
  } catch (error) {
    const { code } = llm.classifyError(error);
    if (code === 'aborted') {
      doc.status = 'stopped';
    } else {
      doc.status = 'error';
      doc.error = code;
      logger.warn(`[chatgit/canvas] generation failed (${code}): ${error?.message ?? error}`);
    }
    doc.answer = answer;
  } finally {
    running.delete(doc.nodeId);
  }
  await CanvasNode.updateOne({ _id: doc._id }, { $set: { status: doc.status, answer: doc.answer, error: doc.error } });
  send('done', { node: toNode(doc) });
  if (doc.status === 'done') {
    enrich(req, doc).catch((error) => logger.debug(`[chatgit/canvas] enrich skipped: ${error?.message}`));
  }
  if (!canvas.name) {
    const first = ctx.shortQuestion(toNode(doc)).slice(0, 40);
    await Canvas.updateOne({ _id: canvas._id, name: '' }, { $set: { name: first } });
  }
}

/** After an answer: a short summary (used to compress long paths) and follow-up suggestions. */
async function enrich(req, doc) {
  const node = toNode(doc);
  const text = await llm.complete(req, {
    endpoint: doc.endpoint,
    model: doc.model,
    maxOutputTokens: 500,
    messages: [
      {
        role: 'system',
        content:
          'Return only JSON: {"summary": string, "suggestions": string[]}. summary: the key points of the answer in at most 2 sentences. suggestions: 3 short follow-up questions the user may want to ask next. Use the language of the question.',
      },
      { role: 'user', content: `Question:\n${ctx.questionText(node)}\n\nAnswer:\n${node.answer.slice(0, 12000)}` },
    ],
  });
  const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  const summary = typeof json.summary === 'string' ? json.summary.slice(0, 600) : '';
  const suggestions = Array.isArray(json.suggestions)
    ? json.suggestions.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim().slice(0, 120)).slice(0, 3)
    : [];
  await CanvasNode.updateOne({ _id: doc._id }, { $set: { summary, suggestions } });
}

async function startNode(req, res, canvas, fields) {
  const nodes = await loadNodes(req, String(canvas._id));
  if (nodes.length >= MAX_NODES_PER_CANVAS) {
    return fail(res, 400, 'canvas is full');
  }
  const nodesById = byId(nodes);
  let request;
  try {
    request = ctx.normalizeRequest(fields, nodesById);
  } catch (error) {
    return fail(res, error.status ?? 400, error.message);
  }
  const endpoint = String(fields.endpoint || canvas.endpoint || '');
  const model = String(fields.model || canvas.model || '');
  if (!endpoint || !model) {
    return fail(res, 400, 'no model selected');
  }
  const doc = await CanvasNode.create({
    user: userId(req),
    canvas: String(canvas._id),
    nodeId: crypto.randomUUID(),
    ...request,
    items: request.items.length ? request.items : undefined,
    endpoint,
    model,
  });
  await Canvas.updateOne({ _id: canvas._id }, { $set: { updatedAt: new Date() } });
  const send = sse(res);
  send('node', { node: toNode(doc) });
  await generate(req, canvas, doc, nodesById, send);
  res.end();
}

router.post('/canvases/:id/nodes', asyncRoute(async (req, res) => {
  const canvas = await loadCanvas(req, res);
  if (canvas) {
    await startNode(req, res, canvas, req.body ?? {});
  }
}));

router.post('/canvases/:id/nodes/:nodeId/retry', asyncRoute(async (req, res) => {
  const canvas = await loadCanvas(req, res);
  if (!canvas) {
    return;
  }
  const doc = await CanvasNode.findOne({ user: userId(req), canvas: String(canvas._id), nodeId: req.params.nodeId });
  if (!doc) {
    return fail(res, 404, 'node not found');
  }
  if (running.has(doc.nodeId)) {
    return fail(res, 409, 'already generating');
  }
  if (typeof req.body?.endpoint === 'string' && req.body.endpoint) {
    doc.endpoint = req.body.endpoint;
  }
  if (typeof req.body?.model === 'string' && req.body.model) {
    doc.model = req.body.model;
  }
  Object.assign(doc, { status: 'streaming', answer: '', error: '', summary: '', suggestions: [] });
  await doc.save();
  const nodesById = byId(await loadNodes(req, String(canvas._id)));
  const send = sse(res);
  send('node', { node: toNode(doc) });
  await generate(req, canvas, doc, nodesById, send);
  res.end();
}));

router.post('/canvases/:id/nodes/:nodeId/stop', asyncRoute(async (req, res) => {
  const canvas = await loadCanvas(req, res);
  if (!canvas) {
    return;
  }
  const exists = await CanvasNode.exists({ user: userId(req), canvas: String(canvas._id), nodeId: req.params.nodeId });
  if (!exists) {
    return fail(res, 404, 'node not found');
  }
  running.get(req.params.nodeId)?.controller.abort();
  res.status(202).json({ ok: true });
}));

/** Delete a node and everything that grew from it. */
router.delete('/canvases/:id/nodes/:nodeId', asyncRoute(async (req, res) => {
  const canvas = await loadCanvas(req, res);
  if (!canvas) {
    return;
  }
  const nodes = await loadNodes(req, String(canvas._id));
  if (!nodes.some((n) => n.id === req.params.nodeId)) {
    return fail(res, 404, 'node not found');
  }
  const doomed = new Set([req.params.nodeId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of nodes) {
      if (!doomed.has(n.id) && n.parentIds.some((p) => doomed.has(p))) {
        doomed.add(n.id);
        grew = true;
      }
    }
  }
  doomed.forEach((id) => running.get(id)?.controller.abort());
  await CanvasNode.deleteMany({ user: userId(req), canvas: String(canvas._id), nodeId: { $in: [...doomed] } });
  canvas.drafts = canvas.drafts.map((d) => ({ ...d.toObject(), items: d.items.filter((i) => !doomed.has(i.source)) }));
  if (doomed.has(canvas.active)) {
    canvas.active = '';
  }
  await canvas.save();
  res.json({ deleted: [...doomed], canvas: toCanvas(canvas) });
}));

module.exports = router;
module.exports.running = running;
