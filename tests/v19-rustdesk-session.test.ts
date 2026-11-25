import { describe, it, expect } from 'vitest'
import { normalizeRustdeskId, isRustdeskId } from '../src/shared/rustdesk-id'
import { parseConnectArgv, parseDeepLinkUrl } from '../src/shared/deeplink'
import { validateConnectRequest } from '../src/main/ipc/validators'

/* ===================== 会话码白名单 ===================== */

describe('v1.9 会话码白名单规范化', () => {
  it('接受纯数字会话码（RustDesk 官方 ID 形态）', () => {
    expect(normalizeRustdeskId('123456789')).toBe('123456789')
    expect(isRustdeskId('123456789')).toBe(true)
  })

  it('接受字母数字、下划线、连字符与首尾空白 trim', () => {
    expect(normalizeRustdeskId('  abc-123_XYZ  ')).toBe('abc-123_XYZ')
  })

  it('拒绝空格、点、冒号、斜杠等一切分隔/路径字符', () => {
    for (const bad of [
      '123 456',
      '192.168.1.20',
      'a:b',
      'a/b',
      'a\\b',
      '?a=b',
      'a&b',
      'a;b',
      'a|b',
      'a`b',
      'a$b',
      'a<b',
      'a>b',
      'a!b',
      'javascript:alert(1)',
      'rustdesk://1.2.3.4'
    ]) {
      expect(isRustdeskId(bad), bad).toBe(false)
    }
  })

  it('拒绝空串、超长、非字符串', () => {
    expect(isRustdeskId('')).toBe(false)
    expect(isRustdeskId('   ')).toBe(false)
    expect(isRustdeskId('a'.repeat(65))).toBe(false)
    expect(isRustdeskId(123456789)).toBe(false)
    expect(isRustdeskId(null)).toBe(false)
    expect(isRustdeskId(undefined)).toBe(false)
  })

  it('边界：1 位与 64 位合法，65 位非法', () => {
    expect(isRustdeskId('a')).toBe(true)
    expect(isRustdeskId('a'.repeat(64))).toBe(true)
    expect(isRustdeskId('a'.repeat(65))).toBe(false)
  })
})

/* ===================== 命令行解析 ===================== */

describe('v1.9 parseConnectArgv 会话码', () => {
  it('--connect=会话码 --protocol=rustdesk 解析成会话码请求', () => {
    expect(parseConnectArgv(['--connect=123456789', '--protocol=rustdesk'])).toEqual({
      ip: '123456789',
      protocol: 'rustdesk',
      rustdeskId: '123456789'
    })
  })

  it('--connect 会话码分离写法同样支持', () => {
    expect(parseConnectArgv(['--connect', 'abc-123', '--protocol=rustdesk'])).toEqual({
      ip: 'abc-123',
      protocol: 'rustdesk',
      rustdeskId: 'abc-123'
    })
  })

  it('无 --protocol=rustdesk 时，纯会话码仍按非法 IPv4 拒绝（不削弱 RDP/VNC 校验）', () => {
    expect(parseConnectArgv(['--connect=123456789'])).toBeNull()
    expect(parseConnectArgv(['--connect=123456789', '--protocol=rdp'])).toBeNull()
  })

  it('注入串即使带 --protocol=rustdesk 也被拒绝', () => {
    expect(parseConnectArgv(['--connect=a:b', '--protocol=rustdesk'])).toBeNull()
    expect(parseConnectArgv(['--connect=javascript:alert(1)', '--protocol=rustdesk'])).toBeNull()
  })

  it('rustdesk 会话码携带 port 参数时不生成非法目标（端口对会话码无意义）', () => {
    const result = parseConnectArgv(['--connect=123456789:5900', '--protocol=rustdesk'])
    // 含冒号非 IPv4 -> 会话码分支拒绝（冒号是非法字符）
    expect(result).toBeNull()
  })
})

/* ===================== 协议链接解析 ===================== */

describe('v1.9 parseDeepLinkUrl 会话码', () => {
  it('landesk://connect?id=会话码&protocol=rustdesk', () => {
    expect(parseDeepLinkUrl('landesk://connect?id=123456789&protocol=rustdesk')).toEqual({
      ip: '123456789',
      protocol: 'rustdesk',
      rustdeskId: '123456789'
    })
  })

  it('用 ip 参数承载会话码 + rustdesk 协议也可', () => {
    expect(parseDeepLinkUrl('landesk://connect?ip=abc-123&protocol=rustdesk')).toEqual({
      ip: 'abc-123',
      protocol: 'rustdesk',
      rustdeskId: 'abc-123'
    })
  })

  it('id 参数带注入字符被拒绝', () => {
    expect(parseDeepLinkUrl('landesk://connect?id=a%3Ab&protocol=rustdesk')).toBeNull()
    expect(parseDeepLinkUrl('landesk://connect?id=%2Fetc%2Fpasswd&protocol=rustdesk')).toBeNull()
  })

  it('非 rustdesk 协议下 id 会话码不被接受（维持 IPv4 强校验）', () => {
    expect(parseDeepLinkUrl('landesk://connect?id=123456789&protocol=rdp')).toBeNull()
  })

  it('E2E 兼容：原有 IPv4 链接不受影响', () => {
    expect(parseDeepLinkUrl('landesk://connect?ip=192.168.1.20:3389')).toBeNull() // 端口应走 port 参数
    expect(parseDeepLinkUrl('landesk://connect?ip=192.168.1.20&port=3389')).toEqual({
      ip: '192.168.1.20',
      port: 3389,
      protocol: 'rdp'
    })
  })
})

/* ===================== IPC 校验器 ===================== */

describe('v1.9 validateConnectRequest rustdesk 放宽与隔离', () => {
  const base = { deviceId: 'dev-1', ip: '123456789', protocol: 'rustdesk' }

  it('rustdesk 会话码请求通过校验并透传 rustdeskId', () => {
    const req = validateConnectRequest({ ...base, rustdeskId: '123456789' })
    expect(req.protocol).toBe('rustdesk')
    expect(req.rustdeskId).toBe('123456789')
    expect(req.ip).toBe('123456789')
  })

  it('rustdesk 下 ip 承载会话码（无 rustdeskId 字段）也通过', () => {
    const req = validateConnectRequest(base)
    expect(req.rustdeskId).toBe('123456789')
    expect(req.ip).toBe('123456789')
  })

  it('rustdesk 非法会话码被拒绝', () => {
    expect(() => validateConnectRequest({ ...base, ip: 'a:b' })).toThrow(/会话码/)
  })

  it('非 rustdesk 协议仍强制 IPv4，会话码被拒绝', () => {
    expect(() => validateConnectRequest({ deviceId: 'd', ip: '123456789', protocol: 'rdp' })).toThrow(/IP/)
  })

  it('非 rustdesk 协议忽略注入的 rustdeskId，避免串味', () => {
    const req = validateConnectRequest({
      deviceId: 'd',
      ip: '192.168.1.20',
      protocol: 'vnc',
      rustdeskId: '123456789'
    })
    expect(req.rustdeskId).toBeUndefined()
  })

  it('rustdesk 分支不带端口预检污染（precheck 仍要求合法 IPv4）', () => {
    const req = validateConnectRequest({
      ...base,
      precheck: { ip: 'not-ip', port: 5900, reachable: true, latencyMs: 1 }
    })
    expect(req.precheck).toBeUndefined()
  })
})
