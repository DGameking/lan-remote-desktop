import { describe, it, expect } from 'vitest'
import { parseTarget, defaultPortFor } from '../src/renderer/src/quick-connect'

describe('parseTarget - 通用 IP:端口 解析', () => {
  it('支持纯 IPv4', () => {
    const result = parseTarget('192.168.1.20')
    expect(result).not.toBeNull()
    expect(result!.ip).toBe('192.168.1.20')
    expect(result!.port).toBeUndefined()
    expect(result!.protocolHint).toBeUndefined()
  })

  it('支持 IP:端口', () => {
    const result = parseTarget('10.0.0.7:8080')
    expect(result).toMatchObject({ ip: '10.0.0.7', port: 8080 })
    expect(result!.protocolHint).toBeUndefined()
  })

  it('去除首尾空白', () => {
    expect(parseTarget('  192.168.1.20:5900  ')).toMatchObject({
      ip: '192.168.1.20',
      port: 5900,
      protocolHint: 'vnc'
    })
  })

  it('拒绝非法 IP', () => {
    expect(parseTarget('abc')).toBeNull()
    expect(parseTarget('1.2.3')).toBeNull()
    expect(parseTarget('1.2.3.4.5')).toBeNull()
    expect(parseTarget('999.1.1.1')).toBeNull()
    expect(parseTarget('192.168.1.256')).toBeNull()
    expect(parseTarget('')).toBeNull()
  })

  it('拒绝非法端口', () => {
    expect(parseTarget('192.168.1.20:0')).toBeNull()
    expect(parseTarget('192.168.1.20:65536')).toBeNull()
    expect(parseTarget('192.168.1.20:abc')).toBeNull()
    expect(parseTarget('192.168.1.20:')).toBeNull()
    expect(parseTarget('192.168.1.20:1:2')).toBeNull()
  })

  it('端口推断协议：3389→rdp，5900-5910→vnc，其余无提示', () => {
    expect(parseTarget('192.168.1.20:3389')!.protocolHint).toBe('rdp')
    expect(parseTarget('192.168.1.20:5900')!.protocolHint).toBe('vnc')
    expect(parseTarget('192.168.1.20:5901')!.protocolHint).toBe('vnc')
    expect(parseTarget('192.168.1.20:5910')!.protocolHint).toBe('vnc')
    expect(parseTarget('192.168.1.20:5911')!.protocolHint).toBeUndefined()
    expect(parseTarget('192.168.1.20:22')!.protocolHint).toBeUndefined()
  })
})

describe('defaultPortFor - 协议默认端口', () => {
  it('rdp→3389，vnc→5900，rustdesk→undefined', () => {
    expect(defaultPortFor('rdp')).toBe(3389)
    expect(defaultPortFor('vnc')).toBe(5900)
    expect(defaultPortFor('rustdesk')).toBeUndefined()
  })
})
