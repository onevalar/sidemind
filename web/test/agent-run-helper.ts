import { expect } from 'vitest'
import type { createApp } from '../server/app'
import type { AgentEvent, AgentRunDTO, AgentScope } from '../shared/types'

const H = { host: 'localhost:3001' }

/** Starts a Note Agent run and returns every event it produced, in order, once it has finished. */
export async function runAgent(app: ReturnType<typeof createApp>, scope: AgentScope, message: string, session?: string): Promise<AgentEvent[]> {
  const started = await app.request('/api/agent-runs', { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ requestKey: crypto.randomUUID(), scope, message, session }) })
  const text = await started.text()
  expect(started.status, text).toBe(202)
  const run = JSON.parse(text) as AgentRunDTO
  const stream = await app.request(`/api/agent-runs/${run.id}/events`, { headers: H })
  expect(stream.status).toBe(200)
  const events: AgentEvent[] = []
  for (const block of (await stream.text()).split('\n\n')) {
    if (!/^event: agent$/m.test(block)) continue
    events.push((JSON.parse(/^data: (.*)$/m.exec(block)![1]!) as { event: AgentEvent }).event)
  }
  return events
}
