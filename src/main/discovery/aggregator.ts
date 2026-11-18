import type { Device, DiscoverySource, OsHint, ProtocolId } from '../../shared/types'
import { deviceToRow, getStore, now } from '../store'

export interface DeviceCandidate {
  ip: string
  name?: string
  mac?: string
  ports?: number[]
  protocols?: ProtocolId[]
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

/** 端口 3389 判定 Windows；5900 暂标 unknown；名称关键字用于补充平台推测 */
export function inferOsHint(ports: number[], name: string): OsHint {
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
        protocols: [...(candidate.protocols ?? [])]
      })
      continue
    }
    const ports = new Set([...(existing.ports ?? []), ...(candidate.ports ?? [])])
    const protocols = new Set([...(existing.protocols ?? []), ...(candidate.protocols ?? [])])
    const preferNew = SOURCE_PRIORITY[candidate.source] > SOURCE_PRIORITY[existing.source]
    byIp.set(candidate.ip, {
      ip: candidate.ip,
      name: existing.name || candidate.name || '',
      mac: existing.mac || candidate.mac || '',
      ports: [...ports],
      protocols: [...protocols],
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

    const id = deviceIdForIp(candidate.ip)
    const old = existingRows.get(id)
    const timestamp = now()
    const device: Device = {
      id,
      name: candidate.name || old?.name || candidate.ip,
      ip: candidate.ip,
      mac: candidate.mac || old?.mac || '',
      osHint: inferOsHint(hintPorts, candidate.name || old?.name || ''),
      source: candidate.source,
      availableProtocols,
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
    online: true,
    lastSeenAt: timestamp,
    createdAt: old?.createdAt ?? timestamp,
    updatedAt: timestamp
  }
  getStore().upsertDevice(deviceToRow(device))
  return device
}
