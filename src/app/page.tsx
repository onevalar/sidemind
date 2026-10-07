'use client';

import { CanvasBoard } from '../components/canvas/CanvasBoard';
import { SelectionPopover } from '../components/SelectionPopover';
import { ChatInput } from '../components/ChatInput';
import { SettingsButton } from '../components/SettingsDialog';
import { LinearChatView } from '../components/LinearChatView';
import { ContentOutline } from '../components/ContentOutline';
import { BranchPanel } from '../components/BranchPanel';
import { useTextSelection } from '../hooks/useTextSelection';
import { useChatStore } from '../store';
import { useStoreHydrated } from '../hooks/useStoreHydrated';

export default function Home() {
  useTextSelection();
  const hydrated = useStoreHydrated();

  const viewMode = useChatStore((s) => s.ui.viewMode);
  const activeBranchPanelId = useChatStore(
    (s) => s.ui.activeBranchPanelId,
  );
  const setViewMode = useChatStore((s) => s.setViewMode);
  const resetToEmpty = useChatStore((s) => s.resetToEmpty);
  const resetToMock = useChatStore((s) => s.resetToMock);
  const messageCount = useChatStore(
    (s) => Object.keys(s.messages).length,
  );
  const branchCount = useChatStore(
    (s) =>
      Object.values(s.branches).filter(
        (b) => b.id !== s.rootBranchId && b.messageIds.length > 0,
      ).length,
  );

  // Wait for the saved conversation to be restored (avoids a flash of the empty state)
  if (!hydrated) {
    return <main className="h-screen w-screen bg-zinc-950" />;
  }

  // ── Canvas mode ──
  if (viewMode === 'canvas') {
    return (
      <main className="h-screen w-screen overflow-hidden bg-zinc-950">
        <CanvasBoard />
        <SelectionPopover />
        <ChatInput />

        {/* Settings (top-right) */}
        <div className="fixed top-4 right-4 z-50">
          <SettingsButton />
        </div>

        {/* Top bar */}
        <div className="fixed top-4 left-4 z-50 flex items-center gap-2">
          <h1 className="text-sm font-semibold text-zinc-300 mr-1">ChatGit</h1>
          <button
            onClick={() => setViewMode('linear')}
            className="px-3 py-1.5 rounded-lg bg-zinc-800 border border-zinc-700 hover:bg-zinc-700 text-xs text-zinc-300 font-medium transition-colors"
          >
            ← 返回对话
          </button>
        </div>
      </main>
    );
  }

  // ── Linear mode (default) ──
  return (
    <main className="h-screen w-screen overflow-hidden bg-zinc-950 flex flex-col">
      {/* Top bar */}
      <header className="shrink-0 h-12 border-b border-zinc-800 flex items-center px-4 justify-between">
        <div className="flex items-center gap-2">
          <h1 className="text-sm font-semibold text-zinc-200">ChatGit</h1>
          <button
            onClick={resetToEmpty}
            className="px-2.5 py-1 rounded-md bg-zinc-800 border border-zinc-700/50 hover:bg-zinc-700 text-[11px] text-zinc-400 hover:text-zinc-200 font-medium transition-colors"
          >
            ＋ 新对话
          </button>
          {messageCount === 0 && (
            <button
              onClick={resetToMock}
              className="px-2.5 py-1 rounded-md bg-zinc-800/50 border border-zinc-700/30 hover:bg-zinc-700 text-[11px] text-zinc-500 hover:text-zinc-300 font-medium transition-colors"
            >
              加载演示
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Canvas mode toggle — only when there are branches */}
          {branchCount > 0 && (
            <button
              onClick={() => setViewMode('canvas')}
              className="px-2.5 py-1 rounded-md bg-zinc-800 border border-zinc-700/50 hover:bg-zinc-700 text-[11px] text-zinc-400 hover:text-zinc-200 font-medium transition-colors flex items-center gap-1"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h7" />
              </svg>
              画布模式
            </button>
          )}
          <SettingsButton />
        </div>
      </header>

      {/* Main content area */}
      <div className="flex-1 flex min-h-0">
        {/* Left: Main chat */}
        <div className="flex-1 flex flex-col min-w-0">
          <LinearChatView />
        </div>

        {/* Right sidebar */}
        <div
          className={`shrink-0 border-l border-zinc-800 bg-zinc-900/30 flex flex-col transition-all duration-200 ${
            activeBranchPanelId ? 'w-[420px]' : 'w-56'
          }`}
        >
          {activeBranchPanelId ? (
            <BranchPanel branchId={activeBranchPanelId} />
          ) : (
            <div className="flex-1 overflow-y-auto">
              <ContentOutline />
            </div>
          )}
        </div>
      </div>

      {/* Chat input (overlays bottom of the main area) */}
      <SelectionPopover />
      <ChatInput />
    </main>
  );
}
