'use client';

import { useState, useRef, useCallback } from 'react';
import { useChatStore } from '../store';

export function ChatInput() {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const rootBranchId = useChatStore((s) => s.rootBranchId);
  const rootStatus = useChatStore((s) => s.branches[s.rootBranchId]?.status);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const viewMode = useChatStore((s) => s.ui.viewMode);
  const activeBranchPanelId = useChatStore((s) => s.ui.activeBranchPanelId);
  const submitQueuedAnchors = useChatStore((s) => s.submitQueuedAnchors);
  const queuedCount = useChatStore(
    (s) => Object.values(s.anchors).filter((a) => a.status === 'queued').length,
  );

  // In linear mode, offset from sidebar width
  const sidebarWidth =
    viewMode === 'linear' ? (activeBranchPanelId ? 420 : 224) : 0;

  const isStreaming = rootStatus === 'streaming' || sending;

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || isStreaming) return;
    setText('');
    setSending(true);
    try {
      await sendMessage(rootBranchId, trimmed);
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  }, [text, isStreaming, sendMessage, rootBranchId]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Auto-resize textarea
  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  return (
    <div
      className="fixed bottom-0 left-0 flex justify-center pb-4 px-4 pointer-events-none z-40"
      style={{ right: sidebarWidth }}
    >
      <div className="w-full max-w-2xl pointer-events-auto">
        {/* Queued anchors badge */}
        {queuedCount > 0 && (
          <div className="flex justify-end mb-2">
            <button
              onClick={submitQueuedAnchors}
              className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium transition-colors shadow-lg"
            >
              发送 {queuedCount} 个锚点问题 →
            </button>
          </div>
        )}

        {/* Main input bar */}
        <div className="bg-zinc-900 border border-zinc-700 rounded-2xl shadow-2xl shadow-black/50 flex items-end gap-2 px-4 py-3">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder="向主干对话发送消息… (Enter 发送，Shift+Enter 换行)"
            rows={1}
            disabled={isStreaming}
            className="flex-1 bg-transparent text-sm text-zinc-100 placeholder-zinc-500 resize-none outline-none leading-relaxed disabled:opacity-50"
            style={{ minHeight: 24 }}
          />

          {/* Send button */}
          <button
            onClick={handleSend}
            disabled={!text.trim() || isStreaming}
            className="shrink-0 w-8 h-8 rounded-xl flex items-center justify-center transition-all disabled:opacity-30"
            style={{
              backgroundColor: text.trim() && !isStreaming ? '#6366f1' : '#3f3f46',
            }}
          >
            {isStreaming ? (
              <span className="w-3 h-3 rounded-full border-2 border-zinc-400 border-t-transparent animate-spin" />
            ) : (
              <svg
                className="w-4 h-4 text-white"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
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

        <p className="text-center text-[10px] text-zinc-600 mt-1.5">
          划选 AI 回复中的文字可创建分支对话
        </p>
      </div>
    </div>
  );
}
