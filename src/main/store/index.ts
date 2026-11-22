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

const BOOLEAN_KEYS = new Set<keyof AppSettings>([
  'useCmdkey',
  'complianceAccepted',
  'telemetryConsent',
  'clipboardSharing',
  'driveRedirection',
  'rdpPrinterRedirection'
])

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
    if (BOOLEAN_KEYS.has(key)) {
      ;(result as unknown as Record<string, unknown>)[key] = raw === 'true'
    } else {
      ;(result as unknown as Record<string, unknown>)[key] = raw
    }
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
