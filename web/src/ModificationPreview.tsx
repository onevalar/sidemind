import { useMemo } from 'react'
import { editPreview } from './edit-preview'
import { Button, Icon } from './ui'

export function ModificationPreview({ original, replacement, onDiscard, onApply, compact = false }: {
  original: string; replacement: string; onDiscard: () => void; onApply: () => void; compact?: boolean
}) {
  const preview = useMemo(() => editPreview(original, replacement), [original, replacement])
  return <section className={'modification-preview' + (compact ? ' compact' : '')} aria-label="修改预览">
    <div className="proposal-heading"><div><strong>修改预览</strong><span className="muted">尚未应用</span></div><div className="toolbar"><Button size="sm" variant="ghost" onPress={onDiscard}>放弃</Button><Button size="sm" isDisabled={!preview.changed} onPress={onApply}><Icon name="check"/>应用修改</Button></div></div>
    {!preview.changed ? <p className="muted" role="status">模型未对所选内容作出修改。</p> : <div className="proposal-content" tabIndex={0} aria-label="原文与建议对比">
      {!!preview.hiddenLeading && <p className="proposal-omitted">开头 {preview.hiddenLeading} 行未改动</p>}
      {preview.leadingContext && <pre className="proposal-context">{preview.leadingContext}</pre>}
      <div className="proposal-fragment"><span className="proposal-label">− 原文片段</span><pre className="removed">{preview.removed || '（此处无原文）'}</pre></div>
      <div className="proposal-fragment"><span className="proposal-label">+ 建议片段</span><pre className="added">{preview.added || '（删除此处内容）'}</pre></div>
      {preview.trailingContext && <pre className="proposal-context">{preview.trailingContext}</pre>}
      {!!preview.hiddenTrailing && <p className="proposal-omitted">结尾 {preview.hiddenTrailing} 行未改动</p>}
      <details className="proposal-full"><summary>查看完整原文与建议</summary><span className="proposal-label">原文</span><pre>{original}</pre><span className="proposal-label">建议</span><pre>{replacement}</pre></details>
    </div>}
  </section>
}
