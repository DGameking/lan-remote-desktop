import { describe, it, expect } from 'vitest'
import { buildRdpContent } from '../src/main/protocols/rdp'
import { buildUncPath } from '../src/main/protocols/fileshare'
import {
  CAPABILITY_MATRIX,
  DEFAULT_SETTINGS,
  PROTOCOL_PRECHECK_PORT
} from '../src/shared/types'
import {
  validateFileTransferTarget,
  validateSettingsPatch,
  validateConnectRequest
} from '../src/main/ipc/validators'

describe('buildRdpContent - RDP 会话参数生成', () => {
  const base = { ip: '192.168.1.20', clipboard: true, driveRedirection: false }

  it('剪贴板/磁盘重定向按开关生成，且绝不出现密码字段', () => {
    const on = buildRdpContent({ ...base, clipboard: true, driveRedirection: true })
    expect(on).toContain('redirectclipboard:i:1')
    expect(on).toContain('drivestoredirect:s:*')
    expect(on).toContain('redirectdrives:i:1')

    const off = buildRdpContent({ ...base, clipboard: false, driveRedirection: false })
    expect(off).toContain('redirectclipboard:i:0')
    expect(off).toContain('drivestoredirect:s:')
    expect(off).toContain('redirectdrives:i:0')

    // 安全红线：任何情况下 .rdp 内容都不得出现 password / cmdkey / /pass
    for (const content of [on, off]) {
      expect(content.toLowerCase()).not.toMatch(/password|cmdkey|\/pass/)
    }
  })

  it('写入目标地址与自定义端口，包含连接优化参数', () => {
    const content = buildRdpContent({ ip: '10.0.0.7', port: 3390, clipboard: true, driveRedirection: false })
    expect(content).toContain('full address:s:10.0.0.7:3390')
    expect(content).toContain('bandwidthautodetect:i:1')
    expect(content).toContain('connection type:i:6')
    expect(content).toContain('prompt for credentials:i:1')
  })

  it('默认端口缺省为 3389', () => {
    expect(buildRdpContent(base)).toContain('full address:s:192.168.1.20:3389')
  })
})

describe('buildUncPath - SMB 共享路径生成', () => {
  it('有共享名与无共享名两种路径', () => {
    expect(buildUncPath('192.168.1.20', 'shared')).toBe('\\\\192.168.1.20\\shared')
    expect(buildUncPath('192.168.1.20', '')).toBe('\\\\192.168.1.20')
  })
})

describe('CAPABILITY_MATRIX - 共享能力矩阵', () => {
  it('RDP 剪贴板与文件传输均为通道原生', () => {
    expect(CAPABILITY_MATRIX.rdp.clipboard).toMatchObject({ supported: true, source: 'channel' })
    expect(CAPABILITY_MATRIX.rdp.fileTransfer).toMatchObject({ supported: true, source: 'channel' })
  })
  it('VNC 剪贴板靠客户端，文件传输不支持', () => {
    expect(CAPABILITY_MATRIX.vnc.clipboard.source).toBe('client')
    expect(CAPABILITY_MATRIX.vnc.fileTransfer).toMatchObject({ supported: false, source: 'unsupported' })
  })
  it('RustDesk 两项均由客户端提供', () => {
    expect(CAPABILITY_MATRIX.rustdesk.clipboard.source).toBe('client')
    expect(CAPABILITY_MATRIX.rustdesk.fileTransfer).toMatchObject({ supported: true, source: 'client' })
  })
  it('预检端口映射：rustdesk 跳过，rdp/vnc 有端口', () => {
    expect(PROTOCOL_PRECHECK_PORT.rdp).toBe(3389)
    expect(PROTOCOL_PRECHECK_PORT.vnc).toBe(5900)
    expect(PROTOCOL_PRECHECK_PORT.rustdesk).toBe(0)
  })
})

describe('DEFAULT_SETTINGS - 共享默认值', () => {
  it('剪贴板默认开启，磁盘重定向默认关闭', () => {
    expect(DEFAULT_SETTINGS.clipboardSharing).toBe(true)
    expect(DEFAULT_SETTINGS.driveRedirection).toBe(false)
    expect(DEFAULT_SETTINGS.defaultShareName).toBe('')
  })
})

describe('validateFileTransferTarget - 文件传输目标校验', () => {
  it('合法 IP 与安全共享名', () => {
    const t = validateFileTransferTarget({ ip: '192.168.1.20', share: '共享文件夹', hint: 'fnos' })
    expect(t.ip).toBe('192.168.1.20')
    expect(t.share).toBe('共享文件夹')
    expect(t.hint).toBe('fnos')
  })
  it('非法 IP / 路径逃逸字符被拒绝', () => {
    expect(() => validateFileTransferTarget({ ip: 'bad', share: '' })).toThrow(/IP/)
    expect(() => validateFileTransferTarget({ ip: '1.2.3.4', share: 'a\\b' })).toThrow(/非法/)
    expect(() => validateFileTransferTarget({ ip: '1.2.3.4', share: '..' })).toThrow(/不合法/)
  })
  it('非法 hint 降级为 unknown', () => {
    expect(validateFileTransferTarget({ ip: '1.2.3.4', share: '', hint: 'hacker' }).hint).toBe('unknown')
  })
})

describe('validateSettingsPatch - 共享设置校验', () => {
  it('保留共享布尔开关与合法共享名', () => {
    const patch = validateSettingsPatch({
      clipboardSharing: false,
      driveRedirection: true,
      defaultShareName: 'my_share-1'
    })
    expect(patch.clipboardSharing).toBe(false)
    expect(patch.driveRedirection).toBe(true)
    expect(patch.defaultShareName).toBe('my_share-1')
  })
  it('共享名含路径分隔符被拒绝', () => {
    expect(() => validateSettingsPatch({ defaultShareName: 'a/b' })).toThrow(/非法/)
  })
})

describe('validateConnectRequest - 共享开关透传', () => {
  it('布尔开关被保留，非布尔被忽略', () => {
    const req = validateConnectRequest({
      ip: '10.0.0.5',
      protocol: 'rdp',
      clipboardSharing: false,
      driveRedirection: true
    })
    expect(req.clipboardSharing).toBe(false)
    expect(req.driveRedirection).toBe(true)

    const req2 = validateConnectRequest({ ip: '10.0.0.5', protocol: 'rdp', clipboardSharing: 'yes' })
    expect(req2.clipboardSharing).toBeUndefined()
  })
})
