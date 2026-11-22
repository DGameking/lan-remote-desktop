import { describe, it, expect } from 'vitest'
import { buildRdpContent } from '../src/main/protocols/rdp'
import { isRdpPasswordHex, normalizeRdpPasswordHex } from '../src/main/store/dpapi'

// 合法的 DPAPI blob hex 样例：以 ConvertFrom-SecureString 的固定头开头，后接足够长度的密文体
const VALID_HEX =
  '01000000d08c9ddf0115d1118c7a00c04fc297eb' +
  '0100000000000000000000000000000000000000000000000000000000000000'

describe('buildRdpContent - RDP 账密免密直连', () => {
  const base = { ip: '192.168.1.20', clipboard: true, driveRedirection: false }

  it('传入合法 passwordHex 时写入账号/域与凭据，并关闭凭据提示', () => {
    const content = buildRdpContent({
      ...base,
      username: 'alice',
      domain: 'WORKGROUP',
      passwordHex: VALID_HEX
    })
    expect(content).toContain('username:s:alice')
    expect(content).toContain('domain:s:WORKGROUP')
    expect(content).toContain(`password 51:b:${VALID_HEX}`)
    expect(content).toContain('prompt for credentials:i:0')
    expect(content).toContain('promptcredentialonce:i:1')
    expect(content).not.toContain('prompt for credentials:i:1')
    // 安全开关保持系统默认，不为跳过弹窗而降级
    expect(content).toContain('enablecredsspsupport:i:1')
    expect(content).toContain('authentication level:i:2')
  })

  it('未传 passwordHex 时保持手输路径，不写任何账号密码字段', () => {
    const content = buildRdpContent({ ...base, username: 'alice' })
    expect(content).toContain('prompt for credentials:i:1')
    expect(content).not.toContain('password 51')
    expect(content).not.toContain('username:s:')
    expect(content).not.toContain('promptcredentialonce:i:1')
  })

  it('非法 passwordHex 被忽略，回落手输且不写入凭据字段', () => {
    const content = buildRdpContent({ ...base, username: 'alice', passwordHex: 'not-a-hex' })
    expect(content).toContain('prompt for credentials:i:1')
    expect(content).not.toContain('password 51')
    expect(content).not.toContain('username:s:')
  })

  it('免密与手输两种路径均保留剪贴板/磁盘重定向开关', () => {
    const auto = buildRdpContent({
      ...base,
      clipboard: true,
      driveRedirection: true,
      username: 'alice',
      passwordHex: VALID_HEX
    })
    expect(auto).toContain('redirectclipboard:i:1')
    expect(auto).toContain('drivestoredirect:s:*')
    expect(auto).toContain('redirectdrives:i:1')

    const manual = buildRdpContent({ ...base, clipboard: false, driveRedirection: false })
    expect(manual).toContain('redirectclipboard:i:0')
    expect(manual).toContain('drivestoredirect:s:')
    expect(manual).toContain('redirectdrives:i:0')
  })
})

describe('isRdpPasswordHex - DPAPI blob hex 校验', () => {
  it('接受合法 DPAPI blob hex', () => {
    expect(isRdpPasswordHex(VALID_HEX)).toBe(true)
  })

  it('大小写不敏感：大写/混合大小写的 DPAPI blob hex 也被接受（PowerShell 可能输出大写）', () => {
    expect(isRdpPasswordHex('01000000D08C9DDF')).toBe(true) // 全大写前缀
    expect(isRdpPasswordHex(VALID_HEX.toUpperCase())).toBe(true) // 整串大写
    expect(isRdpPasswordHex('01000000D08c9DdF')).toBe(true) // 混合大小写
  })

  it('拒绝 base64、空串、奇数长度、非 hex 与错误前缀', () => {
    expect(isRdpPasswordHex('')).toBe(false)
    expect(isRdpPasswordHex('01000000d08c9ddf0')).toBe(false) // 奇数长度
    expect(isRdpPasswordHex('01000000d08c9ddfZZ')).toBe(false) // 非 hex
    expect(isRdpPasswordHex('abcdefabcdef')).toBe(false) // 错误前缀
    expect(isRdpPasswordHex('v0w=')).toBe(false) // base64
  })
})

describe('normalizeRdpPasswordHex - hex 大小写归一化', () => {
  it('把大写 hex 归一化为全小写', () => {
    expect(normalizeRdpPasswordHex('01000000D08C9DDF')).toBe('01000000d08c9ddf')
    expect(normalizeRdpPasswordHex(VALID_HEX.toUpperCase())).toBe(VALID_HEX)
  })

  it('幂等：对已为小写的输入保持不变', () => {
    expect(normalizeRdpPasswordHex(VALID_HEX)).toBe(VALID_HEX)
  })

  it('归一化后的结果仍通过 DPAPI blob 校验', () => {
    const normalized = normalizeRdpPasswordHex(VALID_HEX.toUpperCase())
    expect(isRdpPasswordHex(normalized)).toBe(true)
    expect(normalized).toBe(normalized.toLowerCase())
  })
})
