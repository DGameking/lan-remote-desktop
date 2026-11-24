import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  obfuscateVncPassword,
  reverseBits,
  writeVncPasswordFile
} from '../src/main/store/vnc-password'

describe('reverseBits - 单字节位反转', () => {
  it('反转已知字节（含任务给定的 0x01 -> 0x80、0x0A -> 0x50）', () => {
    expect(reverseBits(0x01)).toBe(0x80)
    expect(reverseBits(0x0a)).toBe(0x50)
    expect(reverseBits(0x80)).toBe(0x01)
    expect(reverseBits(0x00)).toBe(0x00)
    expect(reverseBits(0xff)).toBe(0xff)
  })

  it('ASCII 数字位反转结果应为 VNC 公开资料的 8c4ccc2cac6cec1c', () => {
    const key = Array.from(Buffer.from('12345678', 'ascii')).map(reverseBits)
    expect(Buffer.from(key).toString('hex')).toBe('8c4ccc2cac6cec1c')
  })

  it('幂等：连续反转两次回到原值', () => {
    for (let b = 0; b < 256; b++) expect(reverseBits(reverseBits(b))).toBe(b)
  })
})

describe('obfuscateVncPassword - VNC 密码混淆', () => {
  it('输出为 16 位小写 hex（对应 8 字节密文）', () => {
    const out = obfuscateVncPassword('12345678')
    expect(out).toHaveLength(16)
    expect(out).toMatch(/^[0-9a-f]{16}$/)
  })

  it('确定性：同一密码多次调用结果一致', () => {
    expect(obfuscateVncPassword('password')).toBe(obfuscateVncPassword('password'))
  })

  it('只取前 8 字节：123456789 与 12345678 结果相同', () => {
    expect(obfuscateVncPassword('123456789')).toBe(obfuscateVncPassword('12345678'))
    expect(obfuscateVncPassword('1234567890abcdef')).toBe(obfuscateVncPassword('12345678'))
  })

  it('不足 8 位补 0x00', () => {
    // 参考值由 openssl legacy provider 生成：
    //   key = bitrev("abc") + 5*0x00 = 8646c60000000000
    //   DES-ECB(key, 0000000000000000) = 0f3ddf69f786bf5e
    expect(obfuscateVncPassword('abc')).toBe('0f3ddf69f786bf5e')
  })

  it('公开可验证的 VncAuth 参考向量锁定算法正确性', () => {
    // 参考值由 openssl enc -des-ecb -nopad -provider legacy 生成，
    // 且该 openssl 的 DES 实现已用 NIST 标准向量验证：
    //   key=133457799BBCDFF1, pt=0123456789ABCDEF -> ct=85E813540F0AB405
    // 本算法的 key = bitrev(password)，明文为全 0x00 块。
    const vectors: Array<[string, string]> = [
      ['12345678', 'd29f6e7f0456f8de'],
      ['password', 'ff97502e9422f089'],
      ['mac', '3c7fc9dc9ee7627f'],
      ['', '8ca64de9c1b123a7']
    ]
    for (const [password, expected] of vectors) {
      expect(obfuscateVncPassword(password)).toBe(expected)
    }
  })
})

describe('writeVncPasswordFile - 临时密码文件', () => {
  const tempFiles: string[] = []
  const makePath = (): string => {
    const file = path.join(os.tmpdir(), `landesk-vnc-test-${Date.now()}-${Math.random()}.passwd`)
    tempFiles.push(file)
    return file
  }

  // 用 afterEach 兜底清理，避免测试失败时残留
  const cleanupAll = (): void => {
    for (const file of tempFiles) {
      try {
        fs.unlinkSync(file)
      } catch {
        // ignore
      }
    }
    tempFiles.length = 0
  }

  it('写入的是 8 字节二进制（混淆密文），不是 hex 文本', () => {
    const file = makePath()
    const result = writeVncPasswordFile('12345678', file)
    try {
      const buf = fs.readFileSync(file)
      expect(buf).toBeInstanceOf(Buffer)
      expect(buf.length).toBe(8)
      expect(buf.toString('hex')).toBe('d29f6e7f0456f8de')
      // 绝不能是 hex 文本（16 字节 ASCII）
      expect(buf.toString('utf8')).not.toBe('d29f6e7f0456f8de')
      expect(result.file).toBe(file)
    } finally {
      result.cleanup()
      cleanupAll()
    }
  })

  it('文件权限：owner 可读写；POSIX 上严格为 0o600', () => {
    const file = makePath()
    const result = writeVncPasswordFile('password', file)
    try {
      const mode = fs.statSync(file).mode & 0o777
      expect(mode & 0o600).toBe(0o600)
      if (process.platform !== 'win32') expect(mode).toBe(0o600)
    } finally {
      result.cleanup()
      cleanupAll()
    }
  })

  it('cleanup 幂等删除文件', () => {
    const file = makePath()
    const result = writeVncPasswordFile('abc', file)
    expect(fs.existsSync(file)).toBe(true)
    result.cleanup()
    expect(fs.existsSync(file)).toBe(false)
    expect(() => result.cleanup()).not.toThrow()
    cleanupAll()
  })

  it('不传 filePath 时在 os.tmpdir() 下生成唯一文件名', () => {
    const a = writeVncPasswordFile('12345678')
    const b = writeVncPasswordFile('12345678')
    try {
      expect(path.dirname(a.file)).toBe(os.tmpdir())
      expect(path.dirname(b.file)).toBe(os.tmpdir())
      expect(a.file).not.toBe(b.file)
      expect(fs.readFileSync(a.file).toString('hex')).toBe('d29f6e7f0456f8de')
    } finally {
      a.cleanup()
      b.cleanup()
    }
  })
})
