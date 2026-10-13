'use client';
import { useState } from 'react';
import { useChatStore } from '../store';
import { Button, Dialog, TextArea, Icon, Input } from './ui';
import type { AnchorIntent, BranchId, UIState } from '../types';

export function SelectionPopover() {
  const selection = useChatStore(s => s.ui.pendingSelection);
  return selection && <SelectionDialog key={selection.messageId + ':' + selection.slice.startOffset + ':' + selection.slice.endOffset} selection={selection} />;
}
function SelectionDialog({ selection }: { selection: NonNullable<UIState['pendingSelection']> }) {
  const branches = useChatStore(s => s.branches);
  const root = useChatStore(s => s.rootBranchId);
  const ask = useChatStore(s => s.askFromSelection);
  const close = useChatStore(s => s.setPendingSelection);
  const open = useChatStore(s => s.setActiveBranchPanel);
  const [intent, setIntent] = useState<AnchorIntent>('new-branch');
  const [target, setTarget] = useState<BranchId | null>(null);
  const [question, setQuestion] = useState('');
  const [branchLabel, setBranchLabel] = useState(selection.slice.selectedText.replace(/\s+/g, ' ').slice(0, 28));
  const [error, setError] = useState('');
  const children = Object.values(branches).filter(b => b.id !== root);
  const targetId = intent === 'main' ? root : intent === 'existing-branch' ? target : null;
  const busy = targetId && branches[targetId]?.status === 'streaming';
  function dismiss() { close(null); window.getSelection()?.removeAllRanges(); }
  function submit() {
    if (!question.trim() || busy || (intent === 'existing-branch' && !target)) return;
    const id = ask({ ...selection, intent, question, branchLabel, targetBranchId: targetId ?? undefined });
    if (!id) { setError('目标分支正在生成，请稍后重试。'); return; }
    open(id === root ? null : id); dismiss(); useChatStore.getState().setViewMode('linear');
  }
  return <Dialog open onClose={dismiss} title="沿着这个想法，继续探索" footer={<>
    <Button variant="tertiary" onPress={dismiss}>取消</Button>
    <Button variant="primary" isDisabled={!question.trim() || Boolean(busy) || (intent === 'existing-branch' && !target)} onPress={submit}>发送问题</Button>
  </>}>
    <p className="field-help">选中的内容会作为问题背景，原对话和引用位置会被保留。</p>
    <blockquote className="selection-quote">{selection.slice.selectedText}</blockquote>
    <div className="intent-options">
      {([['new-branch', '创建新分支'], ['main', '在主线追问'], ['existing-branch', '追加到分支']] as const).map(([value, label]) =>
        <Button key={value} variant={intent === value ? 'secondary' : 'outline'} size="sm" onPress={() => setIntent(value)} isDisabled={value === 'existing-branch' && !children.length}><Icon name="branch" size={15} />{label}</Button>)}
    </div>
    {intent === 'existing-branch' && <div className="branch-picker">{children.map(branch => <Button key={branch.id} variant={target === branch.id ? 'secondary' : 'ghost'} onPress={() => setTarget(branch.id)}>{branch.label}</Button>)}</div>}
    {intent === 'new-branch' && <><label className="field-label" htmlFor="new-branch-name">分支名称</label><Input id="new-branch-name" fullWidth maxLength={120} value={branchLabel} onChange={event => setBranchLabel(event.target.value)} placeholder="例如：空间如何帮助记忆"/></>}
    <label className="field-label" htmlFor="selection-question">你想深入了解什么？</label>
    <TextArea id="selection-question" autoFocus fullWidth rows={3} value={question} onChange={event => setQuestion(event.target.value)} placeholder="进一步解释、比较，或探索另一个角度…" />
    {busy && <p className="field-help">这个分支仍在生成，请稍等。</p>}{error && <p role="alert">{error}</p>}
  </Dialog>;
}
