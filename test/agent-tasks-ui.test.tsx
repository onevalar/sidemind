// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentTasks, useAgentTasks } from '../src/AgentTasks'
import { api } from '../src/api'
import type { AgentRunDTO } from '../shared/types'

vi.mock('../src/api', () => ({ api: { agentRuns: vi.fn(), stopAgentRun: vi.fn() }, subscribeEvents: () => () => {} }))
const running: AgentRunDTO = { id: 'r1', scope: { kind: 'note', folder: '物理', name: '物理/反射.md' }, session: 'session1', requestKey: 'test', status: 'running', seq: 1, createdAt: 1, updatedAt: 2, request: '重新分段并保留原意', activity: '正在读取文章' }
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  localStorage.clear()
})
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.unstubAllGlobals() })

it('shows the exact article task outside its conversation and returns to the same run', () => {
  const onOpen = vi.fn(), refresh = vi.fn()
  render(<AgentTasks runs={[running]} error="" refresh={refresh} collapsed={false} onOpen={onOpen}/>)
  expect(screen.getByRole('button', { name: 'AI 任务 · 1 项进行中' })).toBeTruthy()
  expect(screen.getByText('正在读取文章')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '返回任务：反射' }))
  expect(onOpen).toHaveBeenCalledWith(running)
})

it('keeps the task entry accessible when navigation is collapsed and only explicit stop stops it', async () => {
  const refresh = vi.fn()
  vi.mocked(api.stopAgentRun).mockResolvedValue({ ...running, status: 'cancelled' })
  render(<AgentTasks runs={[running]} error="" refresh={refresh} collapsed onOpen={vi.fn()}/>)
  fireEvent.click(screen.getByRole('button', { name: 'AI 任务 · 1 项进行中' }))
  expect(screen.getByRole('dialog', { name: 'AI 任务' }).textContent).toContain('重新分段并保留原意')
  fireEvent.click(screen.getByRole('button', { name: '关闭对话框' }))
  expect(api.stopAgentRun).not.toHaveBeenCalled()
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'AI 任务' })).toBeNull())
  fireEvent.click(screen.getByRole('button', { name: 'AI 任务 · 1 项进行中' }))
  fireEvent.click(screen.getByRole('button', { name: '停止任务' }))
  await waitFor(() => expect(api.stopAgentRun).toHaveBeenCalledWith('r1'))
})

it('preserves last known work during connection errors and refreshes terminal results', async () => {
  vi.mocked(api.agentRuns).mockResolvedValue([running])
  const { result } = renderHook(() => useAgentTasks())
  await waitFor(() => expect(result.current.runs).toEqual([running]))
  vi.mocked(api.agentRuns).mockRejectedValueOnce(new Error('offline'))
  act(() => result.current.refresh())
  await waitFor(() => expect(result.current.error).toBeTruthy())
  expect(result.current.runs).toEqual([running])
  vi.mocked(api.agentRuns).mockResolvedValue([{ ...running, status: 'completed' }])
  act(() => result.current.refresh())
  await waitFor(() => expect(result.current.runs[0]?.status).toBe('completed'))
  expect(result.current.error).toBe('')
})

it('retains a completion update across remount until the user checks tasks', () => {
  localStorage.setItem('sidemind.agent-tasks-seen', '1')
  const view = render(<AgentTasks runs={[{ ...running, status: 'completed' }]} error="" refresh={vi.fn()} collapsed={false} onOpen={vi.fn()}/>)
  fireEvent.click(screen.getByRole('button', { name: 'AI 任务 · 1 项有更新' }))
  fireEvent.click(screen.getByRole('button', { name: '关闭对话框' }))
  view.unmount()
  render(<AgentTasks runs={[{ ...running, status: 'completed' }]} error="" refresh={vi.fn()} collapsed={false} onOpen={vi.fn()}/>)
  expect(screen.getByRole('button', { name: 'AI 任务' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'AI 任务 · 1 项有更新' })).toBeNull()
})
