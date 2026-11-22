import { describe, it, expect } from 'vitest'
import {
  SYSTEM_PROTOCOL_MATRIX,
  getSystemProtocolCapability,
  type OsHint,
  type ProtocolId
} from '../src/shared/types'

/** 任务约定必须覆盖的系统×协议组合 */
const combos: [OsHint, ProtocolId][] = [
  ['windows', 'rdp'],
  ['windows', 'vnc'],
  ['macos', 'vnc'],
  ['macos', 'rustdesk'],
  ['linux', 'vnc'],
  ['linux', 'rdp'],
  ['fnos', 'vnc']
]

describe('v1.4-C SYSTEM_PROTOCOL_MATRIX - 只读契约', () => {
  it('矩阵常量存在且为对象', () => {
    expect(SYSTEM_PROTOCOL_MATRIX).toBeDefined()
    expect(typeof SYSTEM_PROTOCOL_MATRIX).toBe('object')
  })

  it('覆盖约定的 7 个系统×协议组合', () => {
    for (const [os, protocol] of combos) {
      expect(SYSTEM_PROTOCOL_MATRIX[os]?.[protocol]).toBeDefined()
    }
  })
})

describe('v1.4-C getSystemProtocolCapability - 各组合能力分级', () => {
  it('windows/rdp: 剪贴板、文件传输、画面控制全部 native', () => {
    const c = getSystemProtocolCapability('windows', 'rdp')
    expect(c.clipboard.level).toBe('native')
    expect(c.fileTransfer.level).toBe('native')
    expect(c.screenControl.level).toBe('native')
  })

  it('windows/vnc: 剪贴板 client、文件传输 none、画面控制 native', () => {
    const c = getSystemProtocolCapability('windows', 'vnc')
    expect(c.clipboard.level).toBe('client')
    expect(c.fileTransfer.level).toBe('none')
    expect(c.screenControl.level).toBe('native')
  })

  it('macos/vnc: 剪贴板 limited（Apple 私有扩展无法保证）、文件传输 none', () => {
    const c = getSystemProtocolCapability('macos', 'vnc')
    expect(c.clipboard.level).toBe('limited')
    expect(c.fileTransfer.level).toBe('none')
    expect(c.screenControl.level).toBe('native')
    expect(c.clipboard.note).toContain('Apple')
  })

  it('macos/rustdesk: 剪贴板、文件传输、画面控制全部由客户端提供（client）', () => {
    const c = getSystemProtocolCapability('macos', 'rustdesk')
    expect(c.clipboard.level).toBe('client')
    expect(c.fileTransfer.level).toBe('client')
    expect(c.screenControl.level).toBe('native')
  })

  it('linux/vnc: 剪贴板 client、文件传输 none、画面控制 native', () => {
    const c = getSystemProtocolCapability('linux', 'vnc')
    expect(c.clipboard.level).toBe('client')
    expect(c.fileTransfer.level).toBe('none')
    expect(c.screenControl.level).toBe('native')
  })

  it('linux/rdp(xrdp): 剪贴板、文件传输、画面控制全部 native', () => {
    const c = getSystemProtocolCapability('linux', 'rdp')
    expect(c.clipboard.level).toBe('native')
    expect(c.fileTransfer.level).toBe('native')
    expect(c.screenControl.level).toBe('native')
  })

  it('fnos/vnc: 剪贴板 client、文件传输 none、画面控制 native', () => {
    const c = getSystemProtocolCapability('fnos', 'vnc')
    expect(c.clipboard.level).toBe('client')
    expect(c.fileTransfer.level).toBe('none')
    expect(c.screenControl.level).toBe('native')
  })

  it('未知组合走兜底：画面 native、剪贴板 client、文件传输 none', () => {
    const unknown = getSystemProtocolCapability('unknown', 'rdp')
    expect(unknown.clipboard.level).toBe('client')
    expect(unknown.fileTransfer.level).toBe('none')
    expect(unknown.screenControl.level).toBe('native')

    const unlisted = getSystemProtocolCapability('fnos', 'rustdesk')
    expect(unlisted.clipboard.level).toBe('client')
    expect(unlisted.fileTransfer.level).toBe('none')
    expect(unlisted.screenControl.level).toBe('native')
  })
})

describe('v1.4-C 能力说明与前置条件', () => {
  it('每个命中组合的 prerequisite 非空', () => {
    for (const [os, protocol] of combos) {
      const c = getSystemProtocolCapability(os, protocol)
      expect(c.prerequisite.trim().length).toBeGreaterThan(0)
    }
  })

  it('兜底组合的 prerequisite 也非空', () => {
    const c = getSystemProtocolCapability('unknown', 'vnc')
    expect(c.prerequisite.trim().length).toBeGreaterThan(0)
  })

  it('每项能力的 note 均为非空中文说明', () => {
    for (const [os, protocol] of combos) {
      const c = getSystemProtocolCapability(os, protocol)
      for (const key of ['clipboard', 'fileTransfer', 'screenControl'] as const) {
        expect(c[key].note.trim().length).toBeGreaterThan(0)
      }
    }
  })
})
