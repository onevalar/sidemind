// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PushControl } from '../src/PushControl'
import { api } from '../src/api'
import type { SyncJobDTO } from '../shared/types'
vi.mock('../src/api', () => ({ api: { repoStatus: vi.fn(), syncStatus: vi.fn(), startSync: vi.fn(), stopSync: vi.fn() }, subscribeEvents: () => () => {} }))
const running: SyncJobDTO = { id: 'sync-1', status: 'running', enrich: false, startedAt: 1, updatedAt: 2, activity: '正在拉取远端更新并同步本机提交', events: [] }
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.mocked(api.repoStatus).mockResolvedValue({ git: true, dataDirectory: '/test', branch: 'main', changes: 12, noteChanges: 4, remote: 'https://example.test/notes.git', ahead: 0, head: 'abc', pushing: false })
  vi.mocked(api.syncStatus).mockResolvedValue(null)
  vi.mocked(api.startSync).mockResolvedValue(running)
  vi.mocked(api.stopSync).mockResolvedValue({ ...running, status: 'stopping', updatedAt: 3 })
})
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.unstubAllGlobals() })
const mount = () => render(<PushControl beforeLeave={{ current: async () => true }} collapsed={false}/>)
it('starts without a modal and closing details never stops the server job', async () => {
  const ui = mount()
  fireEvent.click(await screen.findByRole('button', { name: '同步 · 12 处改动' }))
  await waitFor(() => expect(api.startSync).toHaveBeenCalledExactlyOnceWith({ enrich: false }))
  expect(screen.queryByRole('dialog')).toBe(null)
  fireEvent.click(await screen.findByRole('button', { name: '同步详情' }))
  expect(await screen.findByRole('dialog', { name: '同步' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '后台继续' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBe(null))
  expect(api.stopSync).not.toHaveBeenCalled()
  ui.unmount()
  expect(api.stopSync).not.toHaveBeenCalled()
})
it('reconnects after remount and stops only through the explicit control', async () => {
  vi.mocked(api.syncStatus).mockResolvedValue(running)
  mount()
  fireEvent.click(await screen.findByRole('button', { name: '正在同步 · 查看进度' }))
  expect(await screen.findByRole('dialog')).toBeTruthy()
  expect(api.startSync).not.toHaveBeenCalled()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '停止任务' })))
  expect(api.stopSync).toHaveBeenCalledExactlyOnceWith('sync-1')
  expect(screen.getByRole('button', { name: '正在停止…' }).hasAttribute('disabled')).toBe(true)
})
it('shows a local-only result without treating deferred AI memories as sync failures', async () => {
  vi.mocked(api.repoStatus).mockResolvedValue({ git: true, dataDirectory: '/test', branch: 'main', changes: 0, noteChanges: 0, remote: null, ahead: null, head: 'abc', pushing: false })
  vi.mocked(api.syncStatus).mockResolvedValue({ ...running, status: 'completed', report: { committed: 'abc', pushed: false, pushError: '未配置远端', message: '内部提交说明', notes: [{ name: 'test.md', kind: 'new', memory: 'pending' }], folders: [], stale: [], layout: [] } })
  mount()
  fireEvent.click(await screen.findByRole('button', { name: '同步详情' }))
  expect(screen.getByRole('heading', { name: '已保存到本机' })).toBeTruthy()
  expect(screen.queryByRole('alert')).toBe(null)
  expect(screen.getByRole('button', { name: '查看本次内容' }).getAttribute('aria-expanded')).toBe('false')
  expect(screen.getByRole('button', { name: 'AI 记忆 · 1 篇待整理' }).getAttribute('aria-expanded')).toBe('false')
})
