import { describe, it, expect } from 'vitest'
import {
  isValidIp,
  validateDevice,
  validateConnectRequest,
  validateCredentialInput,
  ok,
  fail
} from '../src/main/ipc/validators'
import { isProtocolId } from '../src/main/protocols/registry'

describe('isValidIp - IP 地址校验', () => {
  it('接受合法 IPv4', () => {
    expect(isValidIp('192.168.1.1')).toBe(true)
    expect(isValidIp('10.0.0.255')).toBe(true)
    expect(isValidIp('0.0.0.0')).toBe(true)
    expect(isValidIp('255.255.255.255')).toBe(true)
  })

  it('拒绝非法 IPv4', () => {
    expect(isValidIp('192.168.1')).toBe(false) // 段数不足
    expect(isValidIp('192.168.1.256')).toBe(false) // 超过 255
    expect(isValidIp('192.168.1.-1')).toBe(false) // 负数
    expect(isValidIp('abc.def.ghi.jkl')).toBe(false) // 非数字
    expect(isValidIp('')).toBe(false)
    expect(isValidIp(12345)).toBe(false) // 非字符串
    expect(isValidIp('1.2.3.4.5')).toBe(false) // 段数过多
  })
})

describe('isProtocolId - 协议白名单', () => {
  it('仅接受 rdp/vnc/rustdesk', () => {
    expect(isProtocolId('rdp')).toBe(true)
    expect(isProtocolId('vnc')).toBe(true)
    expect(isProtocolId('rustdesk')).toBe(true)
    expect(isProtocolId('ssh')).toBe(false)
    expect(isProtocolId('RDP')).toBe(false)
    expect(isProtocolId(null)).toBe(false)
  })
})

describe('validateDevice - 设备参数校验与归一化', () => {
  it('合法输入归一化：osHint/source 非法时降级', () => {
    const device = validateDevice({
      ip: '192.168.1.20',
      name: '  ',
      osHint: 'hacker-os',
      source: 'unknown-source',
      availableProtocols: ['rdp', 'ssh', 'vnc']
    })
    expect(device.ip).toBe('192.168.1.20')
    expect(device.name).toBe('192.168.1.20') // 空名回退到 IP
    expect(device.osHint).toBe('unknown')
    expect(device.source).toBe('manual')
    expect(device.availableProtocols).toEqual(['rdp', 'vnc']) // 过滤非法协议
    expect(device.id).toBe('dev-192-168-1-20')
    expect(device.online).toBe(true)
  })

  it('非法 IP 抛错，非对象抛错', () => {
    expect(() => validateDevice({ ip: '999.1.1.1' })).toThrow(/IP/)
    expect(() => validateDevice(null)).toThrow(/格式/)
  })
})

describe('validateConnectRequest - 连接请求校验', () => {
  it('合法请求保留字段并校验端口', () => {
    const req = validateConnectRequest({
      ip: '10.0.0.5',
      protocol: 'rdp',
      port: 3389,
      username: 'admin',
      password: 'secret',
      screenMode: 'fullscreen'
    })
    expect(req.ip).toBe('10.0.0.5')
    expect(req.protocol).toBe('rdp')
    expect(req.port).toBe(3389)
    expect(req.screenMode).toBe('fullscreen')
  })

  it('越界端口被丢弃，非法协议/IP 抛错', () => {
    const req = validateConnectRequest({ ip: '10.0.0.5', protocol: 'vnc', port: 70000 })
    expect(req.port).toBeUndefined()
    expect(() => validateConnectRequest({ ip: 'bad', protocol: 'vnc' })).toThrow(/IP/)
    expect(() => validateConnectRequest({ ip: '10.0.0.5', protocol: 'telnet' })).toThrow(/协议/)
  })
})

describe('validateCredentialInput - 凭据输入校验', () => {
  it('缺少 deviceId 抛错，合法输入保留字段', () => {
    expect(() => validateCredentialInput({ protocol: 'rdp' })).toThrow(/设备 ID/)
    const cred = validateCredentialInput({ deviceId: 'dev-1', protocol: 'vnc', username: 'u', password: 'p' })
    expect(cred.deviceId).toBe('dev-1')
    expect(cred.protocol).toBe('vnc')
    expect(cred.password).toBe('p')
  })
})

describe('IPC 统一响应包装', () => {
  it('ok 返回 code=0 与 data', () => {
    expect(ok({ a: 1 })).toEqual({ code: 0, message: 'success', data: { a: 1 } })
  })
  it('fail 返回非零 code 与 null data', () => {
    expect(fail('错误', 42)).toEqual({ code: 42, message: '错误', data: null })
  })
})
