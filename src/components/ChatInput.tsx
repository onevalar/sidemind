'use client';
import { useState, useRef } from 'react';
import { useChatStore } from '../store';
import { Button, TextArea, Icon } from './ui';
import { conversationConnection } from '../connections';
import type { BranchId } from '../types';

export function ChatInput({ branchId }: { branchId: BranchId }) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const status = useChatStore(s => s.branches[branchId]?.status);
  const model = useChatStore(s => conversationConnection(s).model);
  const sendMessage = useChatStore(s => s.sendMessage);
  const stop = useChatStore(s => s.stopGeneration);
  const streaming = status === 'streaming';
  async function send() {
    const value = text.trim();
    if (!value || streaming) return;
    setText('');
    const result = await sendMessage(branchId, value);
    if (result === 'busy') setText(value);
    ref.current?.focus();
  }
  return <div className="composer-wrap">
    <div className="composer">
      <TextArea ref={ref} aria-label="消息" placeholder="把问题展开，思路留在这里…" rows={2} value={text}
        onChange={event => setText(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
      <div className="composer-bottom"><span className="model-label"><span className="status-dot" />{model}</span>
        <Button variant="primary" size="sm" isIconOnly aria-label={streaming ? '停止生成' : '发送消息'}
          isDisabled={!streaming && !text.trim()} onPress={() => { if (streaming) stop(); else void send(); }}>
          <Icon name={streaming ? 'stop' : 'arrow'} size={16} />
        </Button>
      </div>
    </div>
    <p className="composer-hint">划选回复中的文字，继续追问或开启分支 · Enter 发送，Shift + Enter 换行</p>
  </div>;
}
