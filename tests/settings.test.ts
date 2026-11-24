import { describe, it, expect } from 'vitest'
import { DEFAULT_SETTINGS } from '../src/shared/types'
import {
  normalizeTelemetryConsent,
  coerceSettingValue,
  BOOLEAN_SETTING_KEYS,
  NUMERIC_SETTING_KEYS
} from '../src/main/store/index'
import type { AppSettings } from '../src/shared/types'

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

/**
 * v1.7 回归：KV 底层只存字符串，读回必须按默认值类型还原。
 * 元测试按 DEFAULT_SETTINGS 的实际类型自动拦截「加字段却忘了加还原规则」，
 * 避免 'false' 被 el-switch 当成真、'60' 被当成字符串这类界面/逻辑错位。
 */
describe('设置类型还原（字符串 ↔ boolean/number）', () => {
  const keys = Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[]

  it('所有布尔默认值字段都已登记布尔还原规则', () => {
    const missing = keys.filter(
      (key) => typeof DEFAULT_SETTINGS[key] === 'boolean' && !BOOLEAN_SETTING_KEYS.has(key)
    )
    expect(missing).toEqual([])
  })

  it('所有数值默认值字段都已登记数值还原规则', () => {
    const missing = keys.filter(
      (key) => typeof DEFAULT_SETTINGS[key] === 'number' && !NUMERIC_SETTING_KEYS.has(key)
    )
    expect(missing).toEqual([])
  })

  it('v1.7 开关：字符串 false 还原为 false，不是 truthy 字符串', () => {
    expect(coerceSettingValue('onlineRefreshEnabled', 'false', false)).toBe(false)
    expect(coerceSettingValue('onlineRefreshEnabled', 'true', false)).toBe(true)
  })

  it('v1.7 间隔：字符串数字还原为 number，脏数据回落到默认值', () => {
    expect(coerceSettingValue('onlineRefreshIntervalSec', '60', 60)).toBe(60)
    expect(coerceSettingValue('autoScanIntervalMin', '0', 0)).toBe(0)
    expect(coerceSettingValue('autoScanIntervalMin', 'garbage', 0)).toBe(0)
    expect(coerceSettingValue('rdpWidth', '2560', 0)).toBe(2560)
  })

  it('字符串字段原样返回，不被误转', () => {
    expect(coerceSettingValue('vncViewerPath', 'C:\\Tools\\vnc.exe', '')).toBe('C:\\Tools\\vnc.exe')
    expect(coerceSettingValue('rdpScreenMode', 'fullscreen', 'adaptive')).toBe('fullscreen')
  })
})
