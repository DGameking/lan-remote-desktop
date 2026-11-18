import { describe, it, expect } from 'vitest'
import { inferOsHint, deviceIdForIp } from '../src/main/discovery/aggregator'
import { isIpInSubnet, type SubnetInfo } from '../src/main/discovery/subnet'

describe('inferOsHint - 平台推断', () => {
  it('3389 端口高置信判定 Windows', () => {
    expect(inferOsHint([3389], '')).toBe('windows')
    expect(inferOsHint([3389, 5900], 'some-nas')).toBe('windows') // RDP 优先级最高
  })

  it('5900 端口配合名称关键字推断 mac/linux/fnos', () => {
    expect(inferOsHint([5900], 'MacBook-Air')).toBe('macos')
    expect(inferOsHint([5900], 'ubuntu-server')).toBe('linux')
    expect(inferOsHint([5900], '飞牛NAS')).toBe('fnos')
    expect(inferOsHint([5900], 'fnos-device')).toBe('fnos')
  })

  it('无端口无关键字时回退 unknown（协议层不可区分）', () => {
    expect(inferOsHint([5900], 'unknown-device')).toBe('unknown')
    expect(inferOsHint([], '')).toBe('unknown')
  })
})

describe('deviceIdForIp - 设备 ID 生成', () => {
  it('IP 点号转连字符且稳定', () => {
    expect(deviceIdForIp('192.168.1.20')).toBe('dev-192-168-1-20')
    expect(deviceIdForIp('192.168.1.20')).toBe(deviceIdForIp('192.168.1.20'))
  })
})

describe('isIpInSubnet - 网段归属判断', () => {
  const subnet: SubnetInfo = {
    ip: '192.168.1.10',
    netmask: '255.255.255.0',
    cidr: '192.168.1.0/24',
    hosts: ['192.168.1.1', '192.168.1.2', '192.168.1.20']
  }
  it('命中主机列表返回 true，否则 false', () => {
    expect(isIpInSubnet('192.168.1.20', subnet)).toBe(true)
    expect(isIpInSubnet('192.168.1.99', subnet)).toBe(false)
    expect(isIpInSubnet('10.0.0.1', subnet)).toBe(false)
  })
})
