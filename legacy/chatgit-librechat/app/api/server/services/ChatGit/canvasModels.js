/**
 * ChatGit canvas storage: its own graph model, independent of LibreChat's message tree.
 * Every query is scoped by `user` (the authenticated user's id string).
 */
const mongoose = require('mongoose');

const itemSchema = new mongoose.Schema(
  { quote: { type: String, required: true }, q: { type: String, default: '' }, source: { type: String, required: true } },
  { _id: false },
);

const draftSchema = new mongoose.Schema(
  { id: { type: String, required: true }, letter: String, name: String, items: { type: [itemSchema], default: [] } },
  { _id: false },
);

const canvasSchema = new mongoose.Schema(
  {
    user: { type: String, required: true, index: true },
    name: { type: String, default: '' },
    endpoint: { type: String, default: '' },
    model: { type: String, default: '' },
    drafts: { type: [draftSchema], default: [] },
    activeDraft: { type: String, default: '' },
    draftSeq: { type: Number, default: 0 },
    active: { type: String, default: '' },
  },
  { timestamps: true, collection: 'chatgit_canvases' },
);

const fileSchema = new mongoose.Schema({ file_id: String, filename: String, text: String }, { _id: false });

const nodeSchema = new mongoose.Schema(
  {
    user: { type: String, required: true },
    canvas: { type: String, required: true },
    nodeId: { type: String, required: true },
    parentIds: { type: [String], default: [] },
    items: { type: [itemSchema], default: undefined },
    question: { type: String, default: '' },
    files: { type: [fileSchema], default: undefined },
    status: { type: String, enum: ['streaming', 'done', 'error', 'stopped'], default: 'streaming' },
    answer: { type: String, default: '' },
    error: { type: String, default: '' },
    endpoint: String,
    model: String,
    summary: { type: String, default: '' },
    suggestions: { type: [String], default: [] },
  },
  { timestamps: true, collection: 'chatgit_nodes' },
);
nodeSchema.index({ user: 1, canvas: 1, createdAt: 1 });
nodeSchema.index({ user: 1, nodeId: 1 }, { unique: true });

const Canvas = mongoose.models.ChatGitCanvas || mongoose.model('ChatGitCanvas', canvasSchema);
const CanvasNode = mongoose.models.ChatGitCanvasNode || mongoose.model('ChatGitCanvasNode', nodeSchema);

function toNode(doc) {
  return {
    id: doc.nodeId,
    parentIds: doc.parentIds ?? [],
    items: doc.items?.length ? doc.items.map((i) => ({ quote: i.quote, q: i.q, source: i.source })) : null,
    question: doc.question ?? '',
    files: doc.files?.map((f) => ({ file_id: f.file_id, filename: f.filename })) ?? undefined,
    status: doc.status,
    answer: doc.answer ?? '',
    error: doc.error || undefined,
    endpoint: doc.endpoint,
    model: doc.model,
    summary: doc.summary || undefined,
    suggestions: doc.suggestions ?? [],
    createdAt: doc.createdAt,
  };
}

function toCanvas(doc) {
  return {
    id: String(doc._id),
    name: doc.name,
    endpoint: doc.endpoint,
    model: doc.model,
    drafts: (doc.drafts ?? []).map((d) => ({ id: d.id, letter: d.letter, name: d.name, items: d.items.map((i) => ({ quote: i.quote, q: i.q, source: i.source })) })),
    activeDraft: doc.activeDraft,
    draftSeq: doc.draftSeq,
    active: doc.active || null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

module.exports = { Canvas, CanvasNode, toNode, toCanvas };
