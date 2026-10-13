'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useChatStore } from '../store';
import { MessageBody } from './MessageBody';
import type { BranchId } from '../types';

/**
 * Side panel that shows a branch conversation.
 * Has its own input for continuing the branch dialog.
 */
export function BranchPanel({ branchId }: { branchId: BranchId }) {
  const branch = useChatStore((s) => s.branches[branchId]);
  const messages = useChatStore((s) => s.messages);
  const anchors = useChatStore((s) => s.anchors);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const setActiveBranchPanel = useChatStore((s) => s.setActiveBranchPanel);

  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const msgIds = branch?.messageIds ?? [];
  const isStreaming = branch?.status === 'streaming';
  const lastMsg = msgIds.length ? messages[msgIds[msgIds.length - 1]] : undefined;
  const waitingForFirstToken =
    isStreaming && lastMsg?.role === 'assistant' && !lastMsg.content;
  const lastLength = lastMsg?.content.length ?? 0;

  // Source anchor info
  const sourceAnchor = branch?.sourceAnchorId
    ? anchors[branch.sourceAnchorId]
    : null;

  // Auto-scroll on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [msgIds.length, branchId]);

  // Follow streaming text while the user is near the bottom
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) {
      el.scrollTop = el.scrollHeight;
    }
  }, [lastLength]);

  // Focus input on mount
  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 100);
    return () => clearTimeout(t);
  }, [branchId]);

  const handleSend = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || isStreaming || sending) return;
    setInput('');
    setSending(true);
    try {
      await sendMessage(branchId, trimmed);
    } finally {
      setSending(false);
    }
  }, [input, isStreaming, sending, sendMessage, branchId]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  if (!branch) return null;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="shrink-0 px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
        <div className="min-w-0 flex-1">
          <h3 className="text-xs font-semibold text-zinc-300 truncate">
            🔀 {branch.label}
          </h3>
          {sourceAnchor && (
            <p className="text-[10px] text-zinc-600 truncate mt-0.5">
              引用：&ldquo;{sourceAnchor.slice.selectedText.slice(0, 40)}
              {sourceAnchor.slice.selectedText.length > 40 ? '…' : ''}&rdquo;
            </p>
          )}
        </div>
        <button
          onClick={() => setActiveBranchPanel(null)}
          className="shrink-0 ml-2 w-6 h-6 rounded-md hover:bg-zinc-800 flex items-center justify-center text-zinc-500 hover:text-zinc-300 transition-colors"
          title="关闭分支"
        >
          ✕
        </button>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
        {msgIds.length === 0 && !isStreaming && (
          <p className="text-xs text-zinc-600 italic text-center py-8">
            在下方输入框开始分支对话
          </p>
        )}

        {msgIds.map((id) => {
          const msg = messages[id];
          if (!msg) return null;
          if (waitingForFirstToken && id === lastMsg?.id) return null;
          const isUser = msg.role === 'user';

          return (
            <div
              key={id}
              className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-4`}
            >
              <div
                className={`rounded-xl px-4 py-3 ${
                  isUser
                    ? 'max-w-[85%] bg-emerald-600/70 text-white'
                    : 'max-w-[95%] min-w-0 bg-zinc-800/60 border border-zinc-700/40 text-zinc-100'
                }`}
                data-message-id={msg.id}
                data-role={msg.role}
              >
                <MessageBody message={msg} />
              </div>
            </div>
          );
        })}

        {/* Typing indicator */}
        {waitingForFirstToken && (
          <div className="flex justify-start mb-4">
            <div className="bg-zinc-800/60 border border-zinc-700/40 rounded-xl px-4 py-3">
              <div className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse [animation-delay:0.2s]" />
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse [animation-delay:0.4s]" />
              </div>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="shrink-0 px-3 pb-3 pt-2 border-t border-zinc-800">
        <div className="flex items-end gap-2 bg-zinc-800/60 border border-zinc-700/40 rounded-xl px-3 py-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = `${Math.min(e.target.scrollHeight, 100)}px`;
            }}
            onKeyDown={handleKeyDown}
            placeholder="在分支中继续追问…"
            rows={1}
            disabled={isStreaming || sending}
            className="flex-1 bg-transparent text-sm text-zinc-100 placeholder-zinc-500 resize-none outline-none leading-relaxed disabled:opacity-50"
            style={{ minHeight: 22 }}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || isStreaming || sending}
            className="shrink-0 w-7 h-7 rounded-lg flex items-center justify-center transition-all disabled:opacity-30"
            style={{
              backgroundColor:
                input.trim() && !isStreaming ? '#34d399' : '#3f3f46',
            }}
          >
            {isStreaming || sending ? (
              <span className="w-2.5 h-2.5 rounded-full border-2 border-zinc-400 border-t-transparent animate-spin" />
            ) : (
              <svg
                className="w-3.5 h-3.5 text-white"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M5 12h14M12 5l7 7-7 7"
                />
              </svg>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
