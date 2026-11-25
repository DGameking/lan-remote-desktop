import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { shell } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectRequest } from '../src/shared/types'
import { RustDeskAdapter } from '../src/main/protocols/rustdesk'
import { findOnPath, spawnDetached } from '../src/main/protocols/base'
import { logger } from '../src/main/logger'

/**
 * v1.9 独立验证：RustDeskAdapter.connect() 的「接线」而非纯函数。
 * 真实调用 connect()，只替换外部边界（设置、PATH 探测、进程调起、日志、shell.openExternal）；
 * 用真实临时目录里的假 rustdesk.exe 让 fs.existsSync 自然选中指定客户端路径。
 */
const h = vi.hoisted(() => {
  const logCalls: Array<{ level: string; args: unknown[] }> = []
  const makeLog = (level: string) =>
    vi.fn((...args: unknown[]) => {
      logCalls.push({ level, args })
    })
  return {
    logCalls,
    logger: {
      info: makeLog('info'),
      warn: makeLog('warn'),
      error: makeLog('error'),
      event: makeLog('event')
    },
    state: { rustdeskPath: '' },
    spawnDetached: vi.fn(),
    findOnPath: vi.fn()
  }
})

vi.mock('../src/main/logger', () => ({
  logger: h.logger,
  scopedLogger: () => h.logger
}))

vi.mock('../src/main/store', () => ({
  getSettings: () => ({ rustdeskPath: h.state.rustdeskPath })
}))

vi.mock('../src/main/protocols/base', () => ({
  spawnDetached: h.spawnDetached,
  findOnPath: h.findOnPath,
  availability: (id: unknown, label: unknown, available: boolean, detail: string) => ({
    id,
    label,
    available,
    detail
  })
}))

const mockedSpawnDetached = vi.mocked(spawnDetached)
const mockedFindOnPath = vi.mocked(findOnPath)
const mockedOpenExternal = () => vi.mocked(shell.openExternal)

function makeRequest(overrides: Partial<ConnectRequest> = {}): ConnectRequest {
  return {
    deviceId: 'dev-rustdesk-1',
    ip: '123456789',
    protocol: 'rustdesk',
    rustdeskId: '123456789',
    ...overrides
  }
}

let tempRoot = ''
let client = ''

/** 创建真实存在的假 rustdesk.exe，令 resolveExecutable 能通过 fs.existsSync 选中它 */
function installClient(relative: string): string {
  const file = path.join(tempRoot, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, 'test stub - not a real executable')
  return file
}

beforeEach(() => {
  vi.clearAllMocks()
  h.logCalls.length = 0
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'landesk-rustdesk-wiring-'))
  client = installClient(path.join('RustDesk', 'rustdesk.exe'))
  h.state.rustdeskPath = client
  mockedFindOnPath.mockResolvedValue('')
  mockedSpawnDetached.mockResolvedValue({ pid: 4242 })
  vi.spyOn(shell, 'openExternal').mockResolvedValue(undefined)
})

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('RustDeskAdapter.connect - v1.9 会话码接线验证', () => {
  it('找到本机客户端：spawnDetached 收到可执行文件路径，args 严格为 ["--connect", "123456789"]（会话码为独立参数，未拼入命令行、无额外 shell）', async () => {
    const message = await new RustDeskAdapter().connect(makeRequest())

    expect(mockedSpawnDetached).toHaveBeenCalledTimes(1)
    const [command, args] = mockedSpawnDetached.mock.calls[0] as [string, string[]]
    expect(command).toBe(client)
    // 会话码不得被拼进 command 字符串（证明未走 shell 命令行拼接）
    expect(command).not.toContain('123456789')
    expect(command).not.toContain('--connect')
    // 会话码必须是独立 argv 元素，顺序/内容严格一致
    expect(args).toEqual(['--connect', '123456789'])
    expect(args).toHaveLength(2)
    // 找到客户端时不应再走协议链接回退
    expect(mockedOpenExternal()).not.toHaveBeenCalled()
    expect(message).toContain('123456789')
  })

  it('返回消息披露能力归属：含 "非 LanDesk 自研" 与 "RustDesk 客户端及其服务端提供"', async () => {
    const message = await new RustDeskAdapter().connect(makeRequest())

    expect(message).toContain('非 LanDesk 自研')
    expect(message).toContain('RustDesk 客户端及其服务端提供')
    expect(message).toContain('会话码')
  })

  it('非法会话码在 adapter 层被拦：rustdeskId 与 ip 均非法时抛含"会话码"的错误，且 spawnDetached / openExternal 均未被调用', async () => {
    // 故意让本机存在合法客户端：若校验失效，注入串就会到达外部进程/URL
    h.state.rustdeskPath = client
    const badVectors = ['a:b', 'javascript:alert(1)', 'a/b', 'rustdesk://1.2.3.4', 'a b']

    for (const bad of badVectors) {
      mockedSpawnDetached.mockClear()
      mockedOpenExternal().mockClear()

      const error = await new RustDeskAdapter()
        .connect(makeRequest({ rustdeskId: bad, ip: bad }))
        .then(
          () => null,
          (e: unknown) => e as Error
        )

      expect(error, bad).toBeInstanceOf(Error)
      expect(error!.message, bad).toContain('会话码')
      expect(mockedSpawnDetached, bad).not.toHaveBeenCalled()
      expect(mockedOpenExternal(), bad).not.toHaveBeenCalled()
    }
  })

  it('找不到本机客户端：回退调用 shell.openExternal("rustdesk://123456789")', async () => {
    // 所有候选路径都不存在：配置路径为空、PATH 探测为空、内置路径用 spy 强制不存在
    h.state.rustdeskPath = ''
    mockedFindOnPath.mockResolvedValue('')
    vi.spyOn(fs, 'existsSync').mockReturnValue(false)

    const message = await new RustDeskAdapter().connect(makeRequest())

    expect(mockedSpawnDetached).not.toHaveBeenCalled()
    expect(mockedOpenExternal()).toHaveBeenCalledTimes(1)
    expect(mockedOpenExternal()).toHaveBeenCalledWith('rustdesk://123456789')
    expect(message).toContain('非 LanDesk 自研')
  })

  it('spawnDetached 抛错后降级到 shell.openExternal，接线链不中断', async () => {
    mockedSpawnDetached.mockRejectedValueOnce(new Error('ENOENT'))

    const message = await new RustDeskAdapter().connect(makeRequest())

    expect(mockedSpawnDetached).toHaveBeenCalledTimes(1)
    expect(mockedOpenExternal()).toHaveBeenCalledTimes(1)
    expect(mockedOpenExternal()).toHaveBeenCalledWith('rustdesk://123456789')
    expect(h.logCalls.some((c) => c.level === 'warn')).toBe(true)
    expect(message).toContain('RustDesk 客户端及其服务端提供')
  })

  it('兼容历史调用方：rustdeskId 缺失但 ip 承载会话码时，仍作为独立参数调起', async () => {
    const message = await new RustDeskAdapter().connect(
      makeRequest({ rustdeskId: undefined, ip: 'abc-123_XYZ' })
    )

    expect(mockedSpawnDetached).toHaveBeenCalledTimes(1)
    const [command, args] = mockedSpawnDetached.mock.calls[0] as [string, string[]]
    expect(command).toBe(client)
    expect(args).toEqual(['--connect', 'abc-123_XYZ'])
    expect(message).toContain('abc-123_XYZ')
  })
})
