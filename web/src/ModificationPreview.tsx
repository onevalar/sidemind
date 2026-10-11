import { useMemo } from 'react'
import { editPreview } from './edit-preview'

export function ModificationPreview({ original, replacement }: {
  original: string; replacement: string
}) {
  const preview = useMemo(() => editPreview(original, replacement), [original, replacement])
  return <section className="modification-preview compact" aria-label="修改对比">
    {!preview.changed ? <p className="muted" role="status">内容未发生变化。</p> : <div className="proposal-content" tabIndex={0} aria-label="修改前后对比">
      {!!preview.hiddenLeading && <p className="proposal-omitted">开头 {preview.hiddenLeading} 行未改动</p>}
      {preview.leadingContext && <pre className="proposal-context">{preview.leadingContext}</pre>}
      <div className="proposal-fragment"><span className="proposal-label">− 原文片段</span><pre className="removed">{preview.removed || '（此处无原文）'}</pre></div>
      <div className="proposal-fragment"><span className="proposal-label">+ 修改后片段</span><pre className="added">{preview.added || '（删除此处内容）'}</pre></div>
      {preview.trailingContext && <pre className="proposal-context">{preview.trailingContext}</pre>}
      {!!preview.hiddenTrailing && <p className="proposal-omitted">结尾 {preview.hiddenTrailing} 行未改动</p>}
      <details className="proposal-full"><summary>查看完整修改前后内容</summary><span className="proposal-label">修改前</span><pre>{original}</pre><span className="proposal-label">修改后</span><pre>{replacement}</pre></details>
    </div>}
  </section>
}
