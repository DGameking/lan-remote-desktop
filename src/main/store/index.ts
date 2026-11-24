import { app } from 'electron'
import { DEFAULT_SETTINGS, type AppSettings } from '../../shared/types'
import { logger } from '../logger'
import { JsonStore } from './json-store'
import { SqlStore } from './sql-store'
import type { Store } from './types'

export * from './types'

let instance: Store | null = null

/** 初始化存储：优先 sql.js WASM，失败时降级 JSON 文件 */
export async function initStore(): Promise<Store> {
  if (instance) return instance
  const userData = app.getPath('userData')
  try {
    instance = await SqlStore.create(userData)
  } catch (error) {
    logger.error('SQLite/WASM 初始化失败，降级为 JSON 文件存储', error)
    instance = JsonStore.create(userData)
  }
  return instance
}

export function getStore(): Store {
  if (!instance) throw new Error('存储尚未初始化')
  return instance
}

/**
 * 所有以布尔值存储、但底层 KV 只能存字符串的设置键。
 * 新增布尔设置项时必须同步加入，否则 getSettings() 会把 'false' 原样读回，
 * UI 受控组件（el-switch）把非空字符串判为真，显示与真实状态相反。
 * tests/settings.test.ts 有元测试按 DEFAULT_SETTINGS 的类型自动拦截遗漏。
 */
export const BOOLEAN_SETTING_KEYS = new Set<keyof AppSettings>([
  'useCmdkey',
  'complianceAccepted',
  'telemetryConsent',
  'clipboardSharing',
  'driveRedirection',
  'rdpPrinterRedirection',
  'onlineRefreshEnabled'
])

/**
 * 数值型设置键。KV 底层只能存字符串，读回时必须转回 number，
 * 否则 el-input-number 收到 '60' 这类字符串、调度器的 Number() 兜底掩盖真实脏数据。
 * v1.6 的 rdpWidth/rdpHeight 与 v1.7 的三个新字段都在此列。
 */
export const NUMERIC_SETTING_KEYS = new Set<keyof AppSettings>([
  'rdpWidth',
  'rdpHeight',
  'onlineRefreshIntervalSec',
  'autoScanIntervalMin'
])

/**
 * 设置从 KV 存储读回时的类型还原。
 * 布尔键按 'true' 字符串还原；数值键转回有限数字，脏数据回落到默认值；其余原样返回。
 */
export function coerceSettingValue(
  key: keyof AppSettings,
  raw: string,
  fallback: unknown
): unknown {
  if (BOOLEAN_SETTING_KEYS.has(key)) return raw === 'true'
  if (NUMERIC_SETTING_KEYS.has(key)) {
    const value = Number(raw)
    return Number.isFinite(value) ? value : fallback
  }
  return raw
}

/**
 * 零遥测归一化（纯函数，便于回归测试）：当前版本 telemetryConsent 恒为 false。
 * 该字段仅为未来版本预留、无任何实际效果；历史库里若曾被保存为 true，
 * 读取与写回时都必须强制归一化，否则 UI 会显示「开」却不可切换，
 * 与「保持关闭」文案及文档「默认且恒为 false」的承诺冲突。
 */
export function normalizeTelemetryConsent(settings: AppSettings): AppSettings {
  return { ...settings, telemetryConsent: false }
}

export function getSettings(): AppSettings {
  const store = getStore()
  const result: AppSettings = { ...DEFAULT_SETTINGS }
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[]) {
    const raw = store.getSetting(key)
    if (raw === undefined) continue
    ;(result as unknown as Record<string, unknown>)[key] = coerceSettingValue(
      key,
      raw,
      (result as unknown as Record<string, unknown>)[key]
    )
  }
  return normalizeTelemetryConsent(result)
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  // 同上：即便调用方显式传入 true（或历史数据回流），也不允许持久化该值。
  const merged: AppSettings = normalizeTelemetryConsent({ ...getSettings(), ...patch })
  for (const [key, value] of Object.entries(merged)) {
    getStore().setSetting(key, String(value))
  }
  return merged
}
