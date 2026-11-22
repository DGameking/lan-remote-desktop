import { describe, it, expect } from 'vitest'
import { shouldReuseSavedCredential } from '../src/main/session/credential-policy'
import { pickBestProbe } from '../src/main/discovery/precheck'
import { isRdpPasswordHex, normalizeRdpPasswordHex } from '../src/main/store/dpapi'
import { validateConnectRequest } from '../src/main/ipc/validators'

describe('凭据回填策略 - 绝不把旧账号密码注入新用户名', () => {
  const base = { hasSavedPassword: true, savedUsername: 'alice' }

  it('本次已输入密码：以本次为准，不复用已存凭据', () => {
    expect(shouldReuseSavedCredential({ ...base, inputUsername: 'alice', inputPassword: 'newpwd' })).toBe(false)
  })

  it('没有已存密码：无从回填', () => {
    expect(
      shouldReuseSavedCredential({ inputUsername: 'alice', hasSavedPassword: false, savedUsername: 'alice' })
    ).toBe(false)
  })

  it('未指定用户名：复用同一设备同一账号的已存凭据', () => {
    expect(shouldReuseSavedCredential({ ...base })).toBe(true)
  })

  it('用户名与已存账号完全一致：复用', () => {
    expect(shouldReuseSavedCredential({ ...base, inputUsername: 'alice' })).toBe(true)
  })

  it('改了用户名但密码留空：拒绝复用（防串号）', () => {
    expect(shouldReuseSavedCredential({ ...base, inputUsername: 'bob' })).toBe(false)
  })

  it('用户名大小写不一致严格视为不同账号', () => {
    expect(shouldReuseSavedCredential({ ...base, inputUsername: 'Alice' })).toBe(false)
  })
})

describe('pickBestProbe - 取可达且延迟最小者', () => {
  it('空数组返回安全默认值', () => {
    expect(pickBestProbe([])).toEqual({ ip: '', port: 0, reachable: false, latencyMs: 0 })
  })

  it('全不可达时返回最后一个结果（保留最新一次诊断信息）', () => {
    const a = { ip: '10.0.0.1', port: 3389, reachable: false, latencyMs: 100 }
    const b = { ip: '10.0.0.2', port: 3389, reachable: false, latencyMs: 200 }
    expect(pickBestProbe([a, b])).toBe(b)
  })

  it('有可达结果时忽略不可达项，取延迟最小的可达项', () => {
    const slow = { ip: '10.0.0.1', port: 3389, reachable: true, latencyMs: 80 }
    const fast = { ip: '10.0.0.2', port: 3389, reachable: true, latencyMs: 5 }
    const dead = { ip: '10.0.0.3', port: 3389, reachable: false, latencyMs: 0 }
    expect(pickBestProbe([slow, dead, fast])).toBe(fast)
  })

  it('skipped 结果原样保留', () => {
    const skipped = { ip: '10.0.0.9', port: 0, reachable: false, latencyMs: 0, skipped: true }
    expect(pickBestProbe([skipped])).toBe(skipped)
  })
})

describe('DPAPI hex - 归一化与大小写不敏感校验', () => {
  it('normalizeRdpPasswordHex 输出全小写', () => {
    expect(normalizeRdpPasswordHex('01000000D08C9DDF')).toBe('01000000d08c9ddf')
  })

  it('全大写 / 混合大小写前缀均被接受', () => {
    expect(isRdpPasswordHex('01000000D08C9DDF')).toBe(true)
    expect(isRdpPasswordHex('01000000D08c9DdF')).toBe(true)
  })

  it('奇数长度 / 非 hex 字符 / base64 一律拒绝', () => {
    expect(isRdpPasswordHex('01000000d08c9ddf0')).toBe(false)
    expect(isRdpPasswordHex('01000000d08c9ddfZZ')).toBe(false)
    expect(isRdpPasswordHex('v0w=')).toBe(false)
    expect(isRdpPasswordHex('')).toBe(false)
  })
})

describe('validateConnectRequest - precheck 元数据透传', () => {
  const baseRequest = { deviceId: 'dev-10-0-0-9', ip: '10.0.0.9', protocol: 'rdp' }

  it('合法 precheck 逐字段透传', () => {
    const out = validateConnectRequest({
      ...baseRequest,
      precheck: { ip: '10.0.0.9', port: 3389, reachable: true, latencyMs: 12, skipped: false }
    })
    expect(out.precheck).toEqual({ ip: '10.0.0.9', port: 3389, reachable: true, latencyMs: 12 })
  })

  it('skipped=true 的 precheck 保留 skipped 标记', () => {
    const out = validateConnectRequest({
      ...baseRequest,
      protocol: 'rustdesk',
      precheck: { ip: '10.0.0.9', port: 0, reachable: false, latencyMs: 0, skipped: true }
    })
    expect(out.precheck?.skipped).toBe(true)
  })

  it('非法 precheck 被丢弃但不阻断连接', () => {
    const out = validateConnectRequest({
      ...baseRequest,
      precheck: { ip: 'not-an-ip', port: -1, reachable: 'yes', latencyMs: NaN }
    })
    expect(out.precheck).toBeUndefined()
    expect(out.ip).toBe('10.0.0.9')
  })

  it('缺省 precheck 保持 undefined', () => {
    expect(validateConnectRequest(baseRequest).precheck).toBeUndefined()
  })
})
