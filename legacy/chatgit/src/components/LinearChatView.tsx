'use client';
import { useEffect, useRef, useState } from 'react';
import { useChatStore } from '../store';
import { conversationConnection } from '../connections';
import { MessageBody } from './MessageBody';
import { Button, Icon } from './ui';
import type { BranchId } from '../types';
const EMPTY_IDS: string[] = [];

export function LinearChatView({ branchId }: { branchId: BranchId }) {
  const ids = useChatStore(s => s.branches[branchId]?.messageIds ?? EMPTY_IDS);
  const messages = useChatStore(s => s.messages);
  const status = useChatStore(s => s.branches[branchId]?.status);
  const model = useChatStore(s => conversationConnection(s).model);
  const reveal = useChatStore(s => s.ui.messageReveal);
  const handledReveal = useRef<{ target: typeof reveal; count: number } | null>(null);
  const revealBelongs = Boolean(reveal && ids.includes(reveal.messageId));
  const scroll = useRef<HTMLDivElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const last = messages[ids.at(-1) ?? ''];
  const lastLength = last?.content.length ?? 0;
  useEffect(() => {
    const behavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    const previous = handledReveal.current;
    handledReveal.current = { target: reveal, count: ids.length };
    if (reveal && revealBelongs && (previous?.target !== reveal || previous.count === ids.length)) {
      const article = document.getElementById('msg-' + reveal.messageId);
      article?.focus({ preventScroll: true });
      article?.scrollIntoView({ behavior, block: 'start' });
      return;
    }
    bottom.current?.scrollIntoView({ behavior });
  }, [ids.length, branchId, reveal, revealBelongs]);
  useEffect(() => {
    const el = scroll.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 140) el.scrollTop = el.scrollHeight;
  }, [lastLength]);
  if (!ids.length) return <div className="chat-empty">
    <div className="empty-mark"><Icon name="branch" size={28} /></div>
    <span className="eyebrow">A SPACE FOR CONNECTED THINKING</span>
    <h1>让每一个问题，都有继续的空间。</h1>
    <p>从一个问题开始。在回复中划选你感兴趣的内容，<br />创建分支深入探索，主线始终保持清晰。</p>
    <div className="empty-features"><span><Icon name="chat" />自由对话</span><span><Icon name="branch" />分支探索</span><span><Icon name="grid" />全局画布</span></div>
  </div>;
  return <div ref={scroll} className="message-scroll"><div className="message-list">
    {ids.map(id => {
      const message = messages[id];
      if (!message) return null;
      const user = message.role === 'user';
      return <article id={'msg-' + id} tabIndex={-1} key={id} className={'message ' + (user ? 'message-user' : 'message-assistant')}>
        {!user && <div className="message-author"><span className="assistant-avatar"><Icon name="branch" size={14} /></span><strong>ChatGit</strong><span>{message.example ? '示例内容' : model || 'AI'}</span></div>}
        <div className="message-content" data-message-id={id} data-role={message.role}>
          <MessageBody message={message} />
          {!message.content && !message.error && status === 'streaming' && id === last?.id && <p className="thinking" role="status">正在思考<span>···</span></p>}
        </div>
        {!user && message.content && <div className="message-actions">
          <Button size="sm" variant="ghost" aria-label="复制回复" onPress={async () => {
            try { await navigator.clipboard.writeText(message.content); setCopied(id); setTimeout(() => setCopied(null), 1800); }
            catch { setCopied('failed-' + id); }
          }}><Icon name="copy" size={14} />{copied === id ? '已复制' : copied === 'failed-' + id ? '复制失败' : '复制'}</Button>
          {message.anchorIds.length > 0 && <span><Icon name="branch" size={13} />{message.anchorIds.length} 处关联</span>}
        </div>}
      </article>;
    })}<div ref={bottom} />
  </div></div>;
}
