import { useMemo } from 'react'
import type { TurnDTO } from '../shared/types'
import { NODE_H, NODE_W, layoutGraph } from '../shared/graph'
import { Button } from './ui'

export type TurnState = 'answered' | 'running' | 'failed' | 'pending'
const stateText: Record<TurnState, string> = { answered: '已回答', running: '生成中', failed: '未成功', pending: '未回答' }
const clip = (text: string, max: number) => { const flat = text.replace(/\s+/g, ' ').trim(); return flat.length > max ? flat.slice(0, max) + '…' : flat }

/** The branches of one discussion as a graph: forks go sideways, a merge has several incoming lines. Choosing a node jumps to it. */
export function DiscussionGraph({ turns, states, current, onSelect }: { turns: TurnDTO[]; states: Record<string, TurnState>; current: string | null; onSelect: (id: string) => void }) {
  const layout = useMemo(() => layoutGraph(turns), [turns])
  const spot = new Map(layout.nodes.map(node => [node.id, node]))
  const byId = new Map(turns.map(turn => [turn.id, turn]))
  const forks = new Set(turns.flatMap(turn => turn.parents)).size
  return <div className="graph-scroll" role="group" aria-label="分支图">
    <div className="graph-canvas" style={{ width: layout.width, height: layout.height }}>
      <svg className="graph-edges" width={layout.width} height={layout.height} aria-hidden="true">
        {layout.edges.map(edge => {
          const from = spot.get(edge.from)!, to = spot.get(edge.to)!
          const x1 = from.x + NODE_W / 2, y1 = from.y + NODE_H, x2 = to.x + NODE_W / 2, y2 = to.y, mid = (y1 + y2) / 2
          return <path key={edge.from + '>' + edge.to} d={`M${x1},${y1} C${x1},${mid} ${x2},${mid} ${x2},${y2}`} data-merge={edge.merge || undefined}/>
        })}
      </svg>
      {layout.nodes.map(node => {
        const turn = byId.get(node.id)!, state = states[node.id] ?? 'pending'
        return <Button key={node.id} variant="ghost" size="sm" className="graph-node" data-state={state} data-merge={turn.parents.length > 1 || undefined} aria-current={current === node.id ? 'true' : undefined}
          style={{ left: node.x, top: node.y, width: NODE_W, height: NODE_H }} title={turn.question}
          aria-label={`${turn.parents.length > 1 ? '合并比较' : '问题'}：${clip(turn.question, 40)}（${stateText[state]}）`} onPress={() => onSelect(node.id)}>
          <span className="graph-node-title">{clip(turn.question, 26)}</span>
          <span className="graph-node-meta muted">{turn.parents.length > 1 ? `合并 ${turn.parents.length} 条 · ` : ''}{stateText[state]}</span>
        </Button>
      })}
    </div>
    <p className="muted graph-note">{turns.length} 个问题{forks ? ` · ${forks} 处分叉或合并的起点` : ''}。点击节点跳到对应的问答。</p>
  </div>
}
