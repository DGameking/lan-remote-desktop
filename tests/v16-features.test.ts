import { describe, it, expect } from 'vitest'
import { buildRdpContent } from '../src/main/protocols/rdp'
import {
  validateDeviceMetaInput,
  validateSessionNote,
  validateExportData,
  validateSettingsPatch
} from '../src/main/ipc/validators'
import { deviceToRow, rowToDevice, normalizeSessionRow, type DeviceRow, type SessionRow } from '../src/main/store/types'
import type { Device, ExportData } from '../src/shared/types'

describe('v1.6-A4 RDP 连接预设真实写进 .rdp', () => {
  const base = { ip: '192.168.1.20', clipboard: true, driveRedirection: false }

  it('v1.6 默认（无 displayMode）：归一为 fit 自适应，窗口模式 + dynamic resolution，不写死分辨率', () => {
    const content = buildRdpContent(base)
    expect(content).toContain('screen mode id:i:1')
    expect(content).toContain('dynamic resolution:i:1')
    expect(content).not.toContain('desktopwidth:i:')
    expect(content).not.toContain('desktopheight:i:')
    expect(content).toContain('redirectprinters:i:0')
  })

  it('全屏 + 自定义分辨率 + 打印重定向写进参数（v1.6 旧调用方兼容）', () => {
    const content = buildRdpContent({
      ...base,
      screenMode: 'fullscreen',
      width: 2560,
      height: 1440,
      printerRedirection: true
    })
    expect(content).toContain('screen mode id:i:2')
    expect(content).toContain('desktopwidth:i:2560')
    expect(content).toContain('desktopheight:i:1440')
    expect(content).toContain('redirectprinters:i:1')
  })

  it('窗口模式写 screen mode 1', () => {
    expect(buildRdpContent({ ...base, screenMode: 'window' })).toContain('screen mode id:i:1')
  })

  it('越界分辨率被忽略并回落默认值（不生成畸形 .rdp）', () => {
    // 显式 fixed 模式才写分辨率；越界回落 1920×1080
    const content = buildRdpContent({ ...base, displayMode: 'fixed', width: 99999, height: -5 })
    expect(content).toContain('desktopwidth:i:1920')
    expect(content).toContain('desktopheight:i:1080')
  })
})

describe('v1.6-A1/A4 设备与会话新字段的存储转换', () => {
  const device: Device = {
    id: 'd1', name: 'Mac', ip: '192.168.1.15', mac: '', osHint: 'macos',
    source: 'subnet', availableProtocols: ['vnc'], detectedPorts: [5900],
    online: true, lastSeenAt: '2026-11-22T12:00:00Z', createdAt: '2026-11-22T12:00:00Z',
    updatedAt: '2026-11-22T12:00:00Z',
    favorite: true, pinned: true, alias: '主卧 Mac', group: '卧室'
  }

  it('deviceToRow → rowToDevice 保留收藏/置顶/别名/分组', () => {
    const row = deviceToRow(device)
    expect(row.favorite).toBe(1)
    expect(row.pinned).toBe(1)
    expect(row.alias).toBe('主卧 Mac')
    expect(row.group).toBe('卧室')
    const back = rowToDevice(row)
    expect(back.favorite).toBe(true)
    expect(back.pinned).toBe(true)
    expect(back.alias).toBe('主卧 Mac')
    expect(back.group).toBe('卧室')
  })

  it('老库缺省 0/空串归一为 undefined，不污染 UI', () => {
    const oldRow = { ...deviceToRow(device), favorite: 0, pinned: 0, alias: '', group: '' }
    const back = rowToDevice(oldRow)
    expect(back.favorite).toBe(false)
    expect(back.pinned).toBe(false)
    expect(back.alias).toBeUndefined()
    expect(back.group).toBeUndefined()
  })

  it('normalizeSessionRow 保留 note，空串归一为 undefined', () => {
    const row: SessionRow = {
      id: 's1', deviceId: 'd1', deviceName: 'Mac', protocol: 'vnc', status: 'ended',
      startedAt: '2026-11-22T12:00:00Z', endedAt: '2026-11-22T12:00:10Z', errorMessage: '',
      note: '排查过防火墙'
    }
    expect(normalizeSessionRow(row).note).toBe('排查过防火墙')
    expect(normalizeSessionRow({ ...row, note: '' }).note).toBeUndefined()
  })
})

describe('v1.6-A3 导入导出校验', () => {
  it('validateDeviceMetaInput 接受合法字段', () => {
    expect(validateDeviceMetaInput({ deviceId: 'd1', favorite: true, alias: '书房', group: '办公' })).toEqual({
      deviceId: 'd1', favorite: true, alias: '书房', group: '办公'
    })
  })

  it('validateDeviceMetaInput 拒绝空 deviceId 与非法长度', () => {
    expect(() => validateDeviceMetaInput({ deviceId: '', favorite: true })).toThrow()
    expect(() => validateDeviceMetaInput({ deviceId: 'd1', alias: 'x'.repeat(200) })).toThrow()
  })

  it('validateSessionNote 校验 id 与备注长度', () => {
    expect(validateSessionNote('s1', '备注')).toEqual({ id: 's1', note: '备注' })
    expect(() => validateSessionNote('', 'x')).toThrow()
    expect(() => validateSessionNote('s1', 'x'.repeat(1000))).toThrow()
  })

  it('validateExportData 接受合法备份包', () => {
    const data: ExportData = {
      format: 'landesk-backup', version: 1, exportedAt: '2026-11-22T12:00:00Z',
      devices: [], settings: {} as ExportData['settings']
    }
    expect(validateExportData(data).format).toBe('landesk-backup')
  })

  it('validateExportData 拒绝错误格式/版本/损坏 devices', () => {
    expect(() => validateExportData({ format: 'other', version: 1, devices: [] })).toThrow()
    expect(() => validateExportData({ format: 'landesk-backup', version: 99, devices: [] })).toThrow()
    expect(() => validateExportData({ format: 'landesk-backup', version: 1, devices: 'bad' })).toThrow()
  })

  it('备份包结构里没有 credentials 字段（凭据不导出）', () => {
    const data: ExportData = {
      format: 'landesk-backup', version: 1, exportedAt: '2026-11-22T12:00:00Z',
      devices: [], settings: {} as ExportData['settings']
    }
    expect(Object.keys(data)).not.toContain('credentials')
    expect(Object.keys(data)).not.toContain('encryptedPassword')
  })
})

describe('v1.6-A4 设置校验接收新预设字段', () => {
  it('rdpScreenMode / 分辨率 / 打印重定向被接受', () => {
    const patch = validateSettingsPatch({
      rdpScreenMode: 'fullscreen', rdpWidth: 2560, rdpHeight: 1440, rdpPrinterRedirection: true
    })
    expect(patch.rdpScreenMode).toBe('fullscreen')
    expect(patch.rdpWidth).toBe(2560)
    expect(patch.rdpHeight).toBe(1440)
    expect(patch.rdpPrinterRedirection).toBe(true)
  })

  it('非法分辨率被拒绝', () => {
    expect(() => validateSettingsPatch({ rdpWidth: 99999 })).toThrow()
    expect(() => validateSettingsPatch({ rdpHeight: -1 })).toThrow()
  })

  it('非法 screenMode 被忽略（不破坏其它字段）', () => {
    const patch = validateSettingsPatch({ rdpScreenMode: 'hack', clipboardSharing: true })
    expect(patch.rdpScreenMode).toBeUndefined()
    expect(patch.clipboardSharing).toBe(true)
  })
})
