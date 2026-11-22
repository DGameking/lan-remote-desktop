import { describe, it, expect, vi } from 'vitest'
import * as precheck from '../src/main/discovery/precheck'
import { parsePingOutput } from '../src/main/discovery/precheck'
import {
  cleanupDecision,
  tempFileHash,
  removeTempFile
} from '../src/main/protocols/tempfile'

describe('P0 修复 - parsePingOutput 离线判定（icmpProbe 误判根因）', () => {
  it('导出契约存在', () => {
    expect(typeof precheck.parsePingOutput).toBe('function')
  })

  it('Windows 英文回包 → true', () => {
    expect(parsePingOutput('Reply from 192.168.1.1: bytes=32 time=12ms TTL=64')).toBe(true)
  })

  it('Linux/macOS 回包 → true', () => {
    expect(parsePingOutput('64 bytes from 192.168.1.1: icmp_seq=1 ttl=64 time=0.03 ms')).toBe(true)
  })

  it('Windows 请求超时（非零退出码）→ false，不再误判 unknown', () => {
    expect(parsePingOutput('Pinging 192.168.1.99 with 32 bytes of data:\nRequest timed out.')).toBe(false)
  })

  it('目标主机无法访问 → false', () => {
    expect(parsePingOutput('Reply from 192.168.1.1: Destination host unreachable.')).toBe(false)
  })

  it('100% 丢包 → false', () => {
    expect(parsePingOutput('Packets: Sent = 1, Received = 0, Lost = 1 (100% loss)')).toBe(false)
  })

  it('Received = 0 统计行 → false', () => {
    expect(parsePingOutput('Ping statistics for 192.168.1.99:\n    Packets: Sent = 1, Received = 0')).toBe(false)
  })

  it('中文 Windows 请求超时 → false', () => {
    expect(parsePingOutput('正在 Ping 192.168.1.99 具有 32 字节的数据:\n请求超时。')).toBe(false)
  })

  it('中文无法访问目标主机 → false', () => {
    expect(parsePingOutput('来自 192.168.1.1 的回复: 无法访问目标主机。')).toBe(false)
  })

  it('输出为空 → null（无法判断，绝不误报）', () => {
    expect(parsePingOutput('')).toBeNull()
    expect(parsePingOutput('   \n  ')).toBeNull()
  })

  it('有输出但无判定特征（如帮助文本）→ null', () => {
    expect(parsePingOutput('Usage: ping [-c count] host')).toBeNull()
  })
})

describe('P1 修复 - cleanupDecision 临时文件清理决策（纯函数）', () => {
  const base = { elapsedMs: 6000, graceMs: 5000, confirmStreak: 2 }

  it('宽限期内不清理（即使已连续 miss）', () => {
    expect(cleanupDecision({ ...base, alive: false, elapsedMs: 1000, consecutiveMisses: 5 })).toBe('wait')
  })

  it('进程存活 → wait', () => {
    expect(cleanupDecision({ ...base, alive: true, consecutiveMisses: 5 })).toBe('wait')
  })

  it('连续 miss 不足 → wait', () => {
    expect(cleanupDecision({ ...base, alive: false, consecutiveMisses: 1 })).toBe('wait')
  })

  it('连续 miss 达标 → cleanup', () => {
    expect(cleanupDecision({ ...base, alive: false, consecutiveMisses: 2 })).toBe('cleanup')
    expect(cleanupDecision({ ...base, alive: false, consecutiveMisses: 3 })).toBe('cleanup')
  })
})

describe('P1 修复 - tempFileHash 日志脱敏', () => {
  it('哈希稳定且不泄露路径片段', () => {
    const filePath = 'C:\\Users\\zhangsan\\AppData\\Local\\Temp\\landesk-192-168-1-20.rdp'
    const hash = tempFileHash(filePath)
    expect(hash).toMatch(/^[0-9a-f]{12}$/)
    expect(hash).not.toContain('Users')
    expect(hash).not.toContain('192')
    expect(hash).not.toContain('rdp')
    expect(tempFileHash(filePath)).toBe(hash)
  })

  it('不同路径生成不同指纹', () => {
    expect(tempFileHash('a.rdp')).not.toBe(tempFileHash('b.rdp'))
  })
})

describe('P1 修复 - removeTempFile 幂等清理', () => {
  it('删除不存在文件（ENOENT）视为成功，不抛异常', () => {
    const result = removeTempFile('C:\\__landesk_never_exists__\\x.rdp')
    expect(result.failed).toBe(false)
  })
})
