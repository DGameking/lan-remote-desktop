import type { ProtocolAvailability, ProtocolId } from '../../shared/types'
import { RdpAdapter } from './rdp'
import type { ProtocolAdapter } from './base'
import { RustDeskAdapter } from './rustdesk'
import { VncAdapter } from './vnc'

const adapters = new Map<ProtocolId, ProtocolAdapter>([
  ['rdp', new RdpAdapter()],
  ['vnc', new VncAdapter()],
  ['rustdesk', new RustDeskAdapter()]
])

export function getAdapter(id: ProtocolId): ProtocolAdapter {
  const adapter = adapters.get(id)
  if (!adapter) throw new Error(`不支持的协议：${id}`)
  return adapter
}

export function isProtocolId(value: unknown): value is ProtocolId {
  return value === 'rdp' || value === 'vnc' || value === 'rustdesk'
}

export async function getAvailability(): Promise<ProtocolAvailability[]> {
  return Promise.all([...adapters.values()].map((adapter) => adapter.isAvailable()))
}
