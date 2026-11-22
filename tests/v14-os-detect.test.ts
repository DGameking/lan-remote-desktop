import { describe, it, expect } from 'vitest'
import { detectOs, inferOsHint, macOui } from '../src/main/discovery/os-detect'

describe('v1.4-B macOui - MAC 前缀提取', () => {
  it('冒号/横杠分隔与大小写归一化', () => {
    expect(macOui('00:1B:63:AA:BB:CC')).toBe('001b63')
    expect(macOui('00-1b-63-aa-bb-cc')).toBe('001b63')
    expect(macOui('001B63AABBCC')).toBe('001b63')
  })
  it('空值与过短 MAC 返回 null', () => {
    expect(macOui('')).toBeNull()
    expect(macOui(undefined)).toBeNull()
    expect(macOui('A:B')).toBeNull()
  })
})

describe('v1.4-B detectOs - 分层置信度识别', () => {
  it('RFB 003.889 → macOS，high 置信', () => {
    const r = detectOs({ ports: [5900], fingerprint: [{ port: 5900, service: 'vnc', version: '003.889' }] })
    expect(r.osHint).toBe('macos')
    expect(r.confidence).toBe('high')
    expect(r.evidence.some((e) => e.source === 'rfb')).toBe(true)
  })

  it('标准 RFB 003.008 不臆测系统，仅给 low/none 且无 rfb 强信号', () => {
    const r = detectOs({ ports: [5900], fingerprint: [{ port: 5900, service: 'vnc', version: '003.008' }] })
    expect(r.osHint).toBe('unknown')
    expect(r.evidence.some((e) => e.source === 'rfb')).toBe(false)
  })

  it('RDP X.224 握手 → Windows，high 置信', () => {
    const r = detectOs({ ports: [3389], fingerprint: [{ port: 3389, service: 'rdp', osHint: 'windows' }] })
    expect(r.osHint).toBe('windows')
    expect(r.confidence).toBe('high')
  })

  it('SSH 发行版 banner → Linux，high 置信', () => {
    const r = detectOs({ fingerprint: [{ port: 22, service: 'ssh', osHint: 'linux' }] })
    expect(r.osHint).toBe('linux')
    expect(r.confidence).toBe('high')
  })

  it('HTTP Server=fnOS → 飞牛OS，high 置信', () => {
    const r = detectOs({ fingerprint: [{ port: 8000, service: 'http', osHint: 'fnos' }] })
    expect(r.osHint).toBe('fnos')
    expect(r.confidence).toBe('high')
  })

  it('Apple MAC OUI → macOS，medium 置信', () => {
    const r = detectOs({ ports: [5900], mac: '00:1B:63:11:22:33' })
    expect(r.osHint).toBe('macos')
    expect(r.confidence).toBe('medium')
    expect(r.evidence.some((e) => e.source === 'mac-oui')).toBe(true)
  })

  it('mDNS TXT 机型字段 → macOS，medium 置信', () => {
    const r = detectOs({ ports: [5900], mdnsTxt: { model: 'MacBookPro18,3' } })
    expect(r.osHint).toBe('macos')
    expect(r.confidence).toBe('medium')
    expect(r.evidence.some((e) => e.source === 'mdns-txt')).toBe(true)
  })

  it('非 Apple OUI 不硬判系统（避免把手机/路由器误报）', () => {
    const r = detectOs({ ports: [445], mac: 'DC:0D:30:11:22:33' }) // 华为常见 OUI
    expect(r.evidence.some((e) => e.source === 'mac-oui')).toBe(false)
  })

  it('仅默认端口 → low 置信，仍给出证据', () => {
    const r = detectOs({ ports: [22] })
    expect(r.osHint).toBe('linux')
    expect(r.confidence).toBe('low')
    expect(r.evidence.some((e) => e.source === 'port')).toBe(true)
  })

  it('名称关键字 DESKTOP- → Windows low', () => {
    const r = detectOs({ name: 'DESKTOP-ABC123' })
    expect(r.osHint).toBe('windows')
    expect(r.confidence).toBe('low')
  })

  it('手动指定优先于所有自动信号', () => {
    const r = detectOs({
      ports: [3389],
      fingerprint: [{ port: 3389, service: 'rdp', osHint: 'windows' }],
      manualHint: 'linux'
    })
    expect(r.osHint).toBe('linux')
    expect(r.evidence[0].source).toBe('manual')
  })

  it('强信号优先于弱信号（003.889 胜过 3389 端口）', () => {
    const r = detectOs({
      ports: [3389, 5900],
      fingerprint: [{ port: 5900, service: 'vnc', version: '003.889' }]
    })
    expect(r.osHint).toBe('macos')
    expect(r.confidence).toBe('high')
  })

  it('无任何信号 → unknown / none，证据为空', () => {
    const r = detectOs({})
    expect(r.osHint).toBe('unknown')
    expect(r.confidence).toBe('none')
    expect(r.evidence).toHaveLength(0)
  })

  it('证据去重：同源同系统只保留一条', () => {
    const r = detectOs({
      ports: [22, 3389],
      name: 'DESKTOP-X'
    })
    const keys = r.evidence.map((e) => `${e.source}:${e.osHint}`)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('v1.4-B inferOsHint - v1.3 兼容别名', () => {
  it('保持旧签名行为', () => {
    expect(inferOsHint([3389], '')).toBe('windows')
    expect(inferOsHint([5900], 'MacBook-Air')).toBe('macos')
    expect(inferOsHint([5900], 'unknown-device')).toBe('unknown')
    expect(inferOsHint([22], 'x', [{ port: 22, service: 'ssh', osHint: 'linux' }])).toBe('linux')
  })
})
