import { useMemo, useState } from 'react';
import { useAtom, useStore } from 'jotai';
import { Constants } from 'librechat-data-provider';
import { GitBranch, MessageSquare, X, ArrowUpRight } from 'lucide-react';
import { Background, Controls, MarkerType, Position, ReactFlow } from '@xyflow/react';
import {
  Button,
  Textarea,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@librechat/client';
import type { TMessage } from 'librechat-data-provider';
import { siblingIdxFamily, siblingKey } from '~/components/Chat/Messages/Thread/state';
import { getBranchSiblingIndexesForTarget } from '~/utils';
import { canvasDraft, readerMode } from './state';
import { useChatContext } from '~/Providers';
import { useLocalize } from '~/hooks';
import '@xyflow/react/dist/style.css';

function messageText(message: TMessage | undefined) {
  return (
    message?.text ||
    message?.content
      ?.map((part) => {
        if (part.type !== 'text') return '';
        return typeof part.text === 'string' ? part.text : part.text?.value;
      })
      .join('\n') ||
    ''
  );
}

function historyPath(id: string, rows: Map<string, TMessage>) {
  const path: string[] = [];
  const seen = new Set<string>();
  let current: string | null = id;
  while (current && rows.has(current) && !seen.has(current)) {
    seen.add(current);
    path.unshift(current);
    current = rows.get(current)?.parentMessageId ?? null;
  }
  return path;
}

export default function Canvas({
  messages,
  onOpenChat,
}: {
  messages: TMessage[];
  onOpenChat: () => void;
}) {
  const t = useLocalize();
  const store = useStore();
  const { ask, conversation, isSubmitting, stopGenerating } = useChatContext();
  const [draft, setDraft] = useAtom(
    canvasDraft(conversation?.conversationId ?? Constants.NEW_CONVO),
  );
  const [reader, setReader] = useAtom(readerMode);
  const [readId, setReadId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const rows = useMemo(
    () => new Map(messages.map((message) => [message.messageId, message])),
    [messages],
  );
  const inspected = rows.get(readId ?? '') ?? messages[messages.length - 1];
  const selected = draft.selected.filter((id) => rows.has(id));
  const paths = selected.map((id) => historyPath(id, rows));
  const common = paths[0]?.filter((id, index) => paths.every((path) => path[index] === id)) ?? [];
  const contextCount = new Set(paths.flat()).size;
  const eligibleRow = (message: TMessage) =>
    !message.error &&
    !message.unfinished &&
    !message.files?.length &&
    !message.content?.some((part) => part.type !== 'text' && part.type !== 'think');
  const eligible = (message: TMessage) =>
    historyPath(message.messageId, rows).every((id) => eligibleRow(rows.get(id)!));

  const layout = useMemo(() => {
    const ranks = new Map<string, number>();
    const rank = (id: string, visiting = new Set<string>()): number => {
      if (ranks.has(id)) return ranks.get(id)!;
      const row = rows.get(id);
      if (!row || visiting.has(id)) return -1;
      visiting.add(id);
      const parents = [row.parentMessageId, ...(row.canvasSources ?? [])].filter(
        (key): key is string => !!key && rows.has(key),
      );
      const depth = 1 + Math.max(-1, ...parents.map((key) => rank(key, new Set(visiting))));
      ranks.set(id, depth);
      return depth;
    };
    const lanes = new Map<number, number>();
    const positions = messages.map((message) => {
      const depth = rank(message.messageId);
      const lane = lanes.get(depth) ?? 0;
      lanes.set(depth, lane + 1);
      return { id: message.messageId, depth, lane };
    });
    return new Map(
      positions.map(({ id, depth, lane }) => [
        id,
        {
          x: (lane - ((lanes.get(depth) ?? 1) - 1) / 2) * 290,
          y: depth * 200,
        },
      ]),
    );
  }, [messages, rows]);

  function inspect(message: TMessage) {
    setReadId(message.messageId);
    if (reader === 'dialog') setDialogOpen(true);
  }
  function openInChat() {
    if (!inspected) return;
    for (const { parentMessageId, siblingIdx } of getBranchSiblingIndexesForTarget(
      messages,
      inspected.messageId,
      conversation?.conversationId,
    )) {
      store.set(siblingIdxFamily(siblingKey(parentMessageId)), siblingIdx);
    }
    onOpenChat();
  }
  const nodes = messages.map((message, index) => ({
    id: message.messageId,
    ariaRole: 'group',
    position: layout.get(message.messageId)!,
    sourcePosition: Position.Bottom,
    targetPosition: Position.Top,
    selected: selected.includes(message.messageId),
    style: {
      width: 252,
      minHeight: message.isCreatedByUser ? 112 : 158,
      borderRadius: message.isCreatedByUser ? 20 : 12,
      borderColor: selected.includes(message.messageId)
        ? 'rgb(var(--text-primary))'
        : 'rgb(var(--border-medium) / var(--border-medium-alpha, 0.2))',
      background: 'rgb(var(--surface-primary))',
      color: 'rgb(var(--text-primary))',
    },
    data: {
      label: (
        <div className="text-left">
          <div className="text-text-secondary mb-2 flex items-center justify-between gap-2 text-xs">
            <span>
              {message.isCreatedByUser ? t('com_canvas_question') : t('com_canvas_answer')} ·{' '}
              {index + 1}
            </span>
            {message.canvasSources?.length ? (
              <GitBranch size={14} aria-label={t('com_canvas_reference')} />
            ) : null}
          </div>
          <button
            type="button"
            // eslint-disable-next-line shadcn/no-unknown-classes -- React Flow interaction guards.
            className="nodrag nopan line-clamp-3 w-full text-left text-sm whitespace-pre-wrap focus-visible:outline"
            onClick={() => inspect(message)}
          >
            {messageText(message) ||
              t(isSubmitting ? 'com_canvas_generating' : 'com_canvas_failed')}
          </button>
          <label
            // eslint-disable-next-line shadcn/no-unknown-classes -- React Flow interaction guards.
            className="nodrag nopan mt-3 flex min-h-8 cursor-pointer items-center gap-2 text-xs"
            onClick={(event) => event.stopPropagation()}
          >
            <input
              type="checkbox"
              checked={selected.includes(message.messageId)}
              disabled={isSubmitting || !eligible(message)}
              aria-label={`${t('com_canvas_select')} ${messageText(message).slice(0, 70)}`}
              onChange={() =>
                setDraft((current) => ({
                  ...current,
                  mode: 'merge',
                  selected: current.selected.includes(message.messageId)
                    ? current.selected.filter((id) => id !== message.messageId)
                    : [...current.selected, message.messageId],
                }))
              }
            />
            {message.error ? t('com_canvas_failed') : t('com_canvas_select')}
          </label>
        </div>
      ),
    },
  }));
  const edges = messages.flatMap((message) => [
    ...(rows.has(message.parentMessageId ?? '')
      ? [
          {
            id: `parent-${message.messageId}`,
            source: message.parentMessageId!,
            target: message.messageId,
            markerEnd: { type: MarkerType.ArrowClosed },
            style: { stroke: 'rgb(var(--text-tertiary))', strokeWidth: 1.4 },
          },
        ]
      : []),
    ...(message.canvasSources ?? [])
      .filter((id) => rows.has(id) && id !== message.parentMessageId)
      .map((id) => ({
        id: `ref-${id}-${message.messageId}`,
        source: id,
        target: message.messageId,
        label: t('com_canvas_reference'),
        markerEnd: { type: MarkerType.ArrowClosed },
        style: { stroke: 'rgb(var(--text-primary))', strokeWidth: 1.6, strokeDasharray: '6 5' },
        labelStyle: { fill: 'rgb(var(--text-primary))' },
        labelBgStyle: { fill: 'rgb(var(--surface-primary))' },
      })),
  ]);
  function branch(mode: 'continue' | 'rewrite') {
    if (!inspected) return;
    setDraft({
      mode,
      text: mode === 'rewrite' ? messageText(inspected) : '',
      selected: [],
      parentId: inspected.messageId,
    });
    setDialogOpen(false);
  }
  function send(event: React.FormEvent) {
    event.preventDefault();
    if (!draft.text.trim() || isSubmitting || (draft.mode === 'merge' && !selected.length)) return;
    const origin = rows.get(draft.parentId ?? '');
    let parentMessageId = origin?.messageId;
    let canvasSources: string[] | undefined;
    if (draft.mode === 'merge') {
      parentMessageId = common[common.length - 1] ?? Constants.NO_PARENT;
      canvasSources = selected;
    } else if (draft.mode === 'rewrite') {
      parentMessageId = origin?.parentMessageId ?? Constants.NO_PARENT;
      canvasSources = origin?.canvasSources;
    }
    const result = ask(
      {
        text: draft.text.trim(),
        conversationId: conversation?.conversationId,
        parentMessageId: parentMessageId ?? Constants.NO_PARENT,
        canvasSources,
      },
      { overrideFiles: [], overrideQuotes: [], overrideManualSkills: [] },
    );
    if (result !== false) {
      setDraft((current) => ({ ...current, text: '' }));
      setReadId(null);
    }
  }
  const details = inspected && (
    <div className="text-text-primary flex flex-col gap-4">
      <div className="text-text-secondary flex items-center justify-between text-xs">
        <span>{inspected.isCreatedByUser ? t('com_canvas_question') : t('com_canvas_answer')}</span>
        <Button size="sm" variant="ghost" onClick={openInChat}>
          <MessageSquare size={14} />
          {t('com_canvas_open_chat')}
        </Button>
      </div>
      <p className="max-h-64 overflow-y-auto text-sm leading-relaxed whitespace-pre-wrap">
        {messageText(inspected)}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={isSubmitting || !!inspected.error || !!inspected.unfinished}
          onClick={() => branch('continue')}
        >
          <GitBranch size={14} />
          {t('com_canvas_continue')}
        </Button>
        {inspected.isCreatedByUser && (
          <Button
            size="sm"
            variant="outline"
            disabled={isSubmitting}
            onClick={() => branch('rewrite')}
          >
            {t('com_canvas_rewrite')}
          </Button>
        )}
      </div>
      {inspected.canvasContext && (
        <details
          data-testid="canvas-snapshot"
          className="border-border-light rounded-lg border p-3"
        >
          <summary className="cursor-pointer text-sm font-medium">
            {t('com_canvas_snapshot')} · {inspected.canvasContext.nodes.length}
          </summary>
          <p className="text-text-secondary mt-2 text-xs">{t('com_canvas_frozen')}</p>
          <ol className="mt-3 flex max-h-64 flex-col gap-3 overflow-y-auto">
            {inspected.canvasContext.nodes.map((node, index) => (
              <li key={`${node.messageId}-${node.revision}`} className="text-sm">
                <span className="text-text-secondary text-xs">
                  {index + 1} · {node.role}
                </span>
                <p className="mt-1 whitespace-pre-wrap">{node.text}</p>
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
  return (
    <section
      className="text-text-primary flex min-h-0 flex-1 flex-col"
      aria-label={t('com_canvas_title')}
    >
      <div className="border-border-light text-text-secondary flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3 text-xs">
        <p>{t('com_canvas_notice')}</p>
        <label className="flex items-center gap-2">
          {t('com_canvas_reading')}
          <select
            value={reader}
            onChange={(event) => {
              setReader(event.target.value as 'side' | 'dialog');
              setDialogOpen(false);
            }}
            className="bg-surface-primary text-text-primary border-border-light rounded-md border px-2 py-1"
            aria-label={t('com_canvas_reading')}
          >
            <option value="side">{t('com_canvas_side')}</option>
            <option value="dialog">{t('com_canvas_dialog')}</option>
          </select>
        </label>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
        <div className="min-h-80 min-w-0 flex-1" data-testid="canvas-graph">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            fitView
            minZoom={0.2}
            maxZoom={1.5}
            nodesDraggable={false}
            nodesConnectable={false}
            nodesFocusable={false}
            deleteKeyCode={null}
            onNodeClick={(_, node) => {
              const row = rows.get(node.id);
              if (row) inspect(row);
            }}
            onNodeDoubleClick={(_, node) => {
              const row = rows.get(node.id);
              if (row) inspect(row);
            }}
          >
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
        <aside
          className="border-border-light bg-surface-primary flex w-full shrink-0 flex-col gap-5 border-t p-5 lg:max-h-full lg:w-96 lg:overflow-y-auto lg:border-t-0 lg:border-l"
          aria-label={t('com_canvas_reader')}
        >
          <h2 className="font-semibold">{t('com_canvas_reader')}</h2>
          {reader === 'side' ? (
            details
          ) : (
            <Button variant="outline" onClick={() => setDialogOpen(true)}>
              {t('com_canvas_read_full')}
            </Button>
          )}
          <form onSubmit={send} className="border-border-light flex flex-col gap-3 border-t pt-4">
            <label htmlFor="canvas-question" className="text-sm font-semibold">
              {t('com_canvas_new_question')}
            </label>
            <p className="text-text-secondary text-xs" role="status">
              {
                {
                  merge: `${t('com_canvas_selected')} ${selected.length} · ${contextCount} ${t('com_canvas_history_nodes')}`,
                  continue: t('com_canvas_continue_hint'),
                  rewrite: t('com_canvas_rewrite_hint'),
                }[draft.mode]
              }
            </p>
            {draft.mode !== 'merge' && (
              <p className="text-text-secondary line-clamp-2 text-xs">
                {messageText(rows.get(draft.parentId ?? '') ?? inspected)}
              </p>
            )}
            {draft.mode === 'merge' && selected.length > 0 && (
              <ul className="flex max-h-32 flex-col gap-2 overflow-y-auto">
                {selected.map((id) => (
                  <li
                    key={id}
                    className="bg-surface-secondary flex items-center gap-2 rounded-md px-2 py-1 text-xs"
                  >
                    <span className="line-clamp-1 flex-1">{messageText(rows.get(id)!)}</span>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-label={`${t('com_canvas_remove')} ${messageText(rows.get(id)!).slice(0, 40)}`}
                      onClick={() =>
                        setDraft((current) => ({
                          ...current,
                          selected: current.selected.filter((key) => key !== id),
                        }))
                      }
                    >
                      <X size={14} />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <Textarea
              id="canvas-question"
              value={draft.text}
              rows={4}
              disabled={isSubmitting}
              placeholder={t('com_canvas_placeholder')}
              onChange={(event) =>
                setDraft((current) => ({ ...current, text: event.target.value }))
              }
            />
            <Button
              type="submit"
              disabled={
                isSubmitting || !draft.text.trim() || (draft.mode === 'merge' && !selected.length)
              }
            >
              <ArrowUpRight size={16} />
              {t('com_canvas_send')}
            </Button>
            {isSubmitting && (
              <Button type="button" variant="outline" onClick={() => void stopGenerating()}>
                {t('com_canvas_stop')}
              </Button>
            )}
            <p className="text-text-secondary text-xs leading-relaxed">
              {t('com_canvas_text_only')}
            </p>
          </form>
        </aside>
      </div>
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-2xl" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>{t('com_canvas_read_full')}</DialogTitle>
          </DialogHeader>
          <div className="max-h-96 overflow-y-auto px-6 pb-2">{details}</div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
