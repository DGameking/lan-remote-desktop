import type { Device, DiscoverySource, OsHint, ProtocolId, ServiceFingerprint } from '../../shared/types'
import { scopedLogger } from '../logger'
import { deviceToRow, getStore, now, rowToDevice } from '../store'
import { detectOs } from './os-detect'

const discoveryLog = scopedLogger('discovery')

export interface DeviceCandidate {
  ip: string
  name?: string
  mac?: string
  ports?: number[]
  /** 该 IP 上已做过服务识别的开放端口；缺省时由 fingerprint 中的 port 推导 */
  detectedPorts?: number[]
  protocols?: ProtocolId[]
  fingerprint?: ServiceFingerprint[]
  /** v1.4: mDNS TXT 白名单字段，用于中置信度系统识别 */
  txt?: Record<string, string>
  source: DiscoverySource
}

const PORT_PROTOCOL: Record<number, ProtocolId> = {
  3389: 'rdp',
  5900: 'vnc',
  21116: 'rustdesk'
}

const SOURCE_PRIORITY: Record<DiscoverySource, number> = {
  manual: 4,
  mdns: 3,
  subnet: 2,
  arp: 1
}

const VALID_PROTOCOLS: ProtocolId[] = ['rdp', 'vnc', 'rustdesk']

export function deviceIdForIp(ip: string): string {
  return `dev-${ip.replace(/\./g, '-')}`
}

/** 兼容 v1.3 的旧接口：仅取系统推测。新逻辑统一在 os-detect.ts，保留此别名供既有调用与测试。 */
export function inferOsHint(ports: number[], name: string, fingerprint: ServiceFingerprint[] = []): OsHint {
  return detectOs({ ports, name, fingerprint }).osHint
}

/**
 * v1.10 修复：扫描完成后按本轮发现结果更新在线状态。
 * 旧实现在扫描"开始前"把所有设备标离线——一旦用户中途停止扫描或扫描失败，
 * 所有设备就永久停在"离线"，即使实际在线。现在只在扫描真正完成汇总后调用，
 * 且只把"本轮未发现的旧设备"标离线；发现的由 aggregateAndPersist 置在线。
 */
export function applyScanOnlineState(discoveredIps: Set<string>): number {
  const store = getStore()
  const timestamp = now()
  let offlineCount = 0
  for (const row of store.listDevices()) {
    if (discoveredIps.has(row.ip)) continue
    if (row.online !== 0) {
      store.upsertDevice({ ...row, online: 0, updatedAt: timestamp })
      offlineCount++
    }
  }
  return offlineCount
}

/** 兼容旧调用的别名：传入空集合表示"本轮无设备"（仅扫描完成时使用）。 */
export function resetOnlineFlags(): void {
  applyScanOnlineState(new Set())
}

/**
 * 按 IP 聚合多来源候选，推导 osHint / 可用协议，并落库去重。
 */
export function aggregateAndPersist(candidates: DeviceCandidate[]): Device[] {
  const byIp = new Map<string, DeviceCandidate>()

  for (const candidate of candidates) {
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(candidate.ip)) continue
    const existing = byIp.get(candidate.ip)
    if (!existing) {
      byIp.set(candidate.ip, {
        ...candidate,
        ports: [...(candidate.ports ?? [])],
        detectedPorts: [...(candidate.detectedPorts ?? [])],
        protocols: [...(candidate.protocols ?? [])],
        fingerprint: [...(candidate.fingerprint ?? [])],
        txt: { ...(candidate.txt ?? {}) }
      })
      continue
    }
    const ports = new Set([...(existing.ports ?? []), ...(candidate.ports ?? [])])
    const detectedPorts = new Set([
      ...(existing.detectedPorts ?? []),
      ...(candidate.detectedPorts ?? [])
    ])
    const protocols = new Set([...(existing.protocols ?? []), ...(candidate.protocols ?? [])])
    const fingerprint = [...(existing.fingerprint ?? []), ...(candidate.fingerprint ?? [])]
    const txt = { ...(existing.txt ?? {}), ...(candidate.txt ?? {}) }
    const preferNew = SOURCE_PRIORITY[candidate.source] > SOURCE_PRIORITY[existing.source]
    byIp.set(candidate.ip, {
      ip: candidate.ip,
      name: existing.name || candidate.name || '',
      mac: existing.mac || candidate.mac || '',
      ports: [...ports],
      detectedPorts: [...detectedPorts],
      protocols: [...protocols],
      fingerprint,
      txt,
      source: preferNew ? candidate.source : existing.source
    })
  }

  const store = getStore()
  const existingRows = new Map(store.listDevices().map((row) => [row.id, row]))
  const devices: Device[] = []

  for (const candidate of byIp.values()) {
    const protocols = new Set<ProtocolId>(candidate.protocols ?? [])
    for (const port of candidate.ports ?? []) {
      const protocol = PORT_PROTOCOL[port]
      if (protocol) protocols.add(protocol)
    }
    const availableProtocols = VALID_PROTOCOLS.filter((protocol) => protocols.has(protocol))
    const syntheticPorts = candidate.ports?.length
      ? candidate.ports
      : availableProtocols.map((protocol) =>
          protocol === 'rdp' ? 3389 : protocol === 'vnc' ? 5900 : 21116
        )
    const hintPorts = syntheticPorts.filter((port) => port === 3389 || port === 5900)

    // 服务识别成功的端口即"已发现端口"：并集候选显式值与指纹命中端口。
    const detectedPorts = new Set<number>(candidate.detectedPorts ?? [])
    for (const fp of candidate.fingerprint ?? []) {
      if (fp.port >= 1 && fp.port <= 65535) detectedPorts.add(fp.port)
    }

    const id = deviceIdForIp(candidate.ip)
    const old = existingRows.get(id)
    const timestamp = now()
    const displayName = candidate.name || old?.name || ''

    // v1.4-B: 用户手动指定的系统优先，扫描不覆盖；否则走分层置信度识别。
    const detected = detectOs({
      ports: hintPorts,
      name: displayName,
      mac: candidate.mac || old?.mac || '',
      fingerprint: candidate.fingerprint ?? [],
      mdnsTxt: candidate.txt
    })
    const manualLocked = old?.osManual === 1
    const device: Device = {
      id,
      name: displayName || candidate.ip,
      ip: candidate.ip,
      mac: candidate.mac || old?.mac || '',
      osHint: manualLocked ? (old!.osHint ?? detected.osHint) : detected.osHint,
      osConfidence: manualLocked ? 'high' : detected.confidence,
      osEvidence: manualLocked
        ? [{ source: 'manual', osHint: old!.osHint, detail: '用户手动指定的系统类型（扫描不再覆盖）' }]
        : detected.evidence,
      osManual: manualLocked,
      // v1.10 P0 修复：扫描重发现的候选必须继承用户元数据，
      // 否则每次扫描都会把收藏/置顶/别名/分组清空（用户配置被静默抹掉）。
      favorite: old?.favorite === 1,
      pinned: old?.pinned === 1,
      alias: old?.alias ?? '',
      group: old?.group ?? '',
      source: candidate.source,
      availableProtocols,
      detectedPorts: [...detectedPorts],
      online: true,
      lastSeenAt: timestamp,
      createdAt: old?.createdAt ?? timestamp,
      updatedAt: timestamp
    }
    store.upsertDevice(deviceToRow(device))
    // v1.4-E: 识别证据回流到诊断日志，便于用户对误判截图反馈后针对性校正规则。
    // IP 保留完整（定位端口所必需）；MAC 不写日志；confidence/evidence 均为判定结论非敏感值。
    if (!manualLocked && detected.evidence.length > 0) {
      discoveryLog.event({
        level: 'INFO',
        event: 'os.detected',
        context: {
          ip: candidate.ip,
          osHint: device.osHint,
          confidence: device.osConfidence,
          evidence: detected.evidence.map((e) => `${e.source}:${e.osHint}`)
        }
      })
    }
    devices.push(device)
  }

  return devices
}

/** 手动添加设备（即使端口未开放也允许保存，便于被控端后续开启服务） */
export function upsertManualDevice(ip: string, name?: string): Device {
  const timestamp = now()
  const id = deviceIdForIp(ip)
  const oldRow = getStore().listDevices().find((row) => row.id === id)
  const old = oldRow ? rowToDevice(oldRow) : undefined
  const device: Device = {
    id,
    name: name?.trim() || old?.name || ip,
    ip,
    mac: old?.mac ?? '',
    // v1.10 P0 修复：手动添加已存在设备不得抹掉识别证据与已发现端口/协议，
    // 也不得清空用户元数据；只更新 name/online/时间戳。
    osHint: old?.osHint ?? 'unknown',
    osConfidence: old?.osConfidence ?? 'none',
    osEvidence: old?.osEvidence ?? [],
    osManual: old?.osManual === true,
    favorite: old?.favorite === true,
    pinned: old?.pinned === true,
    alias: old?.alias ?? '',
    group: old?.group ?? '',
    source: old?.source ?? 'manual',
    availableProtocols: old?.availableProtocols ?? [],
    detectedPorts: old?.detectedPorts ?? [],
    online: true,
    lastSeenAt: timestamp,
    createdAt: old?.createdAt ?? timestamp,
    updatedAt: timestamp
  }
  getStore().upsertDevice(deviceToRow(device))
  return device
}
