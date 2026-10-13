'use client';
import { memo, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { BranchCardData } from '../../lib/branch-canvas';
import { useChatStore } from '../../store';
import { Button, Dialog, Icon, Input } from '../ui';

function BranchNodeInner({ data }: NodeProps) {
  const card = data as BranchCardData;
  const active = useChatStore(s => (s.ui.activeBranchPanelId || s.rootBranchId) === card.branch.id);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(card.branch.label);
  function read() {
    const store = useChatStore.getState();
    store.setActiveBranchPanel(card.isRoot ? null : card.branch.id);
    store.setViewMode('linear');
  }
  const status = card.branch.status;
  return <>
    <Handle type="target" position={Position.Left} className="branch-handle" />
    <article className={'branch-card ' + (active ? 'branch-card-active' : '')} data-branch-id={card.branch.id}>
      <header className="branch-card-drag"><span><Icon name="branch" size={13}/>{card.isRoot ? '主线' : '分支'} · {card.messageCount} 条消息</span><Button variant="ghost" size="sm" isIconOnly className="nodrag nopan" aria-label={'重命名分支：' + card.branch.label} onPress={() => { setName(card.branch.label); setEditing(true); }}><Icon name="settings" size={12}/></Button></header>
      <h3>{card.title}</h3>
      <div className="branch-card-preview"><span>{card.isExample ? '示例内容' : card.previewKind === 'conclusion' ? '共享结论' : card.previewKind === 'reply' ? '最近回复' : '问题'}</span><p>{card.preview || '打开对话，继续展开这个想法。'}</p></div>
      <footer><span className={status === 'error' ? 'branch-status-error' : ''}>{status === 'streaming' ? '正在生成…' : status === 'error' ? '回复未完成' : active ? '正在阅读' : card.sourceLabel ? '引用自 ' + card.sourceLabel : '主线对话'}</span><Button variant="ghost" size="sm" className="nodrag nopan" aria-label={'阅读分支：' + card.branch.label} onPress={read}>展开阅读<Icon name="back" size={12}/></Button></footer>
    </article>
    <Handle type="source" position={Position.Right} className="branch-handle"/>
    <Dialog open={editing} onClose={() => setEditing(false)} title="分支名称" footer={<><Button variant="tertiary" onPress={() => setEditing(false)}>取消</Button><Button isDisabled={!name.trim()} onPress={() => { useChatStore.getState().renameBranch(card.branch.id, name); setEditing(false); }}>保存名称</Button></>}><Input fullWidth autoFocus aria-label="分支名称" maxLength={120} value={name} onChange={event => setName(event.target.value)}/></Dialog>
  </>;
}
export const BranchNodeComponent = memo(BranchNodeInner);
