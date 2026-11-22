import { describe, it, expect, vi } from 'vitest'
import {
  classifyInterface,
  subnetContainsIp,
  parseManualSubnet,
  sortSubnets,
  type SubnetInfo
} from '../src/main/discovery/subnet'

function makeSubnet(ip: string, cidr: string): SubnetInfo {
  return {
    ip,
    cidr,
    netmask: '255.255.255.0',
    hosts: [],
    kind: 'physical'
  }
}

describe('v1.4-A classifyInterface - 虚拟网卡识别', () => {
  it('WSL / Hyper-V / vEthernet 网卡判为虚拟', () => {
    expect(classifyInterface('vEthernet (WSL)', '172.27.112.1')).toBe('virtual')
    expect(classifyInterface('vEthernet (Default Switch)', '172.27.0.1')).toBe('virtual')
    expect(classifyInterface('Hyper-V Virtual Ethernet Adapter', '192.168.137.1')).toBe('virtual')
  })

  it('Docker / VPN / TAP 网卡判为虚拟', () => {
    expect(classifyInterface('Docker Desktop', '172.17.0.1')).toBe('virtual')
    expect(classifyInterface('TAP-Windows Adapter', '10.8.0.2')).toBe('virtual')
    expect(classifyInterface('WireGuard Tunnel', '10.9.0.1')).toBe('virtual')
  })

  it('常见物理网卡名判为物理', () => {
    expect(classifyInterface('以太网', '192.168.10.68')).toBe('physical')
    expect(classifyInterface('WLAN', '192.168.1.20')).toBe('physical')
    expect(classifyInterface('Realtek PCIe GbE Family Controller', '10.0.0.5')).toBe('physical')
  })

  it('172.17~172.31 容器常见段即使网卡名正常也降权为虚拟', () => {
    expect(classifyInterface('Ethernet', '172.18.0.1')).toBe('virtual')
    expect(classifyInterface('Ethernet', '172.31.255.1')).toBe('virtual')
  })

  it('172.16 段（合法的私有段起点）不被误伤为虚拟', () => {
    expect(classifyInterface('以太网', '172.16.5.10')).toBe('physical')
  })
})

describe('v1.4-A subnetContainsIp - CIDR 归属判断', () => {
  it('同一 /24 网段内的 IP 命中', () => {
    const subnet = makeSubnet('192.168.10.68', '192.168.10.0/24')
    expect(subnetContainsIp('192.168.10.1', subnet)).toBe(true)
    expect(subnetContainsIp('192.168.10.254', subnet)).toBe(true)
  })

  it('跨网段 IP 不命中（172.18.0.1 不得混入 192.168.10.0/24）', () => {
    const subnet = makeSubnet('192.168.10.68', '192.168.10.0/24')
    expect(subnetContainsIp('172.18.0.1', subnet)).toBe(false)
    expect(subnetContainsIp('192.168.11.5', subnet)).toBe(false)
  })

  it('本机 IP 作为 network base 时计算网络号正确', () => {
    // subnet.ip 存的是本机地址而非网络号，实现应对其 & mask 得到正确网络号
    const subnet = makeSubnet('10.0.0.55', '10.0.0.0/8')
    expect(subnetContainsIp('10.200.3.4', subnet)).toBe(true)
    expect(subnetContainsIp('11.0.0.1', subnet)).toBe(false)
  })

  it('/16 与 /24 边界正确', () => {
    const s16 = makeSubnet('192.168.5.9', '192.168.0.0/16')
    expect(subnetContainsIp('192.168.200.1', s16)).toBe(true)
    expect(subnetContainsIp('192.169.1.1', s16)).toBe(false)
  })

  it('非法 IP 一律不命中', () => {
    const subnet = makeSubnet('192.168.10.68', '192.168.10.0/24')
    expect(subnetContainsIp('not-an-ip', subnet)).toBe(false)
    expect(subnetContainsIp('999.1.1.1', subnet)).toBe(false)
  })

  it('非法 prefix 一律不命中（QA P2）', () => {
    const bad = makeSubnet('192.168.10.68', '192.168.10.0/99')
    expect(subnetContainsIp('192.168.10.1', bad)).toBe(false)
  })
})

describe('v1.4-A sortSubnets - 主网卡优先于虚拟降权（QA P1-1 回归）', () => {
  it('真实 172.20 主网段即使被启发式标为 virtual 也必须排第一', () => {
    const primary172 = { ...makeSubnet('172.20.0.9', '172.20.0.0/24'), kind: 'virtual' as const, isPrimary: true }
    const physical192 = { ...makeSubnet('192.168.5.10', '192.168.5.0/24'), kind: 'physical' as const, isPrimary: false }
    const sorted = sortSubnets([physical192, primary172])
    expect(sorted[0].cidr).toBe('172.20.0.0/24')
  })

  it('无主网卡标记时，虚拟网卡降权垫底', () => {
    const virtual = { ...makeSubnet('172.27.112.1', '172.27.112.0/24'), kind: 'virtual' as const }
    const physical = { ...makeSubnet('192.168.10.68', '192.168.10.0/24'), kind: 'physical' as const }
    const sorted = sortSubnets([virtual, physical])
    expect(sorted[0].cidr).toBe('192.168.10.0/24')
  })

  it('排序不修改原数组', () => {
    const list = [
      { ...makeSubnet('172.27.112.1', '172.27.112.0/24'), kind: 'virtual' as const },
      { ...makeSubnet('192.168.10.68', '192.168.10.0/24'), kind: 'physical' as const }
    ]
    const firstBefore = list[0].cidr
    sortSubnets(list)
    expect(list[0].cidr).toBe(firstBefore)
  })
})

describe('v1.4-A parseManualSubnet - 手动网段解析', () => {
  it('解析 CIDR 写法 192.168.10.0/24', () => {
    const parsed = parseManualSubnet('192.168.10.0/24')
    expect(parsed).not.toBeNull()
    expect(parsed!.cidr).toBe('192.168.10.0/24')
    expect(parsed!.isPrimary).toBe(true)
    expect(parsed!.iface).toBe('手动指定')
  })

  it('解析单 IP 写法 192.168.10.68（按 /24）', () => {
    const parsed = parseManualSubnet('192.168.10.68')
    expect(parsed).not.toBeNull()
    expect(parsed!.cidr).toBe('192.168.10.0/24')
  })

  it('带空白输入可归一化', () => {
    expect(parseManualSubnet('  10.0.0.5/24  ')?.cidr).toBe('10.0.0.0/24')
  })

  it('非法前缀与非法 IP 返回 null', () => {
    expect(parseManualSubnet('192.168.10.0/7')).toBeNull()
    expect(parseManualSubnet('192.168.10.0/33')).toBeNull()
    expect(parseManualSubnet('999.1.1.1/24')).toBeNull()
    expect(parseManualSubnet('abc')).toBeNull()
  })

  it('宽网段 /8~/23 收敛到 /24，避免声称扫大网段实际只扫 254 个', () => {
    const parsed = parseManualSubnet('10.0.0.0/8')
    expect(parsed).not.toBeNull()
    expect(parsed!.cidr).toBe('10.0.0.0/24')
  })
})
