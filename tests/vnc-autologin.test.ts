import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectRequest } from '../src/shared/types'
import { VncAdapter } from '../src/main/protocols/vnc'
import { findOnPath, spawnDetached } from '../src/main/protocols/base'
import { logger } from '../src/main/logger'
import type { VncPasswordFile } from '../src/main/store/vnc-password'

/**
 * 独立验证「适配器接线」而非只验证密码算法：
 * 真实调用 VncAdapter.connect()，只替换它的外部边界（viewer 解析、进程调起、设置、日志），
 * 密码文件写入保持真实实现（仅用 spy 观察调用），从而断言 argv / 文件字节 / 失败清理。
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
    // displayMode 默认 native：本文件专注密码接线，显示参数由 display-mode.test.ts 单独覆盖
    state: { viewerPath: '', displayMode: 'native' as string },
    spawnDetached: vi.fn(),
    findOnPath: vi.fn(),
    writeVncPasswordFile: vi.fn()
  }
})

vi.mock('../src/main/logger', () => ({
  logger: h.logger,
  scopedLogger: () => h.logger
}))

vi.mock('../src/main/store', () => ({
  getSettings: () => ({ vncViewerPath: h.state.viewerPath, displayMode: h.state.displayMode })
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

vi.mock('../src/main/store/vnc-password', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/store/vnc-password')>()
  // 保留真实写文件实现，只观察是否被调用及返回的实际路径
  h.writeVncPasswordFile.mockImplementation(actual.writeVncPasswordFile)
  return { ...actual, writeVncPasswordFile: h.writeVncPasswordFile }
})

const PASSWORD = 'VncPlaintext_9f3a!CLEAR'
const IP = '192.168.1.77'

function makeRequest(overrides: Partial<ConnectRequest> = {}): ConnectRequest {
  return {
    deviceId: 'dev-vnc-1',
    ip: IP,
    protocol: 'vnc',
    ...overrides
  }
}

const mockedSpawnDetached = vi.mocked(spawnDetached)
const mockedFindOnPath = vi.mocked(findOnPath)

let tempRoot = ''
const viewers: Record<string, string> = {}

/** 创建真实存在的假 vncviewer.exe，令 resolveViewer 能通过 fs.existsSync 选中它 */
function installViewer(relative: string): string {
  const file = path.join(tempRoot, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, 'test stub - not a real executable')
  return file
}

/** 从 spawnDetached 的 argv 中取回本次调用的 command 与 args */
function lastLaunch(): { command: string; args: string[] } {
  expect(mockedSpawnDetached).toHaveBeenCalledTimes(1)
  const [command, args] = mockedSpawnDetached.mock.calls[0] as [string, string[]]
  return { command, args }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.logCalls.length = 0
  h.state.displayMode = 'native'
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'landesk-vnc-wiring-'))
  viewers.tiger = installViewer(path.join('TigerVNC', 'vncviewer.exe'))
  viewers.real = installViewer(path.join('RealVNC', 'VNC Viewer', 'vncviewer.exe'))
  viewers.tight = installViewer(path.join('TightVNC', 'tvnviewer.exe'))
  mockedFindOnPath.mockResolvedValue('')
  mockedSpawnDetached.mockResolvedValue({ pid: 4242 })
})

afterEach(() => {
  // 清掉真实写出的密码文件（含 spawn 失败分支残留）
  for (const call of mockedSpawnDetached.mock.calls) {
    const args = (call[1] ?? []) as string[]
    for (const arg of args) {
      if (arg.startsWith('-PasswordFile=')) {
        try {
          fs.unlinkSync(arg.slice('-PasswordFile='.length))
        } catch {
          // ignore
        }
      }
    }
  }
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

describe('VncAdapter.connect - VNC 免密适配器接线验证', () => {
  it('TigerVNC + 密码：argv[1] 严格等于 -PasswordFile=<实际生成路径>，文件为 8 字节二进制且不等于明文', async () => {
    h.state.viewerPath = viewers.tiger

    const message = await new VncAdapter().connect(makeRequest({ password: PASSWORD }))

    expect(h.writeVncPasswordFile).toHaveBeenCalledTimes(1)
    expect(h.writeVncPasswordFile).toHaveBeenCalledWith(PASSWORD)
    const generated = h.writeVncPasswordFile.mock.results[0].value as VncPasswordFile

    const { command, args } = lastLaunch()
    expect(command).toBe(viewers.tiger)
    expect(args).toHaveLength(2)
    expect(args[0]).toBe(`${IP}::5900`)
    expect(args[1]).toBe(`-PasswordFile=${generated.file}`)
    expect(path.isAbsolute(generated.file)).toBe(true)

    // 真实读取文件：8 字节二进制混淆值，不是 16 位 hex 文本，更不是明文
    expect(fs.existsSync(generated.file)).toBe(true)
    const bytes = fs.readFileSync(generated.file)
    expect(Buffer.isBuffer(bytes)).toBe(true)
    expect(bytes.length).toBe(8)
    expect(bytes.toString('utf8')).not.toBe(PASSWORD)
    expect(bytes.toString('utf8')).not.toContain(PASSWORD)
    expect(message).toContain('自动登录')
  })

  it('明文密码不出现在任何 argv 元素，也不出现在任何 logger 调用参数中', async () => {
    h.state.viewerPath = viewers.tiger

    await new VncAdapter().connect(makeRequest({ password: PASSWORD }))

    const { command, args } = lastLaunch()
    for (const item of [command, ...args]) {
      expect(item).not.toContain(PASSWORD)
    }
    expect(h.logCalls.length).toBeGreaterThan(0)
    expect(JSON.stringify(h.logCalls)).not.toContain(PASSWORD)
    // logger 只允许记录哈希指纹，不得回显完整密码文件路径
    expect(JSON.stringify(h.logCalls)).not.toContain(
      (h.writeVncPasswordFile.mock.results[0].value as VncPasswordFile).file
    )
  })

  it.each([
    ['RealVNC', 'real'],
    ['TightVNC', 'tight']
  ])('%s + 密码：不生成/传递密码文件参数，返回消息提示手动输入', async (_name, key) => {
    h.state.viewerPath = viewers[key]

    const message = await new VncAdapter().connect(makeRequest({ password: PASSWORD }))

    expect(h.writeVncPasswordFile).not.toHaveBeenCalled()
    const { command, args } = lastLaunch()
    expect(command).toBe(viewers[key])
    expect(args).toEqual([`${IP}::5900`])
    expect(args.some((item) => item.startsWith('-PasswordFile'))).toBe(false)
    expect(message).toContain('手动输入')
    expect(message).toContain('非 TigerVNC')
  })

  it('密码为空：不生成密码文件，args 只有 ip::port', async () => {
    h.state.viewerPath = viewers.tiger

    const message = await new VncAdapter().connect(makeRequest())

    expect(h.writeVncPasswordFile).not.toHaveBeenCalled()
    const { args } = lastLaunch()
    expect(args).toEqual([`${IP}::5900`])
    expect(message).toContain('手动输入')
  })

  it('空密码时端口缺省回落到 5900，显式端口原样进入唯一参数', async () => {
    h.state.viewerPath = viewers.tiger

    await new VncAdapter().connect(makeRequest({ port: 5903 }))
    expect(lastLaunch().args).toEqual([`${IP}::5903`])
  })

  it('spawnDetached 抛错：临时文件被删除，错误提示为 VNC 相关而非 RDP 文案', async () => {
    h.state.viewerPath = viewers.tiger
    mockedSpawnDetached.mockRejectedValueOnce(new Error('ENOENT'))

    const error = await new VncAdapter().connect(makeRequest({ password: PASSWORD })).then(
      () => null,
      (e: unknown) => e as Error
    )

    expect(error).toBeInstanceOf(Error)
    const generated = h.writeVncPasswordFile.mock.results[0].value as VncPasswordFile
    expect(lastLaunch().args[1]).toBe(`-PasswordFile=${generated.file}`)
    expect(fs.existsSync(generated.file)).toBe(false)
    expect(error!.message).toContain('VNC Viewer')
    expect(error!.message).toMatch(/屏幕共享|端口/)
    expect(error!.message).not.toContain('Windows 专业版')
    expect(error!.message).not.toContain('mstsc')
  })
})
