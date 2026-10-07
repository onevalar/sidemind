/**
 * context.ts
 *
 * Pure helpers that turn the conversation graph into what the LLM actually
 * sees when a branch asks a question:
 *
 *  - apiMessages: the branch's own messages (a quoted passage is attached to
 *    the question that quoted it)
 *  - context: background the model needs but the branch itself doesn't hold —
 *    the conversation the branch grew out of, plus conclusions other branches
 *    published to the blackboard.
 */

import type { ChatState, Message, MessageId } from '../types';

export type ApiMessage = { role: 'user' | 'assistant'; content: string };

const MAX_HISTORY_CHARS = 12000;
const MAX_BLACKBOARD_ENTRIES = 6;

/** Text of a message as the model should read it */
export function messageToApiText(m: Message): string {
  if (m.quote) {
    return `我引用了对话中的这段内容：\n"""\n${m.quote.raw}\n"""\n\n${m.content}`;
  }
  return m.content;
}

/** The branch's own turns, ready to send. Failed/empty replies are dropped. */
export function buildApiMessages(
  state: Pick<ChatState, 'messages' | 'branches'>,
  branchId: string,
): ApiMessage[] {
  const branch = state.branches[branchId];
  const out: ApiMessage[] = [];
  if (!branch) return out;

  for (const id of branch.messageIds) {
    const m = state.messages[id];
    if (!m || m.role === 'system') continue;
    if (m.role === 'assistant' && !m.content.trim()) continue;

    const text = messageToApiText(m);
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      // Providers want alternating turns; merge neighbours left behind by
      // a dropped failed reply.
      last.content += `\n\n${text}`;
    } else {
      out.push({ role: m.role, content: text });
    }
  }
  return out;
}

/** Everything said up to (and including) `messageId`, ancestors first. */
function historyUpTo(
  state: Pick<ChatState, 'messages' | 'branches'>,
  messageId: MessageId,
  seen = new Set<string>(),
): string[] {
  const msg = state.messages[messageId];
  if (!msg || seen.has(msg.id)) return [];
  seen.add(msg.id);

  const branch = state.branches[msg.branchId];
  if (!branch) return [];

  const idx = branch.messageIds.indexOf(messageId);
  const own = branch.messageIds
    .slice(0, idx + 1)
    .map((id) => state.messages[id])
    .filter((m): m is Message => !!m && m.role !== 'system' && !!m.content.trim())
    .map((m) => `${m.role === 'user' ? '用户' : 'AI'}：${messageToApiText(m)}`);

  const parent = branch.sourceMessageId
    ? historyUpTo(state, branch.sourceMessageId, seen)
    : [];
  return [...parent, ...own];
}

/** Background for the system prompt ('' when there is nothing to add). */
export function buildContext(
  state: Pick<ChatState, 'messages' | 'branches' | 'blackboard'>,
  branchId: string,
): string {
  const branch = state.branches[branchId];
  if (!branch) return '';
  const parts: string[] = [];

  // 1. The conversation this branch was forked from
  if (branch.sourceMessageId) {
    const lines = historyUpTo(state, branch.sourceMessageId);
    let total = lines.reduce((n, l) => n + l.length + 2, 0);
    while (lines.length > 1 && total > MAX_HISTORY_CHARS) {
      total -= lines[0].length + 2;
      lines.shift();
    }
    if (lines.length > 0) {
      lines[0] = lines[0].slice(0, MAX_HISTORY_CHARS);
      parts.push(
        '这是一条从主对话分叉出来的分支对话。分支开始之前，用户与 AI 的对话如下' +
          '（用户随后划选了其中的某段文字继续追问，被引用的内容会附在用户的提问里）：\n\n' +
          lines.join('\n\n'),
      );
    }
  }

  // 2. Conclusions published by the other branches (the blackboard)
  const entries = Object.values(state.blackboard)
    .filter((e) => e.branchId !== branchId && state.branches[e.branchId])
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_BLACKBOARD_ENTRIES);
  if (entries.length > 0) {
    parts.push(
      '其他分支对话的结论摘要（仅在与当前问题相关时参考，不要主动复述）：\n' +
        entries
          .map((e) => {
            const facts = e.keyFacts.length ? `（要点：${e.keyFacts.join('；')}）` : '';
            return `- 【${state.branches[e.branchId].label}】${e.summary}${facts}`;
          })
          .join('\n'),
    );
  }

  return parts.join('\n\n---\n\n');
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Cheap, LLM-free summary of one Q&A turn for the blackboard */
export function summarizeExchange(
  question: string,
  reply: string,
): { summary: string; keyFacts: string[] } {
  const plain = reply
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*_`|$]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const q = question.replace(/\s+/g, ' ').trim();

  const keyFacts = reply
    .split('\n')
    .filter((l) => /^#{1,3}\s+/.test(l))
    .map((l) => l.replace(/^#{1,3}\s+/, '').trim())
    .filter(Boolean)
    .slice(0, 5);

  return {
    summary: `问：${truncate(q, 60)} → 答：${truncate(plain, 160)}`,
    keyFacts,
  };
}
