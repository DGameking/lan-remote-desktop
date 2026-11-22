import type {
  Device,
  DiscoverySource,
  OsConfidence,
  OsEvidence,
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
  /** v1.4: 置信度；老库缺省 'none' */
  osConfidence: OsConfidence
  /** v1.4: 识别依据 JSON；老库缺省 '[]' */
  osEvidence: string
  /** v1.4: 是否手动指定系统；老库缺省 0 */
  osManual: number
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
  /** v1.5: 外部客户端进程 PID；0/undefined 表示调起失败或使用了协议链接（无 PID） */
  externalPid?: number
  /** v1.5: 会话时长（秒），由 startedAt→endedAt 计算 */
  durationSec?: number
  /** v1.5: 时长不可可靠测量时置 true，UI 应显示"时长不可测"而非 0 */
  durationUnavailable?: boolean
  /** v1.5: 本次连接的目标 IP（本地元数据，设备删除后历史仍可一键重连） */
  ip?: string
}

/**
 * 把存储层读出的会话行规范化为契约语义：
 * - DB 列无值时读出的 0/null 归一为 undefined；
 * - durationUnavailable 兼容 0/1（SQL）与 boolean（JSON）两种落盘形态。
 * 老库缺列时由各 store 的迁移/默认值补齐，本函数保证 UI 拿到的恒为规范值。
 */
export function normalizeSessionRow(row: SessionRow): SessionRow {
  const externalPid =
    typeof row.externalPid === 'number' && Number.isInteger(row.externalPid) && row.externalPid > 0
      ? row.externalPid
      : undefined
  // 0 是 DB 列缺省值，视为"无时长"；真实会话时长恒为正数
  const durationSec =
    typeof row.durationSec === 'number' && Number.isFinite(row.durationSec) && row.durationSec > 0
      ? row.durationSec
      : undefined
  const rawUnavailable = row.durationUnavailable as boolean | number | undefined
  const durationUnavailable = rawUnavailable === true || rawUnavailable === 1
  const ip = typeof row.ip === 'string' && row.ip ? row.ip : undefined
  // 先剔除旧值，再按规范条件写回，避免把 0/1 原样透传给 UI
  const base: SessionRow = { ...row }
  delete base.externalPid
  delete base.durationSec
  delete base.durationUnavailable
  delete base.ip
  return {
    ...base,
    ...(externalPid !== undefined ? { externalPid } : {}),
    ...(durationSec !== undefined ? { durationSec } : {}),
    ...(durationUnavailable ? { durationUnavailable: true } : {}),
    ...(ip !== undefined ? { ip } : {})
  }
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
  /** v1.5-P0-3: 清空连接历史（对应 REQ-009） */
  clearSessions(): void
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
    osConfidence: device.osConfidence ?? 'none',
    osEvidence: JSON.stringify(device.osEvidence ?? []),
    osManual: device.osManual ? 1 : 0,
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
  let osEvidence: OsEvidence[] = []
  try {
    const parsed: unknown = JSON.parse(row.osEvidence || '[]')
    if (Array.isArray(parsed)) {
      osEvidence = parsed.filter(
        (item): item is OsEvidence =>
          !!item &&
          typeof item === 'object' &&
          typeof (item as OsEvidence).source === 'string' &&
          typeof (item as OsEvidence).osHint === 'string' &&
          typeof (item as OsEvidence).detail === 'string'
      )
    }
  } catch {
    osEvidence = []
  }
  const confidence: OsConfidence =
    row.osConfidence === 'high' || row.osConfidence === 'medium' || row.osConfidence === 'low'
      ? row.osConfidence
      : 'none'
  return {
    id: row.id,
    name: row.name,
    ip: row.ip,
    mac: row.mac,
    osHint: row.osHint,
    osConfidence: confidence,
    osEvidence,
    osManual: row.osManual === 1,
    source: row.source,
    availableProtocols: protocols,
    detectedPorts,
    online: row.online === 1,
    lastSeenAt: row.lastSeenAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}
