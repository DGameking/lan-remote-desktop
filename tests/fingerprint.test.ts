import { describe, it, expect } from 'vitest'
import {
  parseRfbBanner,
  parseSshBanner,
  parseHttpHeaders,
  probeFingerprints
} from '../src/main/discovery/fingerprint'

describe('parseRfbBanner - RFB 版本横幅', () => {
  it('标准 VNC 003.008', () => {
    const fp = parseRfbBanner(Buffer.from('RFB 003.008\n'))
    expect(fp).not.toBeNull()
    expect(fp!.service).toBe('vnc')
    expect(fp!.version).toBe('003.008')
    expect(fp!.osHint).toBeUndefined()
  })

  it('Apple 屏幕共享 003.889 推断 macos', () => {
    const fp = parseRfbBanner(Buffer.from('RFB 003.889\n'))
    expect(fp).not.toBeNull()
    expect(fp!.version).toBe('003.889')
    expect(fp!.osHint).toBe('macos')
  })

  it('非法输入返回 null', () => {
    expect(parseRfbBanner(Buffer.alloc(0))).toBeNull()
    expect(parseRfbBanner(Buffer.from('garbage data'))).toBeNull()
    expect(parseRfbBanner(Buffer.from('RFB 003.008\r\n'))).toBeNull()
  })
})

describe('parseSshBanner - SSH 版本横幅', () => {
  it('OpenSSH Linux 横幅推断 linux', () => {
    const fp = parseSshBanner(Buffer.from('SSH-2.0-OpenSSH_8.9p1 Ubuntu-3ubuntu0.1\r\n'))
    expect(fp).not.toBeNull()
    expect(fp!.service).toBe('ssh')
    expect(fp!.version).toBe('2.0')
    expect(fp!.osHint).toBe('linux')
    expect(parseSshBanner(Buffer.from('not a ssh banner'))).toBeNull()
  })
})

describe('parseHttpHeaders - HTTP 响应头', () => {
  it('fnOS Server 头推断 fnos', () => {
    const raw = 'HTTP/1.1 200 OK\r\nServer: fnOS/1.0\r\nContent-Length: 0\r\n\r\n'
    const fp = parseHttpHeaders(Buffer.from(raw), 5666)
    expect(fp).not.toBeNull()
    expect(fp!.service).toBe('http')
    expect(fp!.osHint).toBe('fnos')
    expect(parseHttpHeaders(Buffer.from('garbage data without header terminator'))).toBeNull()
    expect(parseHttpHeaders(Buffer.from('NOTHTTP/9.9 abc\r\n\r\n'))).toBeNull()
  })

  it('5985 端口判定为 WinRM', () => {
    const raw = 'HTTP/1.1 401 Unauthorized\r\nServer: Microsoft-HTTPAPI/2.0\r\n\r\n'
    const fp = parseHttpHeaders(Buffer.from(raw), 5985)
    expect(fp!.service).toBe('winrm')
  })
})

describe('probeFingerprints - 批量指纹探测', () => {
  it('空 openMap 返回空 Map', async () => {
    const result = await probeFingerprints(new Map())
    expect(result.size).toBe(0)
  })
})
