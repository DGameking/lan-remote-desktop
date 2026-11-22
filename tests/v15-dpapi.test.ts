import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import {
  generateRdpPasswordHex,
  isRdpPasswordHex,
  normalizeRdpPasswordHex
} from '../src/main/store/dpapi'

// 用可控的假子进程替换 spawn：真实断言调用参数、stdin 写入、stdout 收集、退出码与超时分支。
vi.mock('node:child_process', () => ({
  spawn: vi.fn()
}))

const mockedSpawn = vi.mocked(spawn)

interface FakeChild {
  child: EventEmitter & { kill: ReturnType<typeof vi.fn> }
  stdout: EventEmitter
  stderr: EventEmitter
  stdin: EventEmitter & { end: ReturnType<typeof vi.fn> }
}

function createFakeChild(): FakeChild {
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  const stdin = Object.assign(new EventEmitter(), { end: vi.fn() })
  const child = Object.assign(new EventEmitter(), { stdout, stderr, stdin, kill: vi.fn() })
  return { child, stdout, stderr, stdin }
}

function installFake(fake: FakeChild): void {
  mockedSpawn.mockReturnValue(fake.child as unknown as ChildProcess)
}

/** 合法的 DPAPI blob hex（前缀 + 32 位密文，偶数长度） */
const VALID_HEX = '01000000d08c9ddf0115d1118c7a00c04fc297eb00112233445566778899aabbccddeeff'

let originalPlatform: PropertyDescriptor | undefined

beforeEach(() => {
  mockedSpawn.mockReset()
  originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
})

afterEach(() => {
  vi.useRealTimers()
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
  else delete (process as { platform?: string }).platform
})

describe('DPAPI 纯函数 - 真实校验与归一化（不再用伪造 hex 自证）', () => {
  it('大小写不敏感：大写合法 blob 通过校验并归一为小写', () => {
    const upper = VALID_HEX.toUpperCase()
    expect(isRdpPasswordHex(upper)).toBe(true)
    expect(normalizeRdpPasswordHex(upper)).toBe(VALID_HEX)
  })

  it('非法 blob 被拒绝：错前缀 / 奇数长度 / 非 hex 字符 / 空串', () => {
    expect(isRdpPasswordHex('')).toBe(false)
    expect(isRdpPasswordHex('aabbccdd')).toBe(false)
    expect(isRdpPasswordHex(VALID_HEX + 'a')).toBe(false)
    expect(isRdpPasswordHex('g' + VALID_HEX.slice(1))).toBe(false)
    expect(isRdpPasswordHex(VALID_HEX)).toBe(true)
  })
})

describe('generateRdpPasswordHex - PowerShell 真实调用链', () => {
  it('成功路径：spawn 固定脚本，密码只走 stdin，stdout 分块收集并归一化小写返回', async () => {
    const fake = createFakeChild()
    installFake(fake)
    const password = 'P@ssw0rd-明文绝不进 argv'

    const promise = generateRdpPasswordHex(password)

    // 真实断言 spawn 调用参数，而非伪造常量
    expect(mockedSpawn).toHaveBeenCalledTimes(1)
    const [cmd, args, opts] = mockedSpawn.mock.calls[0]
    expect(cmd).toBe('powershell.exe')
    expect(args).toContain('-NoProfile')
    expect(args).toContain('-NonInteractive')
    expect(args).toContain('-WindowStyle')
    expect(args).toContain('-Command')
    const script = String(args[args.indexOf('-Command') + 1])
    expect(script).toContain('ConvertTo-SecureString')
    expect(script).toContain('ConvertFrom-SecureString')
    expect(script).toContain('[Console]::In.ReadToEnd()')
    expect(JSON.stringify(args)).not.toContain(password)
    expect(opts).toMatchObject({ windowsHide: true, shell: false })
    expect(fake.stdin.end).toHaveBeenCalledWith(password, 'utf8')

    // 分两块输出 + CRLF：验证收集与 trim/replace
    const upper = VALID_HEX.toUpperCase()
    fake.stdout.emit('data', Buffer.from(upper.slice(0, 20)))
    fake.stdout.emit('data', Buffer.from(upper.slice(20) + '\r\n'))
    fake.child.emit('close', 0)

    await expect(promise).resolves.toBe(VALID_HEX.toLowerCase())
  })

  it('退出码非 0：reject 且错误信息包含退出码与 stderr 摘要，不回显明文', async () => {
    const fake = createFakeChild()
    installFake(fake)
    const promise = generateRdpPasswordHex('secret-should-not-leak')
    fake.stderr.emit('data', Buffer.from('Access is denied'))
    fake.child.emit('close', 1)

    const error = await promise.then(
      () => null,
      (e: unknown) => e as Error
    )
    expect(error).toBeInstanceOf(Error)
    expect(error!.message).toContain('退出码 1')
    expect(error!.message).toContain('Access is denied')
    expect(error!.message).not.toContain('secret-should-not-leak')
  })

  it('退出码 null：错误信息标记 unknown', async () => {
    const fake = createFakeChild()
    installFake(fake)
    const promise = generateRdpPasswordHex('pw')
    fake.child.emit('close', null)

    const error = await promise.then(
      () => null,
      (e: unknown) => e as Error
    )
    expect(error!.message).toContain('退出码 unknown')
  })

  it('输出格式非法（非 blob / 空输出 / 奇数长度）→ reject，不回退不降级', async () => {
    for (const bad of ['not-a-dpapi-blob', '', VALID_HEX + 'a']) {
      const fake = createFakeChild()
      installFake(fake)
      const promise = generateRdpPasswordHex('pw')
      fake.stdout.emit('data', Buffer.from(bad + '\r\n'))
      fake.child.emit('close', 0)

      const error = await promise.then(
        () => null,
        (e: unknown) => e as Error
      )
      expect(error).toBeInstanceOf(Error)
      expect(error!.message).toContain('格式不符合 DPAPI blob 规范')
    }
  })

  it('spawn 启动失败（error 事件）→ reject 包装为可诊断错误', async () => {
    const fake = createFakeChild()
    installFake(fake)
    const promise = generateRdpPasswordHex('pw')
    fake.child.emit('error', new Error('ENOENT'))

    await expect(promise).rejects.toThrow(/无法启动 PowerShell.*ENOENT/)
  })

  it('stdin 写入失败 → reject', async () => {
    const fake = createFakeChild()
    installFake(fake)
    const promise = generateRdpPasswordHex('pw')
    fake.stdin.emit('error', new Error('EPIPE'))

    await expect(promise).rejects.toThrow(/写入凭据失败：EPIPE/)
  })

  it('8 秒超时 → reject 并 kill 子进程（不会悬挂）', async () => {
    vi.useFakeTimers()
    try {
      const fake = createFakeChild()
      installFake(fake)
      const promise = generateRdpPasswordHex('pw')
      const rejection = expect(promise).rejects.toThrow(/8 秒内未返回/)

      vi.advanceTimersByTime(8000)
      await rejection
      expect(fake.child.kill).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('settled 后重复 close 不会二次 resolve/reject（幂等）', async () => {
    const fake = createFakeChild()
    installFake(fake)
    const promise = generateRdpPasswordHex('pw')
    fake.stdout.emit('data', Buffer.from(VALID_HEX))
    fake.child.emit('close', 0)
    fake.child.emit('close', 1)

    await expect(promise).resolves.toBe(VALID_HEX.toLowerCase())
  })
})

describe('generateRdpPasswordHex - 平台约束', () => {
  it('非 Windows 平台直接 reject 且不 spawn', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    const promise = generateRdpPasswordHex('pw')

    await expect(promise).rejects.toThrow(/仅支持 Windows/)
    expect(mockedSpawn).not.toHaveBeenCalled()
  })
})
