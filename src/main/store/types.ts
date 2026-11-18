import type {
  Device,
  DiscoverySource,
  OsHint,
  ProtocolId,
  SessionStatus
} from '../../shared/types'

/** 与数据库表一一对应的行类型（列名使用 camelCase，便于直接映射） */
export interface DeviceRow {
  id: string
  name: string
  ip: string
  mac: string
  osHint: OsHint
  source: DiscoverySource
  availableProtocols: string
  detectedPorts: string
  online: number
  lastSeenAt: string
  createdAt: string
  updatedAt: string
}

export interface CredentialRow {
  id: string
  deviceId: string
  protocol: ProtocolId
  username: string
  encryptedPassword: string
  createdAt: string
  updatedAt: string
}

export interface SessionRow {
  id: string
  deviceId: string
  deviceName: string
  protocol: ProtocolId
  status: SessionStatus
  startedAt: string
  endedAt: string
  errorMessage: string
}

/** 存储驱动契约：SQLite 与 JSON 降级实现同一套接口 */
export interface Store {
  mode(): 'sqlite' | 'json'
  listDevices(): DeviceRow[]
  upsertDevice(row: DeviceRow): void
  deleteDevice(id: string): void
  listCredentials(): CredentialRow[]
  setCredential(row: CredentialRow): void
  deleteCredential(id: string): void
  listSessions(): SessionRow[]
  addSession(row: SessionRow): void
  updateSession(row: SessionRow): void
  getSetting(key: string): string | undefined
  setSetting(key: string, value: string): void
}

export function now(): string {
  return new Date().toISOString()
}

export function deviceToRow(device: Device): DeviceRow {
  return {
    id: device.id,
    name: device.name,
    ip: device.ip,
    mac: device.mac,
    osHint: device.osHint,
    source: device.source,
    availableProtocols: JSON.stringify(device.availableProtocols),
    detectedPorts: JSON.stringify(device.detectedPorts ?? []),
    online: device.online ? 1 : 0,
    lastSeenAt: device.lastSeenAt,
    createdAt: device.createdAt,
    updatedAt: device.updatedAt
  }
}

export function rowToDevice(row: DeviceRow): Device {
  let protocols: ProtocolId[] = []
  try {
    const parsed: unknown = JSON.parse(row.availableProtocols)
    if (Array.isArray(parsed)) {
      protocols = parsed.filter(
        (p): p is ProtocolId => p === 'rdp' || p === 'vnc' || p === 'rustdesk'
      )
    }
  } catch {
    protocols = []
  }
  let detectedPorts: number[] = []
  try {
    const parsed: unknown = JSON.parse(row.detectedPorts)
    if (Array.isArray(parsed)) {
      detectedPorts = [
        ...new Set(
          parsed.filter(
            (p): p is number =>
              typeof p === 'number' && Number.isInteger(p) && p >= 1 && p <= 65535
          )
        )
      ]
    }
  } catch {
    detectedPorts = []
  }
  return {
    id: row.id,
    name: row.name,
    ip: row.ip,
    mac: row.mac,
    osHint: row.osHint,
    source: row.source,
    availableProtocols: protocols,
    detectedPorts,
    online: row.online === 1,
    lastSeenAt: row.lastSeenAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}
