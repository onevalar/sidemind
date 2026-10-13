'use client';
import { useState } from 'react';
import { useChatStore } from '../store';
import type { ConversationSnapshot } from '../types';
import { Button, Dialog, Icon, Input } from './ui';

export function ConversationSpaces({ history, onNavigate }: { history: ConversationSnapshot[]; onNavigate?: () => void }) {
  const spaces = useChatStore(s => s.spaces);
  const locations = useChatStore(s => s.conversationSpaces);
  const active = useChatStore(s => s.activeSpaceId);
  const [editing, setEditing] = useState<string | null | undefined>();
  const [name, setName] = useState('');
  const [removing, setRemoving] = useState(false);
  function edit(id: string | null) { setEditing(id); setName(id ? spaces[id].name : ''); }
  function save() {
    const store = useChatStore.getState();
    if (editing) store.renameSpace(editing, name); else store.createSpace(name);
    setEditing(undefined);
  }
  return <>
    <Button variant={active === null ? 'secondary' : 'ghost'} className="space-all" onPress={() => { useChatStore.getState().setActiveSpace(null); onNavigate?.(); }} aria-label="所有对话"><Icon name="grid" size={15}/><span>所有对话</span></Button>
    <div className="sidebar-section-label space-heading"><span>对话空间</span><Button variant="ghost" size="sm" isIconOnly aria-label="新建对话空间" onPress={() => edit(null)}><Icon name="plus" size={13}/></Button></div>
    <div className="space-list">{Object.values(spaces).map(space => <div className="space-row" key={space.id}>
      <Button variant={active === space.id ? 'secondary' : 'ghost'} onPress={() => { useChatStore.getState().setActiveSpace(space.id); onNavigate?.(); }} aria-label={'筛选空间：' + space.name}><Icon name="folder" size={15}/><span>{space.name}</span><small>{history.filter(c => locations[c.id] === space.id).length}</small></Button>
      <Button variant="ghost" size="sm" isIconOnly className="space-edit" aria-label={'管理空间：' + space.name} onPress={() => edit(space.id)}><Icon name="settings" size={12}/></Button>
    </div>)}</div>
    <Dialog open={editing !== undefined} onClose={() => setEditing(undefined)} title={editing ? '管理对话空间' : '新建对话空间'} footer={<>
      {editing && <Button variant="danger-soft" onPress={() => setRemoving(true)}>删除空间</Button>}
      <Button variant="tertiary" onPress={() => setEditing(undefined)}>取消</Button><Button onPress={save} isDisabled={!name.trim()}>保存空间</Button>
    </>}><Input autoFocus fullWidth aria-label="空间名称" maxLength={80} value={name} onChange={event => setName(event.target.value)} placeholder="例如：产品与设计"/></Dialog>
    <Dialog open={removing} onClose={() => setRemoving(false)} title="删除这个空间？" footer={<><Button variant="tertiary" onPress={() => setRemoving(false)}>取消</Button><Button variant="danger" onPress={() => { if (editing) useChatStore.getState().deleteSpace(editing); setRemoving(false); setEditing(undefined); }}>删除空间，保留对话</Button></>}><p className="field-help">空间中的对话和分支会保留，可从“所有对话”中继续打开。</p></Dialog>
  </>;
}

export function ConversationLocation() {
  const spaces = useChatStore(s => s.spaces);
  const id = useChatStore(s => s.activeConversationId);
  const location = useChatStore(s => s.conversationSpaces[id]);
  const [open, setOpen] = useState(false);
  const title = spaces[location]?.name || '未分组';
  function move(space: string | null) { useChatStore.getState().moveConversation(id, space); setOpen(false); }
  return <>
    <Button variant="ghost" size="sm" className="conversation-location" aria-label={'移动当前对话到空间，当前：' + title} onPress={() => setOpen(true)}><Icon name="folder" size={15}/><span>{title}</span></Button>
    <Dialog open={open} onClose={() => setOpen(false)} title="移动对话到空间"><div className="branch-picker">
      <Button variant={!location ? 'secondary' : 'ghost'} onPress={() => move(null)}>未分组</Button>
      {Object.values(spaces).map(space => <Button key={space.id} variant={location === space.id ? 'secondary' : 'ghost'} onPress={() => move(space.id)}><Icon name="folder" size={15}/>{space.name}</Button>)}
      {!Object.keys(spaces).length && <p className="field-help">从侧栏创建一个对话空间，就能将相关研究放在一起。</p>}
    </div></Dialog>
  </>;
}
