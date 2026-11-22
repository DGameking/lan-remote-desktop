import { describe, it, expect, vi } from 'vitest'

// 纯函数测试不触碰真实网络：屏蔽 bonjour-service，仅让 mdns 模块可被安全加载。
vi.mock('bonjour-service', () => ({
  default: class FakeBonjour {
    find() { return { stop: () => {} } }
    destroy() {}
  }
}))

import {
  MDNS_SERVICE_TYPES,
  parseMdnsTxt,
  inferMdnsFingerprint
} from '../src/main/discovery/mdns'

describe('MDNS_SERVICE_TYPES - 服务类型表', () => {
  it('包含约定的全部服务类型', () => {
    const types = MDNS_SERVICE_TYPES.map((entry) => entry.type)
    expect(types).toEqual(expect.arrayContaining([
      'rfb', 'rdp', 'smb', 'ssh', 'sftp-ssh', 'afpovertcp', 'device-info', 'net-assistant'
    ]))
  })

  it('只有 rfb / rdp 带 connectProtocol，其余不污染连接协议枚举', () => {
    const withConnect = MDNS_SERVICE_TYPES
      .filter((entry) => entry.connectProtocol)
      .map((entry) => entry.type)
    expect(withConnect.sort()).toEqual(['rdp', 'rfb'])

    const rfb = MDNS_SERVICE_TYPES.find((entry) => entry.type === 'rfb')!
    const rdp = MDNS_SERVICE_TYPES.find((entry) => entry.type === 'rdp')!
    expect(rfb.connectProtocol).toBe('vnc')
    expect(rfb.defaultPort).toBe(5900)
    expect(rdp.connectProtocol).toBe('rdp')
    expect(rdp.defaultPort).toBe(3389)

    for (const type of ['smb', 'ssh', 'sftp-ssh', 'afpovertcp', 'device-info', 'net-assistant']) {
      expect(MDNS_SERVICE_TYPES.find((entry) => entry.type === type)!.connectProtocol).toBeUndefined()
    }
  })

  it('device-info 不承载端口（defaultPort=0）', () => {
    expect(MDNS_SERVICE_TYPES.find((entry) => entry.type === 'device-info')!.defaultPort).toBe(0)
  })

  it('net-assistant 走 udp（BonjourConfig 已核实支持）', () => {
    expect(MDNS_SERVICE_TYPES.find((entry) => entry.type === 'net-assistant')!.protocol).toBe('udp')
  })
})

describe('parseMdnsTxt - TXT 白名单与清洗', () => {
  it('undefined 返回空对象', () => {
    expect(parseMdnsTxt(undefined)).toEqual({})
  })

  it('仅保留白名单键，丢弃其它键', () => {
    const parsed = parseMdnsTxt({
      model: 'MacBookPro18,3',
      osxvers: '14',
      manufacturer: 'Apple',
      secret: 'should-be-dropped',
      token: 'drop-me'
    })
    expect(parsed).toEqual({
      model: 'MacBookPro18,3',
      osxvers: '14',
      manufacturer: 'Apple'
    })
    expect(parsed.secret).toBeUndefined()
    expect(parsed.token).toBeUndefined()
  })

  it('覆盖全部 8 个白名单键', () => {
    const parsed = parseMdnsTxt({
      model: 'm', osxvers: 'v', Mac: 'aa:bb:cc', manufacturer: 'mf',
      modelName: 'mn', server: 'sv', vendor: 'vd', os: 'linux'
    })
    expect(Object.keys(parsed).sort()).toEqual(
      ['Mac', 'manufacturer', 'model', 'modelName', 'os', 'osxvers', 'server', 'vendor'].sort()
    )
  })

  it('Buffer 值统一转字符串', () => {
    const parsed = parseMdnsTxt({
      model: Buffer.from('iMac21,1'),
      vendor: Buffer.from('Apple Inc.')
    })
    expect(parsed.model).toBe('iMac21,1')
    expect(parsed.vendor).toBe('Apple Inc.')
    expect(typeof parsed.model).toBe('string')
  })

  it('超长值截断到 256 字符', () => {
    const parsed = parseMdnsTxt({ model: 'x'.repeat(300) })
    expect(parsed.model).toHaveLength(256)
    expect(parsed.model).toBe('x'.repeat(256))
  })

  it('值为 undefined 的键被跳过（空串仍保留）', () => {
    expect(parseMdnsTxt({ model: undefined, os: '' })).toEqual({ os: '' })
  })
})

describe('inferMdnsFingerprint - 服务指纹推断', () => {
  it('rfb vnc 5900 → macos / 5900', () => {
    expect(inferMdnsFingerprint({ service: 'vnc', port: 5900, name: '', txt: {} })).toEqual([
      { port: 5900, service: 'vnc', osHint: 'macos', raw: 'mdns:rfb' }
    ])
  })

  it('vnc 弱信号放在数组末尾（关键字补充条在前）', () => {
    const fps = inferMdnsFingerprint({ service: 'vnc', port: 5900, name: 'fnos-nas', txt: {} })
    expect(fps[fps.length - 1]).toEqual({ port: 5900, service: 'vnc', osHint: 'macos', raw: 'mdns:rfb' })
    expect(fps[0]).toEqual({ port: 0, service: 'http', osHint: 'fnos' })
  })

  it('vnc 非 5900 端口不产出 macos 主指纹', () => {
    expect(inferMdnsFingerprint({ service: 'vnc', port: 5901, name: '', txt: {} })).toEqual([])
  })

  it('ssh（含 sftp-ssh 映射）→ linux / 22', () => {
    expect(inferMdnsFingerprint({ service: 'ssh', port: 22, name: '', txt: {} })).toEqual([
      { port: 22, service: 'ssh', osHint: 'linux' }
    ])
  })

  it('smb → 445 且不推断 OS', () => {
    const fps = inferMdnsFingerprint({ service: 'smb', port: 445, name: '', txt: {} })
    expect(fps).toEqual([{ port: 445, service: 'smb' }])
    expect(fps[0].osHint).toBeUndefined()
  })

  it('afp → macos / 548', () => {
    expect(inferMdnsFingerprint({ service: 'afp', port: 548, name: '', txt: {} })).toEqual([
      { port: 548, service: 'afp', osHint: 'macos' }
    ])
  })

  it('device-info txt.model → macos 且 port=0', () => {
    expect(inferMdnsFingerprint({
      service: 'unknown', port: 0, name: '', txt: { model: 'MacBookPro18,3' }
    })).toEqual([
      { port: 0, service: 'http', osHint: 'macos', raw: 'mdns:device-info' }
    ])
  })

  it('txt.osxvers 或 name 含 mac/macbook/imac → device-info macos', () => {
    expect(inferMdnsFingerprint({
      service: 'unknown', port: 0, name: '', txt: { osxvers: '14' }
    })[0]).toEqual({ port: 0, service: 'http', osHint: 'macos', raw: 'mdns:device-info' })
    expect(inferMdnsFingerprint({
      service: 'unknown', port: 0, name: "Johns-iMac", txt: {}
    })).toContainEqual({ port: 0, service: 'http', osHint: 'macos', raw: 'mdns:device-info' })
  })

  it('飞牛 / fnos / nas 关键字 → fnos', () => {
    for (const name of ['飞牛NAS', 'fnos-server', 'MyNAS']) {
      expect(inferMdnsFingerprint({ service: 'unknown', port: 0, name, txt: {} }))
        .toContainEqual({ port: 0, service: 'http', osHint: 'fnos' })
    }
  })

  it('未知情况返回空数组（不凑数产出 unknown 指纹）', () => {
    expect(inferMdnsFingerprint({ service: 'unknown', port: 0, name: 'office-printer', txt: {} })).toEqual([])
    expect(inferMdnsFingerprint({ service: 'rdp', port: 3389, name: '', txt: {} })).toEqual([])
  })
})

describe('device-info 的 port:0 不被误当真实端口', () => {
  // 复刻 aggregator.ts:123 的约定：fp.port >= 1 && fp.port <= 65535 才并入 detectedPorts
  const toDetectedPorts = (fps: { port: number }[]): number[] =>
    fps.map((fp) => fp.port).filter((port) => port >= 1 && port <= 65535)

  it('device-info 指纹经端口过滤后为空', () => {
    const fps = inferMdnsFingerprint({
      service: 'unknown', port: 0, name: '', txt: { model: 'iMac' }
    })
    expect(fps.every((fp) => fp.port === 0)).toBe(true)
    expect(toDetectedPorts(fps)).toEqual([])
  })

  it('真实服务指纹的端口能被保留', () => {
    const fps = inferMdnsFingerprint({ service: 'vnc', port: 5900, name: '', txt: {} })
    expect(toDetectedPorts(fps)).toEqual([5900])
  })
})
