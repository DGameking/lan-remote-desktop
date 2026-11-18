import type { Device, DiscoverySource, OsHint, ProtocolId, ServiceFingerprint } from '../../shared/types'
import { deviceToRow, getStore, now } from '../store'

export interface DeviceCandidate {
  ip: string
  name?: string
  mac?: string
  ports?: number[]
  /** 该 IP 上已做过服务识别的开放端口；缺省时由 fingerprint 中的 port 推导 */
  detectedPorts?: number[]
  protocols?: ProtocolId[]
  fingerprint?: ServiceFingerprint[]
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

/** 端口 3389 判定 Windows；5900 暂标 unknown；名称关键字用于补充平台推测。
 *  第 3 参为服务指纹，优先于端口/名称规则；省略时保持旧行为不变。 */
export function inferOsHint(ports: number[], name: string, fingerprint: ServiceFingerprint[] = []): OsHint {
  for (const fp of fingerprint) {
    if (fp.service === 'vnc' && fp.version === '003.889') return 'macos'
    if (fp.service === 'ssh' && fp.osHint === 'linux') return 'linux'
    if (fp.service === 'http' && fp.osHint === 'fnos') return 'fnos'
    if (fp.service === 'rdp' && fp.osHint === 'windows') return 'windows'
    if (fp.osHint && fp.osHint !== 'unknown') return fp.osHint
  }
  if (ports.includes(3389)) return 'windows'
  const lower = name.toLowerCase()
  if (/(fnos|飞牛|\bnas\b)/.test(lower)) return 'fnos'
  if (/(macos|macbook|imac|mac)/.test(lower)) return 'macos'
  if (/(linux|ubuntu|debian|centos|fedora|arch)/.test(lower)) return 'linux'
  return 'unknown'
}

/** 扫描开始前把历史设备标记为离线，扫描中重新发现的会置回在线 */
export function resetOnlineFlags(): void {
  const store = getStore()
  for (const row of store.listDevices()) {
    if (row.online !== 0) {
      store.upsertDevice({ ...row, online: 0, updatedAt: now() })
    }
  }
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
        fingerprint: [...(candidate.fingerprint ?? [])]
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
    const preferNew = SOURCE_PRIORITY[candidate.source] > SOURCE_PRIORITY[existing.source]
    byIp.set(candidate.ip, {
      ip: candidate.ip,
      name: existing.name || candidate.name || '',
      mac: existing.mac || candidate.mac || '',
      ports: [...ports],
      detectedPorts: [...detectedPorts],
      protocols: [...protocols],
      fingerprint,
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
    const device: Device = {
      id,
      name: candidate.name || old?.name || candidate.ip,
      ip: candidate.ip,
      mac: candidate.mac || old?.mac || '',
      osHint: inferOsHint(hintPorts, candidate.name || old?.name || '', candidate.fingerprint ?? []),
      source: candidate.source,
      availableProtocols,
      detectedPorts: [...detectedPorts],
      online: true,
      lastSeenAt: timestamp,
      createdAt: old?.createdAt ?? timestamp,
      updatedAt: timestamp
    }
    store.upsertDevice(deviceToRow(device))
    devices.push(device)
  }

  return devices
}

/** 手动添加设备（即使端口未开放也允许保存，便于被控端后续开启服务） */
export function upsertManualDevice(ip: string, name?: string): Device {
  const timestamp = now()
  const id = deviceIdForIp(ip)
  const old = getStore().listDevices().find((row) => row.id === id)
  const device: Device = {
    id,
    name: name?.trim() || ip,
    ip,
    mac: old?.mac ?? '',
    osHint: 'unknown',
    source: 'manual',
    availableProtocols: [],
    detectedPorts: [],
    online: true,
    lastSeenAt: timestamp,
    createdAt: old?.createdAt ?? timestamp,
    updatedAt: timestamp
  }
  getStore().upsertDevice(deviceToRow(device))
  return device
}
