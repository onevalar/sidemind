'use client';

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { motion, AnimatePresence } from 'framer-motion';
import { useChatStore } from '../store';
import { INTENT_COLORS } from '../lib/colors';
import type { AnchorIntent, BranchId, UIState } from '../types';

type ActiveIntent = AnchorIntent | null;

const INTENT_OPTIONS: {
  key: AnchorIntent;
  emoji: string;
  label: string;
  desc: string;
}[] = [
  {
    key: 'main',
    emoji: '🔵',
    label: '在主干追问',
    desc: '基于这段文本，在主对话中继续提问',
  },
  {
    key: 'new-branch',
    emoji: '🟢',
    label: '创建新分支',
    desc: '开启一个独立的分支对话',
  },
  {
    key: 'existing-branch',
    emoji: '🟣',
    label: '追加到现有分支',
    desc: '将问题发送到已有的分支中',
  },
];

export function SelectionPopover() {
  const pendingSelection = useChatStore((s) => s.ui.pendingSelection);
  const rootBranchId = useChatStore((s) => s.rootBranchId);
  const branches = useChatStore((s) => s.branches);
  const otherBranches = useMemo(
    () =>
      Object.values(branches)
        .filter((b) => b.id !== rootBranchId)
        .map((b) => ({ id: b.id, label: b.label })),
    [branches, rootBranchId],
  );

  return (
    <AnimatePresence>
      {pendingSelection && (
        <SelectionPopoverContent
          key={pendingSelection.messageId}
          pendingSelection={pendingSelection}
          otherBranches={otherBranches}
        />
      )}
    </AnimatePresence>
  );
}

function SelectionPopoverContent({
  pendingSelection,
  otherBranches,
}: {
  pendingSelection: NonNullable<UIState['pendingSelection']>;
  otherBranches: { id: BranchId; label: string }[];
}) {
  const askFromSelection = useChatStore((s) => s.askFromSelection);
  const setPendingSelection = useChatStore((s) => s.setPendingSelection);
  const setActiveBranchPanel = useChatStore((s) => s.setActiveBranchPanel);
  const rootBranchId = useChatStore((s) => s.rootBranchId);
  const branchStatuses = useChatStore(
    useShallow((s) =>
      Object.fromEntries(
        Object.values(s.branches).map((b) => [b.id, b.status]),
      ),
    ),
  );

  const [activeIntent, setActiveIntent] = useState<ActiveIntent>(null);
  const [selectedBranchId, setSelectedBranchId] = useState<BranchId | null>(
    null,
  );
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus input when it appears
  useEffect(() => {
    if (activeIntent && inputRef.current) {
      const t = setTimeout(() => inputRef.current?.focus(), 60);
      return () => clearTimeout(t);
    }
  }, [activeIntent, selectedBranchId]);

  const dismiss = useCallback(() => {
    setPendingSelection(null);
    window.getSelection()?.removeAllRanges();
  }, [setPendingSelection]);

  // The branch this question would go to (null until one is chosen)
  const targetBranchId: BranchId | null =
    activeIntent === 'main'
      ? rootBranchId
      : activeIntent === 'existing-branch'
        ? selectedBranchId
        : null;
  const targetBusy =
    targetBranchId != null && branchStatuses[targetBranchId] === 'streaming';

  const handleSubmit = useCallback(() => {
    if (!activeIntent || !input.trim() || targetBusy) return;

    // For "existing-branch", a branch must be selected
    if (activeIntent === 'existing-branch' && !selectedBranchId) return;

    const branchId = askFromSelection({
      messageId: pendingSelection.messageId,
      slice: pendingSelection.slice,
      intent: activeIntent,
      targetBranchId: targetBranchId ?? undefined,
      question: input.trim(),
    });

    if (branchId) {
      // Open the branch panel (for non-main intents in linear mode)
      if (activeIntent !== 'main') {
        setActiveBranchPanel(branchId);
      }
      dismiss();
    }
  }, [
    pendingSelection,
    activeIntent,
    input,
    selectedBranchId,
    targetBranchId,
    targetBusy,
    askFromSelection,
    setActiveBranchPanel,
    dismiss,
  ]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (activeIntent) {
        // Step back to intent selection
        setActiveIntent(null);
        setSelectedBranchId(null);
        setInput('');
      } else {
        dismiss();
      }
    }
  };

  // Position: below the selection
  const getPosition = () => {
    if (!pendingSelection) return { top: 0, left: 0 };
    const { rect } = pendingSelection;
    const popoverWidth = 380;
    let left = rect.left + rect.width / 2 - popoverWidth / 2;
    left = Math.max(12, Math.min(left, window.innerWidth - popoverWidth - 12));
    const top = rect.bottom + 10;
    return { top, left };
  };

  // Should the input row be visible?
  const showInput =
    activeIntent === 'main' ||
    activeIntent === 'new-branch' ||
    (activeIntent === 'existing-branch' && selectedBranchId);

  return (
    <motion.div
      data-popover
      initial={{ opacity: 0, y: -6, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -4, scale: 0.97 }}
      transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
      className="fixed z-50"
      style={{
        top: getPosition().top,
        left: getPosition().left,
      }}
    >
          {/* Arrow pointing up to selection */}
          <div className="absolute left-1/2 -translate-x-1/2 -top-1.5 w-3 h-3 bg-zinc-900 border-t border-l border-zinc-700 rotate-45" />

          <div className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl shadow-black/50 w-[380px] overflow-hidden">
            {/* Selected text preview */}
            <div className="px-4 pt-3 pb-2">
              <div className="px-2.5 py-2 bg-zinc-800/60 rounded-lg border border-zinc-700/40">
                <p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-0.5">
                  选中文本
                </p>
                <p className="text-xs text-zinc-300 line-clamp-2 leading-relaxed">
                  &ldquo;{pendingSelection.slice.selectedText}&rdquo;
                </p>
              </div>
            </div>

            {/* Intent buttons */}
            <div className="px-3 pb-2">
              <div className="flex gap-1.5">
                {INTENT_OPTIONS.map((opt) => {
                  const isActive = activeIntent === opt.key;
                  const intentColor = INTENT_COLORS[opt.key];
                  return (
                    <button
                      key={opt.key}
                      onClick={() => {
                        setActiveIntent(opt.key);
                        setSelectedBranchId(null);
                        setInput('');
                      }}
                      className={`flex-1 px-2 py-2 rounded-lg text-center transition-all duration-150 border ${
                        isActive
                          ? 'border-opacity-60 bg-opacity-15'
                          : 'border-zinc-800 bg-zinc-800/40 hover:bg-zinc-800/80'
                      }`}
                      style={
                        isActive
                          ? {
                              borderColor: intentColor,
                              backgroundColor: `${intentColor}18`,
                            }
                          : undefined
                      }
                    >
                      <span className="text-base">{opt.emoji}</span>
                      <p
                        className="text-[11px] font-medium mt-0.5 leading-tight"
                        style={isActive ? { color: intentColor } : { color: '#a1a1aa' }}
                      >
                        {opt.label}
                      </p>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Expandable area */}
            <AnimatePresence mode="wait">
              {activeIntent && (
                <motion.div
                  key={activeIntent}
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                  className="overflow-hidden"
                >
                  <div className="px-4 pb-3 pt-1">
                    {/* Description */}
                    <p className="text-[11px] text-zinc-500 mb-2">
                      {INTENT_OPTIONS.find((o) => o.key === activeIntent)?.desc}
                    </p>

                    {/* Branch selector (only for existing-branch intent) */}
                    {activeIntent === 'existing-branch' && (
                      <div className="mb-2">
                        {otherBranches.length === 0 ? (
                          <p className="text-xs text-zinc-600 italic py-2">
                            暂无其他分支，请先创建一个新分支
                          </p>
                        ) : (
                          <div className="space-y-1 max-h-32 overflow-y-auto">
                            {otherBranches.map((branch) => {
                              const isSelected = selectedBranchId === branch.id;
                              return (
                                <button
                                  key={branch.id}
                                  onClick={() =>
                                    setSelectedBranchId(branch.id)
                                  }
                                  className={`w-full text-left px-3 py-2 rounded-lg text-xs transition-all border ${
                                    isSelected
                                      ? 'border-violet-500/50 bg-violet-500/10 text-violet-300'
                                      : 'border-zinc-800 bg-zinc-800/30 text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-300'
                                  }`}
                                >
                                  <span className="mr-1.5">
                                    {isSelected ? '◉' : '○'}
                                  </span>
                                  {branch.label}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}

                    {targetBusy && (
                      <p className="text-[11px] text-amber-400/80 mb-2">
                        该对话正在生成回复，请等它完成后再追问
                      </p>
                    )}

                    {/* Input row */}
                    {showInput && (
                      <motion.div
                        initial={{ opacity: 0, y: 4 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.15 }}
                        className="flex gap-2"
                      >
                        <input
                          ref={inputRef}
                          type="text"
                          value={input}
                          onChange={(e) => setInput(e.target.value)}
                          onKeyDown={handleKeyDown}
                          placeholder="输入你的问题…"
                          className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 outline-none focus:ring-1 transition-colors"
                          style={{
                            borderColor: input.trim()
                              ? INTENT_COLORS[activeIntent!]
                              : undefined,
                            boxShadow: input.trim()
                              ? `0 0 0 1px ${INTENT_COLORS[activeIntent!]}40`
                              : undefined,
                          }}
                        />
                        <button
                          onClick={handleSubmit}
                          disabled={!input.trim() || targetBusy}
                          className="px-3 py-2 text-white text-sm font-medium rounded-lg transition-all shrink-0 disabled:bg-zinc-700 disabled:text-zinc-500"
                          style={
                            input.trim() && !targetBusy
                              ? {
                                  backgroundColor: INTENT_COLORS[activeIntent!],
                                }
                              : undefined
                          }
                        >
                          确认
                        </button>
                      </motion.div>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Footer hint */}
            <div className="px-4 pb-2.5">
              <p className="text-[10px] text-zinc-600">
                {activeIntent
                  ? 'Enter 确认 · Esc 返回'
                  : '选择一个意图 · Esc 取消'}
              </p>
            </div>
          </div>
    </motion.div>
  );
}
