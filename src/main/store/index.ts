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
  'telemetryConsent'
])

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
  return result
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const merged: AppSettings = { ...getSettings(), ...patch }
  for (const [key, value] of Object.entries(merged)) {
    getStore().setSetting(key, String(value))
  }
  return merged
}
