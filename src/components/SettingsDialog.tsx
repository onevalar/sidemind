'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useChatStore } from '../store';
import type { ChatState } from '../types';

type Provider = ChatState['provider'];

const PROVIDERS: {
  id: Provider;
  name: string;
  placeholder: string;
  defaultBaseUrl: string;
  hint: string;
}[] = [
  {
    id: 'zhipu',
    name: '智谱 AI',
    placeholder: '你的智谱 API Key',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    hint: '前往 open.bigmodel.cn 获取 API Key，免费模型：glm-4-flash',
  },
  {
    id: 'anthropic',
    name: 'Anthropic (Claude)',
    placeholder: 'sk-ant-api03-…',
    defaultBaseUrl: 'https://api.anthropic.com',
    hint: '前往 console.anthropic.com 获取 API Key，使用模型：claude-haiku',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    placeholder: 'sk-…',
    defaultBaseUrl: 'https://api.openai.com/v1',
    hint: '前往 platform.openai.com 获取 API Key，使用模型：gpt-4o-mini',
  },
];

export function SettingsButton() {
  const [open, setOpen] = useState(false);
  const apiKey = useChatStore((s) => s.apiKey);

  useEffect(() => {
    if (!apiKey) setOpen(true);
  }, [apiKey]);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="w-8 h-8 rounded-lg bg-zinc-800 border border-zinc-700/50 hover:bg-zinc-700 flex items-center justify-center transition-colors"
        title="设置"
      >
        <svg className="w-4 h-4 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
        {!apiKey && (
          <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-red-500" />
        )}
      </button>

      <AnimatePresence>
        {open && <SettingsDialog onClose={() => setOpen(false)} />}
      </AnimatePresence>
    </>
  );
}

function SettingsDialog({ onClose }: { onClose: () => void }) {
  const storedApiKey = useChatStore((s) => s.apiKey);
  const storedProvider = useChatStore((s) => s.provider);
  const storedBaseUrl = useChatStore((s) => s.baseUrl);
  const setApiKey = useChatStore((s) => s.setApiKey);
  const setProvider = useChatStore((s) => s.setProvider);
  const setBaseUrl = useChatStore((s) => s.setBaseUrl);

  const [draftKey, setDraftKey] = useState(storedApiKey);
  const [draftProvider, setDraftProvider] = useState<Provider>(storedProvider);
  const [draftBaseUrl, setDraftBaseUrl] = useState(storedBaseUrl);
  const [showKey, setShowKey] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const providerInfo = PROVIDERS.find((p) => p.id === draftProvider)!;

  // When switching provider, reset baseUrl draft to default
  const handleProviderChange = (p: Provider) => {
    setDraftProvider(p);
    setDraftBaseUrl('');
  };

  const handleSave = () => {
    setProvider(draftProvider);
    setApiKey(draftKey);
    setBaseUrl(draftBaseUrl);
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  };

  const effectiveBaseUrl = draftBaseUrl || providerInfo.defaultBaseUrl;

  return (
    <>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: -8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: -8 }}
        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
        className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="bg-zinc-900 border border-zinc-700 rounded-2xl shadow-2xl shadow-black/60 p-6">
          <h2 className="text-base font-semibold text-zinc-100 mb-1">设置</h2>
          <p className="text-xs text-zinc-500 mb-5">
            API Key 仅保存在本地浏览器，不会传至任何第三方。
          </p>

          {/* Provider selector */}
          <label className="block mb-2 text-xs font-medium text-zinc-400">
            服务商
          </label>
          <div className="grid grid-cols-3 gap-2 mb-4">
            {PROVIDERS.map((p) => (
              <button
                key={p.id}
                onClick={() => handleProviderChange(p.id)}
                className={`py-2 px-3 rounded-xl border text-xs font-medium transition-all ${
                  draftProvider === p.id
                    ? 'border-indigo-500 bg-indigo-500/10 text-indigo-300'
                    : 'border-zinc-700 bg-zinc-800/40 text-zinc-400 hover:bg-zinc-800'
                }`}
              >
                {p.name}
              </button>
            ))}
          </div>

          {/* API Key input */}
          <label className="block mb-1.5 text-xs font-medium text-zinc-400">
            API Key
          </label>
          <div className="relative mb-1.5">
            <input
              autoFocus
              type={showKey ? 'text' : 'password'}
              value={draftKey}
              onChange={(e) => setDraftKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSave();
                if (e.key === 'Escape') onClose();
              }}
              placeholder={providerInfo.placeholder}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-xl px-3 py-2.5 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/30 transition-colors pr-10"
            />
            <button
              type="button"
              onClick={() => setShowKey((v) => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              {showKey ? (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                </svg>
              )}
            </button>
          </div>
          <p className="text-[11px] text-zinc-600 mb-4">{providerInfo.hint}</p>

          {/* Advanced: custom base URL */}
          <button
            onClick={() => setShowAdvanced((v) => !v)}
            className="flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors mb-3"
          >
            <svg className={`w-3 h-3 transition-transform ${showAdvanced ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
            高级选项
          </button>

          {showAdvanced && (
            <div className="mb-4">
              <label className="block mb-1.5 text-xs font-medium text-zinc-400">
                自定义 Base URL
              </label>
              <input
                type="text"
                value={draftBaseUrl}
                onChange={(e) => setDraftBaseUrl(e.target.value)}
                placeholder={effectiveBaseUrl}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-xl px-3 py-2.5 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/30 transition-colors"
              />
              <p className="text-[11px] text-zinc-600 mt-1">
                留空则使用默认：{providerInfo.defaultBaseUrl}
              </p>
            </div>
          )}

          <div className="flex gap-2 justify-end">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-xl text-sm text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
            >
              取消
            </button>
            <button
              onClick={handleSave}
              disabled={!draftKey.trim()}
              className="px-4 py-2 rounded-xl text-sm font-medium bg-indigo-600 hover:bg-indigo-500 text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              保存
            </button>
          </div>
        </div>
      </motion.div>
    </>
  );
}
