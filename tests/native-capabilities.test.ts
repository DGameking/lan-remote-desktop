import { describe, it, expect } from 'vitest'
import {
  MANAGE_PORT_PRIORITY,
  pickManagePorts,
  isPrivateLanIp,
  buildManageUrl
} from '../src/main/protocols/serverlink'
import { parseMac, buildMagicPacket, broadcastForCidr } from '../src/main/discovery/wol'

describe('MANAGE_PORT_PRIORITY / pickManagePorts - 管理页端口白名单', () => {
  it('常量顺序固定为约定的 6 个端口', () => {
    expect([...MANAGE_PORT_PRIORITY]).toEqual([8000, 8001, 5666, 548, 5985, 5986])
  })

  it('乱序 / 重复按优先级排序并去重', () => {
    expect(pickManagePorts([5986, 8000, 5666, 8001, 8000, 548, 5985])).toEqual([
      8000, 8001, 5666, 548, 5985, 5986
    ])
  })

  it('过滤掉不在白名单的端口', () => {
    expect(pickManagePorts([3389, 5900, 8000, 22, 5666])).toEqual([8000, 5666])
  })

  it('过滤非法端口（0 / 负数 / 超范围 / 小数 / NaN）', () => {
    expect(pickManagePorts([0, -1, 65536, 8000.5, NaN, 8000])).toEqual([8000])
  })

  it('无候选返回空数组', () => {
    expect(pickManagePorts([3389, 5900, 22])).toEqual([])
    expect(pickManagePorts([])).toEqual([])
  })
})

describe('isPrivateLanIp - 私有局域网 IPv4 严格校验', () => {
  it('放行三个私有段的合法主机地址', () => {
    expect(isPrivateLanIp('192.168.1.20')).toBe(true)
    expect(isPrivateLanIp('10.0.0.7')).toBe(true)
    expect(isPrivateLanIp('172.16.5.9')).toBe(true)
    expect(isPrivateLanIp('172.31.200.1')).toBe(true)
  })

  it('拒绝回环 / 公网 / 链路本地 / 组播及保留 / 未指定地址', () => {
    for (const ip of [
      '127.0.0.1',
      '8.8.8.8',
      '169.254.1.1',
      '224.0.0.1',
      '0.0.0.0',
      '239.1.2.3',
      '255.255.255.255'
    ]) {
      expect(isPrivateLanIp(ip)).toBe(false)
    }
  })

  it('拒绝 .0 / .255 网络号与广播地址', () => {
    expect(isPrivateLanIp('192.168.1.0')).toBe(false)
    expect(isPrivateLanIp('192.168.1.255')).toBe(false)
    expect(isPrivateLanIp('10.1.2.0')).toBe(false)
  })

  it('拒绝非私有 172 段', () => {
    expect(isPrivateLanIp('172.15.1.1')).toBe(false)
    expect(isPrivateLanIp('172.32.1.1')).toBe(false)
  })

  it('拒绝 hostname / IPv6 / 带端口路径 / 前导零 / 越界段', () => {
    for (const ip of [
      'nas.local',
      '::1',
      'fe80::1',
      '192.168.1.1:8000',
      '010.1.1.1',
      '192.168.1.256',
      '192.168.1',
      '192.168.1.1.1',
      '192.168.1.1/path',
      '999.1.1.1',
      ''
    ]) {
      expect(isPrivateLanIp(ip)).toBe(false)
    }
  })
})

describe('buildManageUrl - 防 SSRF 管理页 URL 构造', () => {
  it('合法路径产出精确 http URL，且不含任何 path / query / fragment / userinfo', () => {
    const result = buildManageUrl({ ip: '192.168.1.20', port: 8000, detectedPorts: [8000, 3389] })
    expect(result.ok).toBe(true)
    expect(result.url).toBe('http://192.168.1.20:8000')
    expect(result.url!.slice('http://'.length)).not.toContain('/')
    expect(result.url).not.toMatch(/[?#@]/)
  })

  it('端口不在 detectedPorts 被拒', () => {
    const result = buildManageUrl({ ip: '192.168.1.20', port: 8000, detectedPorts: [3389, 5900] })
    expect(result.ok).toBe(false)
    expect(result.url).toBeUndefined()
    expect(result.message).toContain('已发现端口列表')
  })

  it('端口不在优先级白名单被拒（即便已被发现）', () => {
    const result = buildManageUrl({ ip: '192.168.1.20', port: 3389, detectedPorts: [3389] })
    expect(result.ok).toBe(false)
    expect(result.url).toBeUndefined()
    expect(result.message).toContain('管理页端口')
  })

  it('公网 IP 被拒', () => {
    expect(buildManageUrl({ ip: '8.8.8.8', port: 8000, detectedPorts: [8000] }).ok).toBe(false)
  })

  it('hostname 被拒', () => {
    expect(buildManageUrl({ ip: 'nas.local', port: 8000, detectedPorts: [8000] }).ok).toBe(false)
  })

  it('非法端口被拒', () => {
    expect(buildManageUrl({ ip: '192.168.1.20', port: 0, detectedPorts: [0] }).ok).toBe(false)
    expect(buildManageUrl({ ip: '192.168.1.20', port: 70000, detectedPorts: [70000] }).ok).toBe(false)
  })

  it('失败时只返回结构、不抛异常、不产出 url', () => {
    const result = buildManageUrl({ ip: '127.0.0.1', port: 8000, detectedPorts: [8000] })
    expect(result.ok).toBe(false)
    expect(result.url).toBeUndefined()
    expect(typeof result.message).toBe('string')
  })
})

describe('parseMac - MAC 解析', () => {
  it('支持冒号 / 连字符 / 点分 / 纯 12 位 hex 四种格式', () => {
    const expected = Buffer.from('aabbccddeeff', 'hex')
    expect(parseMac('AA:BB:CC:DD:EE:FF')).toEqual(expected)
    expect(parseMac('AA-BB-CC-DD-EE-FF')).toEqual(expected)
    expect(parseMac('aabb.ccdd.eeff')).toEqual(expected)
    expect(parseMac('AABBCCDDEEFF')).toEqual(expected)
  })

  it('大小写不敏感、允许首尾空白，统一返回 6 字节 Buffer', () => {
    const bytes = parseMac('  aa:bb:cc:dd:ee:ff  ')
    expect(Buffer.isBuffer(bytes)).toBe(true)
    expect(bytes!.length).toBe(6)
    expect(bytes).toEqual(Buffer.from('aabbccddeeff', 'hex'))
  })

  it('非法输入返回 null', () => {
    for (const mac of [
      '',
      'AA:BB:CC:DD:EE', // 少一组
      'AA:BB:CC:DD:EE:FF:00', // 多一组
      'GG:BB:CC:DD:EE:FF', // 非 hex 字符
      'AA:BB-CC-DD-EE-FF', // 混合分隔符
      'AABBCCDDEEF', // 11 位
      'AABBCCDDEEFFF', // 13 位
      '00:00:00:00:00:00', // 全 0
      'FF:FF:FF:FF:FF:FF', // 全 F 广播
      'ffffffffffff',
      'not-a-mac',
      'AA BB CC DD EE FF'
    ]) {
      expect(parseMac(mac)).toBeNull()
    }
  })
})

describe('buildMagicPacket - WoL 魔术包', () => {
  it('长度 102、前 6 字节全 0xFF、第 6..11 字节等于 MAC、MAC 重复 16 次', () => {
    const bytes = parseMac('AA:BB:CC:DD:EE:FF')!
    const packet = buildMagicPacket('AA:BB:CC:DD:EE:FF')!
    expect(packet.length).toBe(102)
    for (let i = 0; i < 6; i++) expect(packet[i]).toBe(0xff)
    expect(packet.subarray(6, 12)).toEqual(bytes)
    for (let i = 0; i < 16; i++) {
      expect(packet.subarray(6 + i * 6, 12 + i * 6)).toEqual(bytes)
    }
  })

  it('非法 MAC 返回 null', () => {
    expect(buildMagicPacket('invalid')).toBeNull()
    expect(buildMagicPacket('FF:FF:FF:FF:FF:FF')).toBeNull()
  })
})

describe('broadcastForCidr - /24 定向广播计算', () => {
  it('/24 正确算出 .255 定向广播', () => {
    expect(broadcastForCidr('192.168.1.0/24')).toBe('192.168.1.255')
    expect(broadcastForCidr('10.2.3.0/24')).toBe('10.2.3.255')
    // 传入主机 IP 也归一到所在 /24 的广播地址
    expect(broadcastForCidr('192.168.1.42/24')).toBe('192.168.1.255')
  })

  it('非 /24 返回 null（调用方回落 255.255.255.255）', () => {
    expect(broadcastForCidr('10.0.0.0/8')).toBeNull()
    expect(broadcastForCidr('192.168.0.0/16')).toBeNull()
  })

  it('非法串返回 null', () => {
    for (const s of [
      '',
      '192.168.1.0',
      'abc/24',
      '999.1.1.0/24',
      '192.168.1.0/33',
      '192.168.1.0/'
    ]) {
      expect(broadcastForCidr(s)).toBeNull()
    }
  })
})
