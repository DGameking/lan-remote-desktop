import { describe, it, expect } from 'vitest'
import * as precheck from '../src/main/discovery/precheck'
import {
  classifyPrecheck,
  icmpProbe,
  isValidIpv4Strict,
  runFullPrecheck,
  probePortWithRetry,
  pickBestProbe
} from '../src/main/discovery/precheck'

describe('v15-P0-4 导出契约', () => {
  it('三个新函数在 precheck.ts 真实导出，且旧函数签名未破坏', () => {
    expect(typeof precheck.classifyPrecheck).toBe('function')
    expect(typeof precheck.icmpProbe).toBe('function')
    expect(typeof precheck.runFullPrecheck).toBe('function')
    expect(typeof probePortWithRetry).toBe('function')
    expect(typeof pickBestProbe).toBe('function')
  })
})

describe('classifyPrecheck - 三类结论 + 可达', () => {
  it('reachable=true → reachable，actions 为空', () => {
    const result = classifyPrecheck({ reachable: true, icmpReachable: null, port: 3389 })
    expect(result.conclusion).toBe('reachable')
    expect(result.actions).toEqual([])
  })

  it('ICMP=false → offline，提示开机与同网段', () => {
    const result = classifyPrecheck({ reachable: false, icmpReachable: false, port: 3389 })
    expect(result.conclusion).toBe('offline')
    expect(result.actions.length).toBeGreaterThan(0)
    expect(result.actions.join('')).toContain('开机')
    expect(result.actions.join('')).toMatch(/局域网|网段/)
  })

  it('ICMP=true + 3389 → firewall_or_auth，提示远程桌面/专业版/防火墙', () => {
    const result = classifyPrecheck({ reachable: false, icmpReachable: true, port: 3389 })
    expect(result.conclusion).toBe('firewall_or_auth')
    expect(result.actions.length).toBeGreaterThan(0)
    const text = result.actions.join('')
    expect(text).toContain('远程桌面')
    expect(text).toContain('专业版')
    expect(text).toContain('防火墙')
  })

  it('ICMP=true + 5900 → firewall_or_auth，提示屏幕共享/VNC', () => {
    const result = classifyPrecheck({ reachable: false, icmpReachable: true, port: 5900 })
    expect(result.conclusion).toBe('firewall_or_auth')
    expect(result.actions.length).toBeGreaterThan(0)
    const text = result.actions.join('')
    expect(text).toMatch(/屏幕共享|VNC/)
    expect(text).toContain('防火墙')
  })

  it('ICMP=true + 5910（VNC 端口段上界）仍为 firewall_or_auth', () => {
    const result = classifyPrecheck({ reachable: false, icmpReachable: true, port: 5910 })
    expect(result.conclusion).toBe('firewall_or_auth')
  })

  it('ICMP=true + 其它端口 → port_closed，提示服务已启动并监听', () => {
    const result = classifyPrecheck({ reachable: false, icmpReachable: true, port: 8080 })
    expect(result.conclusion).toBe('port_closed')
    expect(result.actions.length).toBeGreaterThan(0)
    const text = result.actions.join('')
    expect(text).toContain('服务')
    expect(text).toContain('监听')
  })

  it('ICMP=null → unknown，给出通用排查清单（优先于按端口归类）', () => {
    for (const port of [3389, 5900, 8080]) {
      const result = classifyPrecheck({ reachable: false, icmpReachable: null, port })
      expect(result.conclusion).toBe('unknown')
      expect(result.actions.length).toBeGreaterThan(0)
      const text = result.actions.join('')
      expect(text).toContain('服务')
      expect(text).toContain('防火墙')
    }
  })
})

describe('icmpProbe - 非法 IP 短路（不执行命令）', () => {
  const invalidIps = [
    '1.2.3.4; calc',
    '1.2.3.4 && calc',
    'example.com',
    '01.2.3.4',
    '1.02.3.4',
    '1.2.3',
    '256.1.1.1',
    '::1',
    ''
  ]

  it.each(invalidIps)('非法 IP %j 被严格校验拒绝', (ip) => {
    expect(isValidIpv4Strict(ip)).toBe(false)
  })

  it.each(invalidIps)('非法 IP %j 返回 null 且不 spawn 进程（同步短路）', async (ip) => {
    // 非法输入在 execFile 之前 return Promise.resolve(null)，因此不会执行命令。
    await expect(icmpProbe(ip)).resolves.toBeNull()
  })

  it('合法 IPv4 通过校验', () => {
    expect(isValidIpv4Strict('192.168.1.1')).toBe(true)
    expect(isValidIpv4Strict('0.0.0.0')).toBe(true)
    expect(isValidIpv4Strict('255.255.255.255')).toBe(true)
  })
})

describe('runFullPrecheck - skipped 语义（不做无意义探测）', () => {
  it('port<=0 直接返回 skipped，reachable=true 避免 UI 误显示不可达', async () => {
    const result = await runFullPrecheck('192.168.1.10', 'rdp', 0)
    expect(result.skipped).toBe(true)
    expect(result.reachable).toBe(true)
    expect(result.conclusion).toBe('unknown')
    expect(result.port).toBe(0)
  })

  it('负数端口同样 skipped', async () => {
    const result = await runFullPrecheck('192.168.1.10', 'rdp', -1)
    expect(result.skipped).toBe(true)
    expect(result.conclusion).toBe('unknown')
  })

  it('rustdesk 协议跳过 TCP 探测，返回 skipped', async () => {
    const result = await runFullPrecheck('192.168.1.10', 'rustdesk', 3389)
    expect(result.skipped).toBe(true)
    expect(result.reachable).toBe(true)
    expect(result.conclusion).toBe('unknown')
  })
})
