import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ConnectRequest } from '../src/shared/types'
import { SessionManager } from '../src/main/session/manager'
import { getAdapter } from '../src/main/protocols/registry'

/**
 * classifyConnectError 是 manager.ts 的私有函数，全仓无直接调用点。
 * 它的唯一可观测出口是 SessionManager.connect() 失败时写入的
 * connect.failed 结构化日志 context.errorMessageRedacted。
 * 因此这里通过公开路径触发不同 adapter 错误，断言分类 token，而不改源码导出私有函数。
 */
const h = vi.hoisted(() => {
  const events: Array<{
    level: string
    event: string
    context?: Record<string, unknown>
    traceId?: string
  }> = []
  const scoped = vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    event: vi.fn((entry: (typeof events)[number]) => {
      events.push(entry)
    })
  }))
  const plain = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), event: vi.fn() }
  const store = {
    listDevices: vi.fn(() => [] as unknown[]),
    listCredentials: vi.fn(() => [] as unknown[]),
    addSession: vi.fn(),
    updateSession: vi.fn()
  }
  return { events, scoped, plain, store }
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

function makeRequest(overrides: Partial<ConnectRequest> = {}): ConnectRequest {
  return {
    deviceId: 'dev-1',
    ip: '192.168.1.77',
    protocol: 'rdp',
    password: 'pw',
    ...overrides
  }
}

/** 通过公开 connect() 触发一次失败，返回 UI 结果与 connect.failed 日志事件 */
async function failConnect(message: string, request = makeRequest()) {
  h.events.length = 0
  mockedGetAdapter.mockReturnValue({
    connect: vi.fn().mockRejectedValue(new Error(message))
  } as unknown as ReturnType<typeof getAdapter>)

  const manager = new SessionManager()
  const result = await manager.connect(request)
  const failedEvent = h.events.find((entry) => entry.event === 'connect.failed')
  return { result, failedEvent }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.events.length = 0
  h.store.listDevices.mockReturnValue([])
  h.store.listCredentials.mockReturnValue([])
})

describe('连接失败分类 - 经 SessionManager.connect() 公开路径验证 token', () => {
  const cases: Array<[string, string]> = [
    ['mstsc 无法启动', 'rdp_launch_failed'],
    ['RDP handshake error', 'rdp_launch_failed'],
    ['vnc viewer 启动失败', 'vnc_launch_failed'],
    ['rustdesk 未安装', 'rustdesk_launch_failed'],
    ['PowerShell 凭据生成失败', 'credential_failed'],
    ['credential decrypt error', 'credential_failed'],
    ['客户端未找到', 'client_missing'],
    ['binary not found in PATH', 'client_missing'],
    ['some unexpected adapter error', 'adapter_error']
  ]

  it.each(cases)('错误 "%s" → 日志分类 "%s"', async (message, token) => {
    const { result, failedEvent } = await failConnect(message)

    expect(result.ok).toBe(false)
    expect(result.launched).toBe(false)
    expect(result.message).toBe(message)
    expect(failedEvent).toBeDefined()
    expect(failedEvent!.level).toBe('ERROR')
    expect(failedEvent!.context!.errorMessageRedacted).toBe(token)
  })

  it('大小写不敏感：MSTSC / VNC 大写仍能命中对应分类', async () => {
    expect((await failConnect('MSTSC.EXE FAILED')).failedEvent!.context!.errorMessageRedacted).toBe(
      'rdp_launch_failed'
    )
    expect((await failConnect('VNC VIEWER ERROR')).failedEvent!.context!.errorMessageRedacted).toBe(
      'vnc_launch_failed'
    )
  })

  it('分类优先级：vnc + not found 命中 vnc_launch_failed（协议先于 client_missing）', async () => {
    const { failedEvent } = await failConnect('vnc viewer not found')
    expect(failedEvent!.context!.errorMessageRedacted).toBe('vnc_launch_failed')
  })

  it('分类 token 恒为固定词表之一，绝不回显原始错误里的 IP / 明文密码', async () => {
    const raw = 'mstsc failed for 10.20.30.40 with secret P@ssw0rd'
    const { failedEvent } = await failConnect(raw)
    const token = failedEvent!.context!.errorMessageRedacted

    expect([
      'rdp_launch_failed',
      'vnc_launch_failed',
      'rustdesk_launch_failed',
      'credential_failed',
      'client_missing',
      'adapter_error'
    ]).toContain(token)
    expect(token).toBe('rdp_launch_failed')
    const serialized = JSON.stringify(failedEvent!.context)
    expect(serialized).not.toContain('10.20.30.40')
    expect(serialized).not.toContain('P@ssw0rd')
    expect(serialized).not.toContain(raw)
  })

  it('失败路径把 SessionRecord 标为 failed 并持久化原始错误（分类只进日志）', async () => {
    const { result } = await failConnect('rustdesk 启动失败')
    expect(h.store.updateSession).toHaveBeenCalledTimes(1)
    const written = h.store.updateSession.mock.calls[0][0] as {
      status: string
      errorMessage: string
      endedAt: string
    }
    expect(written.status).toBe('failed')
    expect(written.errorMessage).toBe('rustdesk 启动失败')
    expect(written.endedAt).toBeTruthy()
    expect(result.ok).toBe(false)
  })

  it('in-flight 去重：connecting 态再次 connect 直接抛错，不触发新 adapter 调用', async () => {
    h.events.length = 0
    let release!: (value: string) => void
    const connectMock = vi.fn(
      () => new Promise<string>((resolve) => { release = resolve })
    )
    mockedGetAdapter.mockReturnValue({
      connect: connectMock
    } as unknown as ReturnType<typeof getAdapter>)

    const manager = new SessionManager()
    const first = manager.connect(makeRequest())
    await expect(manager.connect(makeRequest())).rejects.toThrow(/已有连接正在进行中/)
    expect(connectMock).toHaveBeenCalledTimes(1)

    release('launched')
    await expect(first).resolves.toMatchObject({ ok: true, launched: true })
  })
})
