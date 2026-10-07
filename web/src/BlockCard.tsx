import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { BlockDTO } from '../shared/types'

export type BlockNode = Node<{ block: BlockDTO; placed: boolean }, 'block'>

const LABELS: Record<string, string> = {
  paragraph: '段落',
  list: '列表',
  code: '代码',
  blockquote: '引用',
  table: '表格',
  thematicBreak: '分隔线',
  html: 'HTML',
}

export const labelFor = (type: string) =>
  type.startsWith('heading-') ? `标题 ${type.slice(8)}` : (LABELS[type] ?? type)

export const CARD_WIDTH = 360

export function BlockCard({ data, selected }: NodeProps<BlockNode>) {
  const { block } = data
  return (
    <div className={`card${selected ? ' selected' : ''}`} style={{ width: CARD_WIDTH }}>
      <Handle type="target" position={Position.Top} className="handle" isConnectable={false} />
      <div className="card-label">{labelFor(block.type)}</div>
      <div className="card-body">
        {block.type === 'html' ? (
          // Raw HTML from a note is shown as text, never executed.
          <pre>{block.raw}</pre>
        ) : (
          <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>
            {block.raw}
          </ReactMarkdown>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} className="handle" isConnectable={false} />
    </div>
  )
}
