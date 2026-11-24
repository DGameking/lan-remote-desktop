import { describe, it, expect } from 'vitest'
import { inferProtocol, parseConnectArgv, parseDeepLinkUrl } from '../src/shared/deeplink'
import { IPC_CHANNELS } from '../src/shared/types'

/* ===================== 端口推断 ===================== */

describe('v1.7-D inferProtocol 端口推断', () => {
  it('3389 推断 rdp，5900-5910 推断 vnc，其余不预设', () => {
    expect(inferProtocol('192.168.1.2', 3389)).toBe('rdp')
    expect(inferProtocol('192.168.1.2', 5900)).toBe('vnc')
    expect(inferProtocol('192.168.1.2', 5905)).toBe('vnc')
    expect(inferProtocol('192.168.1.2', 5910)).toBe('vnc')
    expect(inferProtocol('192.168.1.2', 5911)).toBeUndefined()
    expect(inferProtocol('192.168.1.2', 22)).toBeUndefined()
    expect(inferProtocol('192.168.1.2', 65535)).toBeUndefined()
  })
})

/* ===================== 命令行参数 ===================== */

describe('v1.7-D parseConnectArgv 合法写法', () => {
  it('支持 --connect=<ip>（不带端口）', () => {
    expect(parseConnectArgv(['--connect=192.168.1.20'])).toEqual({ ip: '192.168.1.20' })
  })

  it('支持 --connect=<ip>:<port> 并按端口推断协议', () => {
    expect(parseConnectArgv(['--connect=192.168.1.20:3389'])).toEqual({
      ip: '192.168.1.20',
      port: 3389,
      protocol: 'rdp'
    })
    expect(parseConnectArgv(['--connect=192.168.1.20:5905'])).toEqual({
      ip: '192.168.1.20',
      port: 5905,
      protocol: 'vnc'
    })
  })

  it('支持 --connect <ip>:<port> 分离写法', () => {
    expect(parseConnectArgv(['--connect', '10.0.0.8:3389'])).toEqual({
      ip: '10.0.0.8',
      port: 3389,
      protocol: 'rdp'
    })
  })

  it('支持 --protocol=xxx，显式协议优先于端口推断', () => {
    expect(parseConnectArgv(['--connect=10.0.0.8:5900', '--protocol=rdp'])).toEqual({
      ip: '10.0.0.8',
      port: 5900,
      protocol: 'rdp'
    })
  })

  it('protocol 出现在 connect 之前也生效，并支持分离写法', () => {
    expect(parseConnectArgv(['--protocol', 'rustdesk', '--connect', '10.0.0.8'])).toEqual({
      ip: '10.0.0.8',
      protocol: 'rustdesk'
    })
    expect(parseConnectArgv(['--protocol=vnc', '--connect=10.0.0.8:5901'])).toEqual({
      ip: '10.0.0.8',
      port: 5901,
      protocol: 'vnc'
    })
  })

  it('未知端口不预设协议', () => {
    expect(parseConnectArgv(['--connect=172.16.0.9:1234'])).toEqual({
      ip: '172.16.0.9',
      port: 1234
    })
  })

  it('忽略 Electron 自身及无关参数，不误判为目标', () => {
    const argv = [
      'C:\\Program Files\\LanDesk\\LanDesk.exe',
      '--electron-run-after-stdio',
      '--no-sandbox',
      '--user-data-dir=C:\\temp\\ld',
      '--connect=192.168.10.7',
      '--some-unknown-flag=value'
    ]
    expect(parseConnectArgv(argv)).toEqual({ ip: '192.168.10.7' })
  })

  it('端口边界 1 与 65535 合法', () => {
    expect(parseConnectArgv(['--connect=1.1.1.1:1'])).toEqual({ ip: '1.1.1.1', port: 1 })
    expect(parseConnectArgv(['--connect=1.1.1.1:65535'])).toEqual({ ip: '1.1.1.1', port: 65535 })
  })
})

describe('v1.7-D parseConnectArgv 非法输入', () => {
  it('没有 --connect 时返回 null（正常启动）', () => {
    expect(parseConnectArgv([])).toBeNull()
    expect(parseConnectArgv(['--electron-run-after-stdio', '--no-sandbox'])).toBeNull()
    expect(parseConnectArgv(['--protocol=rdp'])).toBeNull()
  })

  it('拒绝非法 IPv4', () => {
    for (const ip of [
      '999.1.1.1',
      '1.2.3',
      '1.2.3.4.5',
      '01.2.3.4',
      '1.02.3.4',
      '1.2.3.-1',
      'localhost',
      'example.com',
      '1.2.3.4:3389:5900'
    ]) {
      expect(parseConnectArgv([`--connect=${ip}`]), ip).toBeNull()
    }
  })

  it('拒绝非法端口', () => {
    for (const port of ['0', '65536', 'abc', '80x', '-1', '']) {
      expect(parseConnectArgv([`--connect=192.168.1.2:${port}`]), port).toBeNull()
    }
  })

  it('拒绝协议白名单之外的值', () => {
    expect(parseConnectArgv(['--connect=1.2.3.4', '--protocol=http'])).toBeNull()
    expect(parseConnectArgv(['--connect=1.2.3.4', '--protocol=javascript:'])).toBeNull()
    expect(parseConnectArgv(['--connect=1.2.3.4', '--protocol='])).toBeNull()
    expect(parseConnectArgv(['--connect=1.2.3.4', '--protocol'])).toBeNull()
    expect(parseConnectArgv(['--connect=1.2.3.4', '--protocol', 'file:'])).toBeNull()
  })

  it('拒绝 --connect 缺值或值为另一个参数', () => {
    expect(parseConnectArgv(['--connect'])).toBeNull()
    expect(parseConnectArgv(['--connect='])).toBeNull()
    expect(parseConnectArgv(['--connect', '--no-sandbox'])).toBeNull()
  })

  it('任何异常形状的输入都不抛错', () => {
    expect(() => parseConnectArgv(null as unknown as string[])).not.toThrow()
    expect(parseConnectArgv(null as unknown as string[])).toBeNull()
    expect(() => parseConnectArgv([1, 2, 3] as unknown as string[])).not.toThrow()
  })
})

/* ===================== 协议链接 ===================== */

describe('v1.7-D parseDeepLinkUrl 合法链接', () => {
  it('解析 landesk://connect?ip=...', () => {
    expect(parseDeepLinkUrl('landesk://connect?ip=192.168.1.20')).toEqual({ ip: '192.168.1.20' })
  })

  it('带端口时按端口推断协议', () => {
    expect(parseDeepLinkUrl('landesk://connect?ip=192.168.1.20&port=3389')).toEqual({
      ip: '192.168.1.20',
      port: 3389,
      protocol: 'rdp'
    })
    expect(parseDeepLinkUrl('landesk://connect?ip=192.168.1.20&port=5900')).toEqual({
      ip: '192.168.1.20',
      port: 5900,
      protocol: 'vnc'
    })
  })

  it('显式 protocol 优先于端口推断', () => {
    expect(
      parseDeepLinkUrl('landesk://connect?ip=192.168.1.20&port=5900&protocol=rdp')
    ).toEqual({ ip: '192.168.1.20', port: 5900, protocol: 'rdp' })
  })

  it('兼容 landesk:///connect 与大小写', () => {
    expect(parseDeepLinkUrl('landesk:///connect?ip=10.0.0.2')).toEqual({ ip: '10.0.0.2' })
    expect(
      parseDeepLinkUrl('landesk://CONNECT?ip=10.0.0.2&port=5901&protocol=VNC')
    ).toEqual({ ip: '10.0.0.2', port: 5901, protocol: 'vnc' })
  })

  it('未知端口不预设协议', () => {
    expect(parseDeepLinkUrl('landesk://connect?ip=10.0.0.2&port=1234')).toEqual({
      ip: '10.0.0.2',
      port: 1234
    })
  })
})

describe('v1.7-D parseDeepLinkUrl 非法与注入', () => {
  it('拒绝非 landesk: 协议（javascript: / file: / http:）', () => {
    expect(parseDeepLinkUrl('javascript:landesk://connect?ip=1.2.3.4')).toBeNull()
    expect(parseDeepLinkUrl('file:///connect?ip=1.2.3.4')).toBeNull()
    expect(parseDeepLinkUrl('http://connect?ip=1.2.3.4')).toBeNull()
    expect(parseDeepLinkUrl('https://connect?ip=1.2.3.4')).toBeNull()
  })

  it('拒绝非 connect 路径', () => {
    expect(parseDeepLinkUrl('landesk://other?ip=1.2.3.4')).toBeNull()
    expect(parseDeepLinkUrl('landesk://connect/extra?ip=1.2.3.4')).toBeNull()
    expect(parseDeepLinkUrl('landesk://?ip=1.2.3.4')).toBeNull()
  })

  it('拒绝缺失或非法的 ip', () => {
    expect(parseDeepLinkUrl('landesk://connect')).toBeNull()
    expect(parseDeepLinkUrl('landesk://connect?port=3389')).toBeNull()
    for (const ip of ['01.2.3.4', '256.1.1.1', '1.2.3', 'localhost', '1.2.3.4.5']) {
      expect(parseDeepLinkUrl(`landesk://connect?ip=${ip}`), ip).toBeNull()
    }
  })

  it('拒绝非法 port 与 protocol 参数', () => {
    expect(parseDeepLinkUrl('landesk://connect?ip=1.2.3.4&port=0')).toBeNull()
    expect(parseDeepLinkUrl('landesk://connect?ip=1.2.3.4&port=65536')).toBeNull()
    expect(parseDeepLinkUrl('landesk://connect?ip=1.2.3.4&port=abc')).toBeNull()
    expect(parseDeepLinkUrl('landesk://connect?ip=1.2.3.4&protocol=http')).toBeNull()
    expect(parseDeepLinkUrl('landesk://connect?ip=1.2.3.4&protocol=')).toBeNull()
  })

  it('拒绝 ip / protocol 里的 javascript: 与 file: 注入', () => {
    expect(parseDeepLinkUrl('landesk://connect?ip=javascript:alert(1)')).toBeNull()
    expect(parseDeepLinkUrl('landesk://connect?ip=file:///etc/passwd')).toBeNull()
    expect(parseDeepLinkUrl('landesk://connect?ip=1.2.3.4&protocol=javascript:')).toBeNull()
    expect(parseDeepLinkUrl('landesk://connect?ip=1.2.3.4&protocol=file:')).toBeNull()
    expect(parseDeepLinkUrl('landesk://connect?ip=1.2.3.4&port=javascript:')).toBeNull()
  })

  it('畸形 URL 与异常类型不抛异常', () => {
    expect(parseDeepLinkUrl('landesk://%')).toBeNull()
    expect(parseDeepLinkUrl('not a url')).toBeNull()
    expect(parseDeepLinkUrl('')).toBeNull()
    expect(() => parseDeepLinkUrl(null as unknown as string)).not.toThrow()
    expect(parseDeepLinkUrl(null as unknown as string)).toBeNull()
  })
})

/* ===================== 契约 ===================== */

describe('v1.7-D IPC 通道契约', () => {
  it('DEEPLINK_REQUEST 通道名固定，防止两端拼写漂移', () => {
    expect(IPC_CHANNELS.DEEPLINK_REQUEST).toBe('deeplink:request')
  })
})
