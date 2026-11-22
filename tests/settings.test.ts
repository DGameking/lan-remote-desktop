import { describe, it, expect } from 'vitest'
import { DEFAULT_SETTINGS } from '../src/shared/types'
import { normalizeTelemetryConsent } from '../src/main/store/index'

/**
 * 零遥测口径回归：v1.3.0 起 telemetryConsent 恒为 false。
 * 设置页开关已 disabled，但历史库里可能存过 true；
 * 主进程在读取（getSettings）与写回（saveSettings）时都调用本函数归一化，
 * 避免 UI 显示「开」却不可切换、与「保持关闭」文案冲突。
 */
describe('normalizeTelemetryConsent 零遥测归一化', () => {
  it('默认设置下 telemetryConsent 为 false', () => {
    expect(normalizeTelemetryConsent({ ...DEFAULT_SETTINGS }).telemetryConsent).toBe(false)
  })

  it('历史数据里 telemetryConsent=true 会被强制归一化为 false', () => {
    const legacy = { ...DEFAULT_SETTINGS, telemetryConsent: true }
    expect(normalizeTelemetryConsent(legacy).telemetryConsent).toBe(false)
  })

  it('不修改其它设置字段（合规、共享能力、路径等都原样保留）', () => {
    const input = {
      ...DEFAULT_SETTINGS,
      telemetryConsent: true,
      complianceAccepted: true,
      clipboardSharing: false,
      driveRedirection: true,
      vncViewerPath: 'C:\\Tools\\vnc.exe',
      defaultShareName: '共享'
    }
    const result = normalizeTelemetryConsent(input)
    expect(result.telemetryConsent).toBe(false)
    expect(result.complianceAccepted).toBe(true)
    expect(result.clipboardSharing).toBe(false)
    expect(result.driveRedirection).toBe(true)
    expect(result.vncViewerPath).toBe('C:\\Tools\\vnc.exe')
    expect(result.defaultShareName).toBe('共享')
  })

  it('不修改入参对象（纯函数，无副作用）', () => {
    const input = { ...DEFAULT_SETTINGS, telemetryConsent: true }
    normalizeTelemetryConsent(input)
    expect(input.telemetryConsent).toBe(true)
  })

  it('DEFAULT_SETTINGS 本身保持 telemetryConsent=false，作为全局单一事实来源', () => {
    expect(DEFAULT_SETTINGS.telemetryConsent).toBe(false)
  })
})
