import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ConnectRequest, SessionRecord } from '../src/shared/types'
import { SessionManager } from '../src/main/session/manager'
import { getAdapter } from '../src/main/protocols/registry'

/** 验证连接失败后 endSession() 不把 failed 改写成 ended（历史状态污染修复） */
const h = vi.hoisted(() => {
  const sessions: SessionRecord[] = []
  const plain = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), event: vi.fn() }
  const scoped = vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    event: vi.fn()
  }))
  const store = {
    listDevices: vi.fn(() => [] as unknown[]),
    listCredentials: vi.fn(() => [] as unknown[]),
    addSession: vi.fn((row: SessionRecord) => sessions.push(row)),
    updateSession: vi.fn((row: SessionRecord) => {
      const idx = sessions.findIndex((s) => s.id === row.id)
      if (idx >= 0) sessions[idx] = row
    })
  }
  return { sessions, plain, scoped, store }
})

vi.mock('../src/main/logger', () => ({ logger: h.plain, scopedLogger: h.scoped }))
vi.mock('../src/main/protocols/registry', () => ({ getAdapter: vi.fn() }))
vi.mock('../src/main/store', () => ({
  getStore: () => h.store,
  getSettings: () => ({}),
  now: () => '2026-11-22T12:00:00.000Z',
  rowToDevice: (row: { name?: string }) => ({ name: row.name ?? '' })
}))

const mockedGetAdapter = vi.mocked(getAdapter)

function makeRequest(): ConnectRequest {
  return { deviceId: 'dev-x', ip: '192.168.1.88', protocol: 'rdp' }
}

beforeEach(() => {
  h.sessions.length = 0
  h.store.addSession.mockClear()
  h.store.updateSession.mockClear()
})

describe('P1 修复 - failed 会话状态不被 endSession 覆盖', () => {
  it('连接失败后 endSession() 返回 false，记录仍为 failed', async () => {
    mockedGetAdapter.mockReturnValue({
      connect: vi.fn().mockRejectedValue(new Error('调起失败'))
    } as unknown as ReturnType<typeof getAdapter>)

    const manager = new SessionManager()
    const result = await manager.connect(makeRequest())
    expect(result.ok).toBe(false)

    // 失败记录已落库，状态为 failed
    expect(h.sessions).toHaveLength(1)
    expect(h.sessions[0].status).toBe('failed')

    // UI/托盘再点"结束会话"：应短路，不改写历史
    const ended = manager.endSession('manual')
    expect(ended).toBe(false)
    expect(h.sessions[0].status).toBe('failed')
  })

  it('failed 之后再 connect 可正常开启新会话（状态机不卡死）', async () => {
    mockedGetAdapter
      .mockReturnValueOnce({
        connect: vi.fn().mockRejectedValue(new Error('第一次失败'))
      } as unknown as ReturnType<typeof getAdapter>)
      .mockReturnValueOnce({
        connect: vi.fn().mockResolvedValue('已连接')
      } as unknown as ReturnType<typeof getAdapter>)

    const manager = new SessionManager()
    expect((await manager.connect(makeRequest())).ok).toBe(false)
    expect((await manager.connect(makeRequest())).ok).toBe(true)
    expect(h.sessions).toHaveLength(2)
  })
})
