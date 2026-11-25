import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ConnectRequest, SessionRecord } from '../src/shared/types'
import { SessionManager, describeClientExit } from '../src/main/session/manager'
import { getAdapter } from '../src/main/protocols/registry'
import { setLastLaunchedPid, setLastLaunchedImageName } from '../src/main/protocols/base'

/**
 * v1.10: 会话状态诚实性回归。
 * 核心：外部客户端退出必须记为 failed + 可读说明，不得再用 ended/空错误信息让用户误以为连上过。
 */
const h = vi.hoisted(() => {
  const sessions: SessionRecord[] = []
  const plain = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), event: vi.fn() }
  const scoped = vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), event: vi.fn() }))
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
  now: () => '2026-11-25T12:00:10.000Z',
  rowToDevice: (row: { name?: string }) => ({ name: row.name ?? '' })
}))

const mockedGetAdapter = vi.mocked(getAdapter)

function request(overrides: Partial<ConnectRequest> = {}): ConnectRequest {
  return { deviceId: 'dev-mac', ip: '192.168.10.15', protocol: 'vnc', ...overrides }
}

async function launchedSession(protocol: 'vnc' | 'rdp' | 'rustdesk' = 'vnc'): Promise<SessionManager> {
  setLastLaunchedPid(4242)
  setLastLaunchedImageName('vncviewer.exe')
  mockedGetAdapter.mockReturnValue({
    connect: vi.fn().mockResolvedValue('已调起')
  } as unknown as ReturnType<typeof getAdapter>)
  const manager = new SessionManager()
  const result = await manager.connect(request({ protocol }))
  expect(result.ok).toBe(true)
  return manager
}

beforeEach(() => {
  h.sessions.length = 0
  h.store.addSession.mockClear()
  h.store.updateSession.mockClear()
})

describe('v1.10 describeClientExit 可读说明', () => {
  it('VNC 提示独立 VNC 密码 / Mac 账号认证差异', () => {
    const text = describeClientExit('vnc', 16)
    expect(text).toContain('未能确认进入远程桌面')
    expect(text).toContain('16 秒')
    expect(text).toContain('独立 VNC 密码')
  })

  it('RDP / RustDesk 各有针对性提示，且不含敏感字段', () => {
    expect(describeClientExit('rdp', 8)).toContain('远程桌面')
    expect(describeClientExit('rustdesk', 5)).toContain('会话码')
    for (const p of ['vnc', 'rdp', 'rustdesk']) {
      const text = describeClientExit(p, 10)
      expect(text).not.toMatch(/password\s*[:=]|DPAPI|51:b:|192\.168/i)
    }
  })

  it('时长不可测时不写假数字', () => {
    expect(describeClientExit('vnc', undefined)).not.toContain('秒')
  })
})

describe('v1.10 endSession 终态诚实性', () => {
  it('客户端退出写 failed + 可读说明，不再是 ended/空', async () => {
    const manager = await launchedSession()
    expect(manager.endSession('process-exit')).toBe(true)
    const row = h.sessions[0]
    expect(row.status).toBe('failed')
    expect(row.errorMessage).toContain('未能确认进入远程桌面')
    expect(row.errorMessage).toContain('独立 VNC 密码')
    expect(manager.getStatus().state).toBe('idle')
  })

  it('用户主动结束才是 ended，且不写退出说明', async () => {
    const manager = await launchedSession('rdp')
    manager.endSession('manual')
    expect(h.sessions[0].status).toBe('ended')
    expect(h.sessions[0].errorMessage).not.toContain('未能确认')
  })

  it('failed 终态不被后续 endSession 改写（保留 v1.5 修复）', async () => {
    const manager = await launchedSession()
    manager.endSession('process-exit')
    expect(h.sessions[0].status).toBe('failed')
    expect(manager.endSession('manual')).toBe(false)
    expect(h.sessions[0].status).toBe('failed')
  })

  it('防竞态：传入错误 sessionId 的旧轮询不得误杀当前会话', async () => {
    const manager = await launchedSession()
    const currentId = h.sessions[0].id
    expect(manager.endSession('process-exit', 'stale-session-id')).toBe(false)
    expect(h.sessions[0].status).toBe('connected')
    expect(manager.getStatus().state).toBe('connected')
    expect(manager.endSession('manual', currentId)).toBe(true)
    expect(h.sessions[0].status).toBe('ended')
  })
})
