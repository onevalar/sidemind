'use client';
import { useChatStore } from '../store';
import { Button, Icon } from './ui';
import type { BranchId, MessageId } from '../types';
export function ContentOutline({ branchId }: { branchId: BranchId }) {
  const messages = useChatStore(s => s.messages);
  const branches = useChatStore(s => s.branches);
  const root = useChatStore(s => s.rootBranchId);
  const blackboard = useChatStore(s => s.blackboard);
  const open = useChatStore(s => s.setActiveBranchPanel);
  const reveal = useChatStore(s => s.revealMessage);
  const entries: { id: MessageId; text: string; level: number; index: number }[] = [];
  for (const id of branches[branchId]?.messageIds ?? []) {
    const message = messages[id];
    if (message?.role !== 'assistant') continue;
    let fence: string | null = null;
    let index = 0;
    for (const line of message.content.split('\n')) {
      const code = /^\s*(\x60{3,}|~{3,})/.exec(line);
      if (code) { if (!fence) fence = code[1][0]; else if (code[1][0] === fence) fence = null; continue; }
      if (fence) continue;
      const heading = /^(#{1,6})\s+(.+)$/.exec(line);
      if (heading) { if (heading[1].length <= 3) entries.push({ id, text: heading[2].replace(/[*_\x60]/g, ''), level: heading[1].length, index }); index++; }
    }
  }
  const children = Object.values(branches).filter(b => b.id !== root);
  return <aside className="chat-outline">
    <div className="outline-heading"><Icon name="branch" size={16} /><strong>思路脉络</strong><span>{children.length} 分支</span></div><span className="eyebrow">当前内容</span>
    {entries.length ? <nav className="toc">{entries.map((entry, i) => <Button key={entry.id + ':' + i} variant="ghost" size="sm" className={entry.level === 3 ? 'toc-sub' : ''} onPress={() => {
      const article = document.getElementById('msg-' + entry.id);
      const headings = article?.querySelectorAll('.markdown-body :is(h1,h2,h3,h4,h5,h6)');
      (headings?.[entry.index] || article)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }}>{entry.text}</Button>)}</nav> : <p className="outline-empty">回复中的标题会自动成为目录。</p>}
    <div className="outline-divider" /><span className="eyebrow">分支对话</span>
    <Button variant={branchId === root ? 'secondary' : 'ghost'} className="branch-nav" onPress={() => open(null)}><Icon name="chat" size={15} /><span>主线对话</span></Button>
    {children.map(branch => <Button key={branch.id} variant={branchId === branch.id ? 'secondary' : 'ghost'} className="branch-nav" onPress={() => open(branch.id)}><Icon name="branch" size={15} /><span>{branch.label}<small>{branch.status === 'streaming' ? '正在生成…' : branch.messageIds.length + ' 条消息'}</small></span></Button>)}
    {!children.length && <p className="outline-empty">划选回复里的文字，开启第一个分支。</p>}
    {Object.values(blackboard).length > 0 && <><div className="outline-divider" /><span className="eyebrow">共享结论</span>{Object.values(blackboard).sort((a, b) => b.updatedAt - a.updatedAt).map(entry => {
      const branch = branches[entry.branchId];
      const source = entry.sourceMessageId && messages[entry.sourceMessageId];
      const exactSource = source && source.branchId === entry.branchId && branch?.messageIds.includes(source.id);
      const date = Number.isFinite(entry.updatedAt) && entry.updatedAt > 0 ? new Date(entry.updatedAt) : null;
      const validDate = date && Number.isFinite(date.getTime());
      return <section className="blackboard-entry" key={entry.branchId} aria-label={'共享结论：' + (branch?.label || '来源已移除')}>
        <strong>{branch?.label || '来源已移除'}{entry.example ? ' · 示例' : ''}</strong><p>{entry.summary}</p>
        <div className="blackboard-meta">{validDate && <time dateTime={date.toISOString()} title={date.toLocaleString('zh-CN')}>更新于 {date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>}</div>
        {branch && <Button size="sm" variant="ghost" className="blackboard-source" aria-label={(exactSource ? '返回结论原文：' : '打开来源分支：') + branch.label} onPress={() => exactSource ? reveal(source.id) : open(branch.id === root ? null : branch.id)}><Icon name="branch" size={13} /><span>{exactSource ? '返回结论原文' : '打开来源分支'}</span></Button>}
      </section>;
    })}</>}
    <p className="outline-footnote">分支独立展开，结论进入共享上下文。</p>
  </aside>;
}
