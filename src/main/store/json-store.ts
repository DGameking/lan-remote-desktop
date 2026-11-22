import fs from 'node:fs'
import path from 'node:path'
import { logger } from '../logger'
import { normalizeSessionRow, type CredentialRow, type DeviceRow, type SessionRow, type Store } from './types'

interface JsonData {
  devices: DeviceRow[]
  credentials: CredentialRow[]
  sessions: SessionRow[]
  settings: Record<string, string>
}

function emptyData(): JsonData {
  return { devices: [], credentials: [], sessions: [], settings: {} }
}

/**
 * SQLite/WASM 不可用时的降级实现：JSON 文件持久化到 userData/landesk-data.json。
 * 数据结构与 SQL 表一一对应，保证主流程仍可用。
 */
export class JsonStore implements Store {
  private data: JsonData

  private constructor(private readonly file: string, data: JsonData) {
    this.data = data
  }

  static create(userData: string): JsonStore {
    const file = path.join(userData, 'landesk-data.json')
    let data = emptyData()
    try {
      if (fs.existsSync(file)) {
        const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (parsed && typeof parsed === 'object') {
          const raw = parsed as Partial<JsonData>
          data = {
            // 老库升级：历史设备行缺 v1.4 字段时补默认值，避免 undefined 落库。
            devices: Array.isArray(raw.devices)
              ? raw.devices.map((row) => ({
                  ...row,
                  detectedPorts:
                    typeof row.detectedPorts === 'string' ? row.detectedPorts : '[]',
                  osConfidence:
                    row.osConfidence === 'high' || row.osConfidence === 'medium' || row.osConfidence === 'low'
                      ? row.osConfidence
                      : 'none',
                  osEvidence: typeof row.osEvidence === 'string' ? row.osEvidence : '[]',
                  osManual: row.osManual === 1 ? 1 : 0,
                  // v1.6: 老数据缺元数据字段时补默认值，已有值（含 0）原样保留
                  favorite: row.favorite === 1 ? 1 : 0,
                  pinned: row.pinned === 1 ? 1 : 0,
                  alias: typeof row.alias === 'string' ? row.alias : '',
                  group: typeof row.group === 'string' ? row.group : ''
                }))
              : [],
            credentials: Array.isArray(raw.credentials) ? raw.credentials : [],
            // 老数据缺 v1.5 会话运行期字段时补默认值，避免 undefined 落库
            sessions: Array.isArray(raw.sessions) ? raw.sessions.map(normalizeSessionRow) : [],
            settings: raw.settings && typeof raw.settings === 'object' ? raw.settings : {}
          }
        }
      }
    } catch (error) {
      logger.warn('降级 JSON 存储读取失败，将使用空数据', error)
    }
    const store = new JsonStore(file, data)
    store.persist()
    logger.info('JSON 降级存储初始化成功', { file })
    return store
  }

  mode(): 'sqlite' | 'json' {
    return 'json'
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8')
  }

  listDevices(): DeviceRow[] {
    // 置顶优先 → 收藏优先 → 最近在线时间倒序（与 SQL 版排序保持一致）
    return [...this.data.devices].sort((a, b) => {
      if (b.pinned !== a.pinned) return b.pinned - a.pinned
      if (b.favorite !== a.favorite) return b.favorite - a.favorite
      return b.lastSeenAt.localeCompare(a.lastSeenAt)
    })
  }

  upsertDevice(row: DeviceRow): void {
    const index = this.data.devices.findIndex((item) => item.id === row.id)
    if (index >= 0) this.data.devices[index] = row
    else this.data.devices.push(row)
    this.persist()
  }

  deleteDevice(id: string): void {
    this.data.devices = this.data.devices.filter((item) => item.id !== id)
    this.data.credentials = this.data.credentials.filter((item) => item.deviceId !== id)
    this.persist()
  }

  updateDeviceMeta(
    id: string,
    patch: Partial<Pick<DeviceRow, 'favorite' | 'pinned' | 'alias' | 'group'>>
  ): DeviceRow | undefined {
    const row = this.data.devices.find((item) => item.id === id)
    if (!row) return undefined
    if (patch.favorite !== undefined) row.favorite = patch.favorite
    if (patch.pinned !== undefined) row.pinned = patch.pinned
    if (patch.alias !== undefined) row.alias = patch.alias
    if (patch.group !== undefined) row.group = patch.group
    this.persist()
    return row
  }

  listCredentials(): CredentialRow[] {
    return [...this.data.credentials].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  setCredential(row: CredentialRow): void {
    const index = this.data.credentials.findIndex(
      (item) => item.deviceId === row.deviceId && item.protocol === row.protocol
    )
    if (index >= 0) this.data.credentials[index] = row
    else this.data.credentials.push(row)
    this.persist()
  }

  deleteCredential(id: string): void {
    this.data.credentials = this.data.credentials.filter((item) => item.id !== id)
    this.persist()
  }

  listSessions(): SessionRow[] {
    return [...this.data.sessions]
      .map(normalizeSessionRow)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, 200)
  }

  addSession(row: SessionRow): void {
    this.data.sessions.push(row)
    if (this.data.sessions.length > 1000) {
      this.data.sessions = this.data.sessions.slice(-1000)
    }
    this.persist()
  }

  updateSession(row: SessionRow): void {
    const index = this.data.sessions.findIndex((item) => item.id === row.id)
    if (index >= 0) this.data.sessions[index] = row
    this.persist()
  }

  clearSessions(): void {
    this.data.sessions = []
    this.persist()
  }

  setSessionNote(id: string, note: string): boolean {
    const row = this.data.sessions.find((item) => item.id === id)
    if (!row) return false
    row.note = note
    this.persist()
    return true
  }

  getSetting(key: string): string | undefined {
    return this.data.settings[key]
  }

  setSetting(key: string, value: string): void {
    this.data.settings[key] = value
    this.persist()
  }

  listSettings(): Record<string, string> {
    return { ...this.data.settings }
  }
}
