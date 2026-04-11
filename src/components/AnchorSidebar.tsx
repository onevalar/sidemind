'use client';

import { useChatStore } from '../store';
import type { AnchorId, AnchorIntent } from '../types';

const INTENT_LABEL: Record<AnchorIntent, string> = {
  main: '🔵 主干追问',
  'new-branch': '🟢 新分支',
  'existing-branch': '🟣 追加分支',
};

const STATUS_LABEL: Record<string, string> = {
  pending: '待输入',
  queued: '已就绪',
  streaming: '生成中…',
  done: '已完成',
  error: '出错',
};

export function AnchorSidebar() {
  const anchors = useChatStore((s) => Object.values(s.anchors));
  const branches = useChatStore((s) => s.branches);
  const focusedAnchorId = useChatStore((s) => s.ui.focusedAnchorId);
  const focusAnchor = useChatStore((s) => s.focusAnchor);

  if (anchors.length === 0) return null;

  return (
    <div className="w-72 border-l border-zinc-800 bg-zinc-900/50 overflow-y-auto shrink-0">
      <div className="p-4">
        <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">
          锚点 ({anchors.length})
        </h2>

        <div className="space-y-2">
          {anchors.map((anchor) => {
            const isFocused = focusedAnchorId === anchor.id;
            const branch = branches[anchor.branchId];
            return (
              <button
                key={anchor.id}
                onClick={() =>
                  focusAnchor(isFocused ? null : (anchor.id as AnchorId))
                }
                className={`w-full text-left p-3 rounded-lg border transition-all duration-200 ${
                  isFocused
                    ? 'bg-opacity-10'
                    : 'border-zinc-800 bg-zinc-800/30 hover:bg-zinc-800/60'
                }`}
                style={
                  isFocused
                    ? {
                        borderColor: `${anchor.color}60`,
                        backgroundColor: `${anchor.color}12`,
                      }
                    : undefined
                }
              >
                {/* Intent + status */}
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] font-medium" style={{ color: anchor.color }}>
                    {INTENT_LABEL[anchor.intent]}
                  </span>
                  <span className="text-[9px] text-zinc-600 uppercase tracking-wider">
                    {STATUS_LABEL[anchor.status]}
                  </span>
                </div>

                {/* Selected text */}
                <p className="text-xs text-zinc-300 line-clamp-2 leading-relaxed mb-1">
                  &ldquo;{anchor.slice.selectedText}&rdquo;
                </p>

                {/* Target branch label */}
                {branch && (
                  <p className="text-[10px] text-zinc-600 truncate">
                    → {branch.label}
                  </p>
                )}

                {/* Pending question */}
                {anchor.pendingInput && (
                  <p className="text-[11px] text-zinc-500 line-clamp-1 mt-0.5">
                    Q: {anchor.pendingInput}
                  </p>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
