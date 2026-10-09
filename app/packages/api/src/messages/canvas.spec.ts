import { Constants, ContentTypes } from 'librechat-data-provider';
import { StreamLimitExceededError, formatAgentMessages } from '@librechat/agents';
import type { CanvasContext } from 'librechat-data-provider';
import type { CanvasHistoryRow, CanvasModelCallback, CanvasTurnInput } from './canvas';
import {
  CANVAS_LIMITS,
  CanvasContextError,
  pickCanvasTurnFields,
  omitCanvasTurnFields,
  renderCanvasReferences,
  resolveCanvasTurnFields,
  prepareCanvasReferences,
  CanvasReferenceGuardError,
  createCanvasResumeModelCallbacks,
} from './canvas';

const now = new Date('2026-10-09T00:00:00.000Z');
const row = (
  messageId: string,
  parentMessageId: string,
  text: string,
  isCreatedByUser = false,
): CanvasHistoryRow => ({
  messageId,
  parentMessageId,
  conversationId: 'c1',
  text,
  isCreatedByUser,
});

/** A diamond: two alternatives (A, B) and one unselected sibling under a shared root turn. */
function fixture() {
  const rows: CanvasHistoryRow[] = [
    row('root-q', Constants.NO_PARENT, 'SHARED_QUESTION', true),
    row('root-a', 'root-q', 'SHARED_ANSWER'),
    row('a-q', 'root-a', 'PLAN_A: budget 2000', true),
    row('a-a', 'a-q', 'PLAN_A_ANSWER'),
    row('b-q', 'root-a', 'PLAN_B: budget 5000', true),
    row('b-a', 'b-q', 'PLAN_B_ANSWER'),
    row('secret', 'root-a', 'UNSELECTED_BRANCH'),
  ];
  const byId = (id: string) => rows.find((r) => r.messageId === id) as CanvasHistoryRow;
  return { rows, byId, history: [byId('root-q'), byId('root-a')] };
}

const resolve = (input: Partial<CanvasTurnInput> & Pick<CanvasTurnInput, 'rows'>) =>
  resolveCanvasTurnFields({
    userMessageId: 'turn',
    conversationId: 'c1',
    now,
    rawSources: undefined,
    history: [],
    ...input,
  });

/** Saves a resolved turn the way BaseClient does: fields on the user row, text untouched. */
function send(
  rows: CanvasHistoryRow[],
  history: CanvasHistoryRow[],
  id: string,
  parent: string,
  sources: string[],
) {
  const turn = {
    ...row(id, parent, `QUESTION_${id}`, true),
    ...resolve({ rows, history, userMessageId: id, rawSources: sources }),
  };
  rows.push(turn);
  return turn;
}

const blockFor = (path: CanvasHistoryRow[], id: string) =>
  renderCanvasReferences(path).get(id) ?? '';
const dataOf = (block: string) => JSON.parse(block.split('\n').slice(-2)[0]);
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;
const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CanvasContextError);
    return (error as CanvasContextError).code;
  }
  throw new Error('expected a CanvasContextError');
};

describe('ChatGit branch references', () => {
  it('leaves ordinary chat untouched', () => {
    const { rows, history } = fixture();
    expect(resolve({ rows, history })).toEqual({});
    expect(resolve({ rows, history, rawSources: [] })).toEqual({});
    expect(resolve({ rows, history, rawSources: ['a-a'], isEdited: true })).toEqual({});
    expect(renderCanvasReferences([...history, row('turn', 'root-a', 'hi', true)]).size).toBe(0);
  });

  it('unions a diamond once, keeps branches apart and excludes unselected siblings', () => {
    const { rows, history } = fixture();
    const turn = send(rows, history, 'turn', 'root-a', ['b-a', 'a-a', 'root-a', 'a-a']);
    expect(turn.text).toBe('QUESTION_turn');
    expect(turn.canvasSources).toEqual(['b-a', 'a-a', 'root-a']);
    const ids = turn.canvasContext?.nodes.map((node) => node.messageId);
    expect(ids).toHaveLength(6);
    expect(new Set(ids)).toEqual(new Set(['root-q', 'root-a', 'a-q', 'a-a', 'b-q', 'b-a']));

    const block = blockFor([...history, turn], 'turn');
    for (const marker of ['PLAN_A: budget 2000', 'PLAN_A_ANSWER', 'PLAN_B_ANSWER']) {
      expect(count(block, marker)).toBe(1);
    }
    /** Shared ancestors are already in the history above; the block names them by position. */
    expect(block).not.toContain('SHARED_QUESTION');
    expect(block).not.toContain('SHARED_ANSWER');
    expect(block).not.toContain('UNSELECTED_BRANCH');
    const data = dataOf(block);
    const byRef = new Map(data.nodes.map((node: { ref: string }) => [node.ref, node]));
    const [bBranch, aBranch] = data.branches;
    expect(aBranch.path.map((ref: string) => (byRef.get(ref) as { role: string }).role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    /** Shared ancestors are path members of both branches; the alternatives never interleave. */
    expect(aBranch.path.slice(0, 2)).toEqual(bBranch.path.slice(0, 2));
    expect(aBranch.path[2]).not.toBe(bBranch.path[2]);
    /** root-q is two messages before the turn; the node names it instead of repeating it. */
    expect(byRef.get(aBranch.path[0])).toEqual({
      ref: aBranch.path[0],
      parent: null,
      role: 'user',
      in_history: 'H-2',
    });
  });

  it('stores the same snapshot regardless of selection order and keeps that order for display', () => {
    const first = fixture();
    const second = fixture();
    const a = resolve({ rows: first.rows, history: first.history, rawSources: ['b-a', 'a-a'] });
    const b = resolve({ rows: second.rows, history: second.history, rawSources: ['a-a', 'b-a'] });
    expect(a.canvasContext?.nodes).toEqual(b.canvasContext?.nodes);
    expect(a.canvasSources).toEqual(['b-a', 'a-a']);
    expect(b.canvasSources).toEqual(['a-a', 'b-a']);
  });

  it('keeps equal text on different messages as separate nodes', () => {
    const { rows, byId, history } = fixture();
    byId('a-a').text = 'SAME_WORDS';
    byId('b-a').text = 'SAME_WORDS';
    const turn = send(rows, history, 'turn', 'root-a', ['a-a', 'b-a']);
    expect(count(blockFor([...history, turn], 'turn'), 'SAME_WORDS')).toBe(2);
  });

  it('freezes snapshots, inherits them in follow-ups once, and carries them into later selections', () => {
    const { rows, byId, history } = fixture();
    const merge = send(rows, history, 'merge', 'root-a', ['a-a', 'b-a']);
    const frozen = JSON.stringify(merge.canvasContext);
    byId('a-a').text = 'EDITED_AFTER_SEND';
    rows.push(row('later', 'b-a', 'FUTURE_BRANCH_REPLY'));
    const answer = row('merge-answer', 'merge', 'MERGED_ANSWER');
    rows.push(answer);

    const followup = {
      ...row('followup', 'merge-answer', 'FOLLOWUP', true),
      ...resolve({ rows, userMessageId: 'followup' }),
    };
    expect(followup.canvasContext).toBeUndefined();
    const prompt = [...renderCanvasReferences([...history, merge, answer, followup]).values()].join(
      '\n',
    );
    expect(count(prompt, 'PLAN_A_ANSWER')).toBe(1);
    expect(prompt).not.toContain('EDITED_AFTER_SEND');
    expect(prompt).not.toContain('FUTURE_BRANCH_REPLY');
    expect(JSON.stringify(merge.canvasContext)).toBe(frozen);

    /** A new branch selecting the merge answer inherits the frozen references of that turn. */
    const later = send(rows, history, 'later-turn', 'root-a', ['merge-answer']);
    expect(later.canvasContext?.inherited).toEqual([
      {
        messageId: 'merge',
        sources: [
          expect.objectContaining({ messageId: 'a-a' }),
          expect.objectContaining({ messageId: 'b-a' }),
        ],
      },
    ]);
    const block = blockFor([...history, later], 'later-turn');
    expect(count(block, 'PLAN_A_ANSWER')).toBe(1);
    expect(block).not.toContain('EDITED_AFTER_SEND');
    expect(
      dataOf(block).branches.filter((b: { referenced_by?: string }) => b.referenced_by),
    ).toHaveLength(2);
  });

  it('keeps an edited version beside the current one and de-duplicates the primary path only by version', () => {
    const { rows, byId, history } = fixture();
    const merge = send(rows, history, 'merge', 'root-a', ['a-a']);
    rows.push(row('merge-answer', 'merge', 'MERGED_ANSWER'));
    const pathToA = [byId('root-q'), byId('root-a'), byId('a-q'), byId('a-a')];

    /** Unedited: the inherited snapshot equals the primary-path row, so it is not repeated. */
    const same = send(rows, pathToA, 'same', 'a-a', ['merge-answer']);
    const sameBlock = blockFor([...pathToA, same], 'same');
    expect(sameBlock).not.toContain('"text":"PLAN_A_ANSWER"');

    byId('a-a').text = 'PLAN_A_ANSWER_V2';
    /** Edited: same messageId, different version, so the frozen text stays. */
    const edited = send(rows, pathToA, 'edited', 'a-a', ['merge-answer']);
    const editedData = dataOf(blockFor([...pathToA, edited], 'edited'));
    expect(editedData.nodes).toContainEqual(
      expect.objectContaining({ text: 'PLAN_A_ANSWER', other_versions: ['H-1'] }),
    );
    /** Re-selecting the edited row after the earlier turn keeps both texts, linked as versions. */
    const answer = byId('merge-answer');
    const reselect = send(rows, [...history, merge, answer], 're', 'merge-answer', ['a-a']);
    const prompt = renderCanvasReferences([...history, merge, answer, reselect]);
    type Node = { ref: string; text?: string };
    const first = dataOf(prompt.get('merge') ?? '').nodes as Node[];
    const earlier = first.find((node) => node.text === 'PLAN_A_ANSWER')?.ref;
    expect(dataOf(prompt.get('re') ?? '').nodes).toContainEqual(
      expect.objectContaining({ text: 'PLAN_A_ANSWER_V2', other_versions: [earlier] }),
    );
    /** Selecting the live row too keeps both versions of a-a. */
    const both = send(rows, history, 'both', 'root-a', ['merge-answer', 'a-a']);
    const versions = both.canvasContext?.nodes.filter((node) => node.messageId === 'a-a');
    expect(versions?.map((node) => node.text).sort()).toEqual([
      'PLAN_A_ANSWER',
      'PLAN_A_ANSWER_V2',
    ]);
    expect(merge.canvasContext?.nodes.find((n) => n.messageId === 'a-a')?.text).toBe(
      'PLAN_A_ANSWER',
    );
  });

  it('replays a stored turn on regenerate instead of trusting newly submitted sources', () => {
    const { rows, byId, history } = fixture();
    const merge = send(rows, history, 'merge', 'root-a', ['a-a']);
    byId('a-a').text = 'EDITED';
    const replay = resolve({ rows, history, userMessageId: 'merge', rawSources: ['b-a'] });
    expect(replay.canvasSources).toEqual(['a-a']);
    expect(replay.canvasContext?.nodes).toEqual(merge.canvasContext?.nodes);
  });

  it('rejects malicious metadata and unusable sources before dispatch', () => {
    const { rows, byId, history } = fixture();
    const attempt = (rawSources: unknown, input: Partial<CanvasTurnInput> = {}) =>
      codeOf(() => resolve({ rows, history, rawSources, ...input }));
    expect(attempt([{ messageId: 'a-a', text: 'FORGED' }])).toBe('CANVAS_INVALID_SELECTION');
    expect(attempt('a-a')).toBe('CANVAS_INVALID_SELECTION');
    expect(attempt(['turn'])).toBe('CANVAS_INVALID_SELECTION');
    expect(attempt(['outside'])).toBe('CANVAS_SOURCE_NOT_FOUND');
    rows.push({ ...row('foreign', 'root-a', 'OTHER_CONVO'), conversationId: 'c2' });
    expect(attempt(['foreign'])).toBe('CANVAS_SOURCE_NOT_FOUND');
    expect(attempt(Array.from({ length: CANVAS_LIMITS.maxSources + 1 }, (_, i) => `id-${i}`))).toBe(
      'CANVAS_TOO_LARGE',
    );

    /** A forged stored context on a history row is validated, not rendered as trusted data. */
    const forged = {
      ...row('forged', 'root-a', 'Q', true),
      canvasContext: {
        version: 1,
        sources: ['x'],
        nodes: [{ messageId: 'x', text: 7 }],
      } as unknown as CanvasContext,
    };
    expect(codeOf(() => renderCanvasReferences([...history, forged]))).toBe(
      'CANVAS_CONTEXT_INVALID',
    );

    byId('a-q').parentMessageId = 'a-a';
    expect(attempt(['a-a'])).toBe('CANVAS_SOURCE_CYCLE');
    byId('a-q').parentMessageId = 'root-a';

    const cases: [Partial<CanvasHistoryRow>, string][] = [
      [{ unfinished: true }, 'CANVAS_SOURCE_UNAVAILABLE'],
      [{ error: true }, 'CANVAS_SOURCE_UNAVAILABLE'],
      [{ files: [{ file_id: 'f' }] }, 'CANVAS_SOURCE_UNSUPPORTED'],
      [{ content: [{ type: ContentTypes.TOOL_CALL }] }, 'CANVAS_SOURCE_UNSUPPORTED'],
      [{ content: [{ type: ContentTypes.IMAGE_URL }] }, 'CANVAS_SOURCE_UNSUPPORTED'],
      [{ text: 'x'.repeat(CANVAS_LIMITS.maxRenderedChars) }, 'CANVAS_TOO_LARGE'],
    ];
    const index = rows.indexOf(byId('a-a'));
    const original = rows[index];
    for (const [patch, code] of cases) {
      rows[index] = { ...original, ...patch };
      expect(attempt(['a-a'])).toBe(code);
    }
    /** The user-visible error never echoes source content. */
    rows[index] = { ...original, text: 'SECRET '.repeat(CANVAS_LIMITS.maxRenderedChars) };
    let message = '';
    try {
      resolve({ rows, history, rawSources: ['a-a'] });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/too large/);
    expect(message).not.toContain('SECRET');
  });
});

/** Model-facing text of a path, the way buildMessages merges blocks into user turns. */
function payloadOf(path: CanvasHistoryRow[]): string[] {
  const blocks = renderCanvasReferences(path);
  return path.map((message) => {
    const block = blocks.get(message.messageId as string);
    return block ? `${block}\n\n${message.text}` : (message.text as string);
  });
}

/** Two references on one primary path: the second overlaps the first and the history. */
function referencedConversation() {
  const { rows, byId, history } = fixture();
  const merge = send(rows, history, 'merge', 'root-a', ['a-a', 'b-a']);
  const answer = row('merge-answer', 'merge', 'MERGED_ANSWER');
  rows.push(answer);
  const again = send(rows, [...history, merge, answer], 'again', 'merge-answer', ['b-a', 'a-q']);
  return { rows, byId, again, path: [...history, merge, answer, again] };
}

describe('ChatGit branch reference payload', () => {
  it('sends every shared text once across history and reference blocks', () => {
    const { path } = referencedConversation();
    const payload = payloadOf(path).join('\n');
    for (const marker of [
      'SHARED_QUESTION',
      'SHARED_ANSWER',
      'PLAN_A: budget 2000',
      'PLAN_A_ANSWER',
      'PLAN_B: budget 5000',
      'PLAN_B_ANSWER',
      'MERGED_ANSWER',
    ]) {
      expect(count(payload, marker)).toBe(1);
    }
    expect(payload).not.toContain('UNSELECTED_BRANCH');

    /** Each "H-k" names the message k positions before its turn, with role and parent kept. */
    const blocks = renderCanvasReferences(path);
    const turnIndex = path.findIndex((message) => message.messageId === 'again');
    const nodes = dataOf(blocks.get('again') ?? '').nodes as Record<string, unknown>[];
    const historyNodes = nodes.filter((node) => node.in_history != null);
    expect(historyNodes.length).toBeGreaterThan(0);
    for (const node of historyNodes) {
      const k = Number(String(node.in_history).slice(2));
      const target = path[turnIndex - k];
      expect(node.role).toBe(target.isCreatedByUser ? 'user' : 'assistant');
      expect(node).not.toHaveProperty('text');
      expect(node).not.toHaveProperty('excerpt');
    }
    /** The nodes the first block already carried are labels only in the second. */
    expect(nodes.filter((node) => node.shown_above === true).length).toBeGreaterThan(0);
  });

  it('keeps disagreeing versions apart and points the frozen one at the current history row', () => {
    const { rows, byId } = fixture();
    const toA = () => [byId('root-q'), byId('root-a'), byId('a-q'), byId('a-a')];
    send(rows, [byId('root-q'), byId('root-a')], 'merge', 'root-a', ['a-a']);
    rows.push(row('merge-answer', 'merge', 'MERGED_ANSWER'));
    byId('a-a').text = 'REVISED_A_ANSWER';
    const turn = send(rows, toA(), 'turn', 'a-a', ['merge-answer']);
    const path = [...toA(), turn];

    const payload = payloadOf(path).join('\n');
    expect(count(payload, 'REVISED_A_ANSWER')).toBe(1);
    expect(count(payload, 'PLAN_A_ANSWER')).toBe(1);
    const nodes = dataOf(renderCanvasReferences(path).get('turn') ?? '').nodes;
    const frozen = nodes.find((node: { text?: string }) => node.text === 'PLAN_A_ANSWER');
    expect(frozen.other_versions).toEqual(['H-1']);
    expect(path[path.length - 1 - 1].messageId).toBe('a-a');
  });
});

type ProviderMessage = { content: string; additional_kwargs: { sourceMessageId?: string } };

const providerMessages = (path: CanvasHistoryRow[]): ProviderMessage[] =>
  payloadOf(path).map((content, index) => ({
    content,
    additional_kwargs: { sourceMessageId: path[index].messageId },
  }));

function guardCode(
  callback: CanvasModelCallback,
  messages: readonly object[],
  metadata?: Record<string, unknown>,
): string | undefined {
  try {
    callback.handleChatModelStart(undefined, [messages], 'run', undefined, undefined, [], metadata);
  } catch (error) {
    expect(error).toBeInstanceOf(CanvasReferenceGuardError);
    /** The SDK rethrows this class from summarization and fallback recovery. */
    expect(error).toBeInstanceOf(StreamLimitExceededError);
    expect((error as Error).message).not.toMatch(/PLAN_|SHARED_/);
    return (error as CanvasReferenceGuardError).code;
  }
  return undefined;
}

describe('ChatGit branch reference model guard', () => {
  it('installs nothing for ordinary chat', () => {
    const { history } = fixture();
    const result = prepareCanvasReferences([...history, row('turn', 'root-a', 'hi', true)]);
    expect(result.blocks.size).toBe(0);
    expect(result.modelCallbacks).toEqual([]);
  });

  it('preserves inherited references on ordinary follow-ups, without affecting unrelated calls', () => {
    const { rows, byId, history } = fixture();
    const merge = send(rows, history, 'merge', 'root-a', ['a-a']);
    const answer = row('merge-answer', 'merge', 'MERGED_ANSWER');
    const followup = row('followup', 'merge-answer', 'PLAIN_FOLLOWUP', true);
    const reply = row('reply', 'followup', 'PLAIN_REPLY');
    const current = row('current', 'reply', 'CURRENT', true);
    rows.push(answer, followup, reply, current);
    const path = [...history, merge, answer, followup, reply, current];
    const [guard] = prepareCanvasReferences(path).modelCallbacks;
    const messages = providerMessages(path);

    expect(guardCode(guard, messages)).toBeUndefined();
    expect(guardCode(guard, [{ content: 'subagent task', additional_kwargs: {} }])).toBeUndefined();
    /** Removing every referenced turn still changes the context inherited by this follow-up. */
    expect(guardCode(guard, messages.slice(4))).toBe('CANVAS_REFERENCES_PRUNED');
    /** Keeping shared history does not compensate for a missing reference block. */
    expect(guardCode(guard, [...messages.slice(0, 2), ...messages.slice(3)])).toBe(
      'CANVAS_REFERENCES_PRUNED',
    );
    expect(guardCode(guard, messages.slice(4), { summarization: true })).toBe(
      'CANVAS_COMPACTION_UNSUPPORTED',
    );
    expect(byId('a-a').text).toBe('PLAN_A_ANSWER');
  });

  it('rejects a call whose pruning would leave a block pointing at missing material', () => {
    const { path } = referencedConversation();
    const [guard] = prepareCanvasReferences(path).modelCallbacks;
    const messages = providerMessages(path);
    expect(guardCode(guard, messages)).toBeUndefined();

    /** root-q is named by "H-k" in both blocks. */
    expect(guardCode(guard, messages.slice(1))).toBe('CANVAS_REFERENCES_PRUNED');
    /** The first block is gone while the second still marks its nodes shown_above. */
    const withoutMerge = messages.filter((message) => message.content !== messages[2].content);
    expect(guardCode(guard, withoutMerge)).toBe('CANVAS_REFERENCES_PRUNED');
    /** A truncated block. */
    const last = messages[messages.length - 1];
    const truncated = { ...last, content: last.content.slice(0, last.content.length / 2) };
    expect(guardCode(guard, [...messages.slice(0, -1), truncated])).toBe(
      'CANVAS_REFERENCES_PRUNED',
    );
    /** Referenced history without the current turn is a cut-down copy of the conversation. */
    expect(guardCode(guard, messages.slice(0, -1))).toBe('CANVAS_REFERENCES_PRUNED');
    /** Blocks whose source stamps were lost cannot be verified. */
    const unstamped = messages.map(({ content }) => ({ content, additional_kwargs: {} }));
    expect(guardCode(guard, unstamped)).toBe('CANVAS_REFERENCES_PRUNED');
  });

  it('rejects summarization that would fold referenced material, but not unrelated calls', () => {
    const { path } = referencedConversation();
    const [guard] = prepareCanvasReferences(path).modelCallbacks;
    const messages = providerMessages(path);
    const summary = { summarization: true };
    expect(guardCode(guard, messages.slice(0, 2), summary)).toBe('CANVAS_COMPACTION_UNSUPPORTED');
    /** A serialized transcript loses the stamps but still carries the block. */
    const transcript = [
      { content: messages.map((m) => m.content).join('\n'), additional_kwargs: {} },
    ];
    expect(guardCode(guard, transcript, summary)).toBe('CANVAS_COMPACTION_UNSUPPORTED');
    const unrelated = [{ content: 'older', additional_kwargs: { sourceMessageId: 'other' } }];
    expect(guardCode(guard, unrelated, summary)).toBeUndefined();
  });

  it('reads the provenance stamps of real formatted provider messages', () => {
    const { path } = referencedConversation();
    const [guard] = prepareCanvasReferences(path).modelCallbacks;
    const payload = payloadOf(path).map((content, index) => ({
      role: (path[index].isCreatedByUser ? 'user' : 'assistant') as 'user' | 'assistant',
      content,
      messageId: path[index].messageId,
    }));
    const formatted = (items: typeof payload) => formatAgentMessages(items, {}).messages;
    expect(guardCode(guard, formatted(payload))).toBeUndefined();
    expect(guardCode(guard, formatted(payload.slice(1)))).toBe('CANVAS_REFERENCES_PRUNED');
  });

  it('checks resumed runs structurally from the turn the job carries', () => {
    const { path } = referencedConversation();
    const messages = providerMessages(path);
    const current = path[path.length - 1];
    const [guard] = createCanvasResumeModelCallbacks([current, row('resp', 'again', '')]);
    expect(guardCode(guard, messages)).toBeUndefined();
    /** "H-k" beyond the stored messages still in the input. */
    expect(guardCode(guard, messages.slice(1))).toBe('CANVAS_REFERENCES_PRUNED');
    /** shown_above labels whose defining block was pruned. */
    expect(guardCode(guard, messages.slice(3))).toBe('CANVAS_REFERENCES_PRUNED');
    /** The resumed turn without its block. */
    const bare = { ...messages[messages.length - 1], content: current.text as string };
    expect(guardCode(guard, [...messages.slice(0, -1), bare])).toBe('CANVAS_REFERENCES_PRUNED');
    expect(guardCode(guard, messages.slice(0, 3), { summarization: true })).toBe(
      'CANVAS_COMPACTION_UNSUPPORTED',
    );

    const [ordinary] = createCanvasResumeModelCallbacks([row('q', Constants.NO_PARENT, 'Q', true)]);
    const plain = [{ content: 'Q', additional_kwargs: { sourceMessageId: 'q' } }];
    expect(guardCode(ordinary, plain)).toBeUndefined();
    expect(guardCode(ordinary, plain, { summarization: true })).toBeUndefined();
  });
});

describe('ChatGit branch reference fields', () => {
  it('projects only server-resolved fields and strips them from client rows', () => {
    const { again } = referencedConversation();
    expect(pickCanvasTurnFields(again)).toEqual({
      canvasSources: ['b-a', 'a-q'],
      canvasContext: again.canvasContext,
    });
    expect(pickCanvasTurnFields({ canvasSources: [] })).toEqual({});
    expect(pickCanvasTurnFields(undefined)).toEqual({});
    expect(omitCanvasTurnFields({ text: 'hi', canvasSources: ['x'], canvasContext: {} })).toEqual({
      text: 'hi',
    });
  });
});
