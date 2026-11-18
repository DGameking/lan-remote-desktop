import Bonjour from 'bonjour-service'
import type { ProtocolId } from '../../shared/types'

export interface MdnsRecord {
  name: string
  ip: string
  port: number
  protocols: ProtocolId[]
  source: 'mdns'
}

interface BonjourServiceLike {
  name?: string
  host?: string
  port?: number
  addresses?: string[]
}

interface BonjourBrowserLike {
  stop(): void
}

interface BonjourLike {
  find(
    options: { type: string },
    callback: (service: BonjourServiceLike) => void
  ): BonjourBrowserLike
  destroy(): void
}

const IPV4_PATTERN = /^\d{1,3}(\.\d{1,3}){3}$/

/**
 * 通过 mDNS 监听 _rfb._tcp / _rdp._tcp 补充设备名与协议信息。
 * 监听窗口结束后立刻销毁 bonjour 实例，不驻留后台。
 */
export async function browseMdns(
  timeoutMs = 2500,
  onFound?: (record: MdnsRecord) => void
): Promise<MdnsRecord[]> {
  const bonjour = new Bonjour() as unknown as BonjourLike
  const records = new Map<string, MdnsRecord>()
  const browsers: BonjourBrowserLike[] = []

  const types: Array<{ type: string; protocol: ProtocolId }> = [
    { type: 'rfb', protocol: 'vnc' },
    { type: 'rdp', protocol: 'rdp' }
  ]

  try {
    for (const entry of types) {
      const browser = bonjour.find({ type: entry.type }, (service) => {
        const ip = service.addresses?.find((address) => IPV4_PATTERN.test(address)) ?? service.host
        if (!ip || !IPV4_PATTERN.test(ip)) return
        const existing = records.get(ip)
        if (existing) {
          if (!existing.protocols.includes(entry.protocol)) existing.protocols.push(entry.protocol)
          if (!existing.name && service.name) existing.name = service.name
          return
        }
        const record: MdnsRecord = {
          name: service.name ?? '',
          ip,
          port: service.port ?? (entry.protocol === 'rdp' ? 3389 : 5900),
          protocols: [entry.protocol],
          source: 'mdns'
        }
        records.set(ip, record)
        onFound?.(record)
      })
      browsers.push(browser)
    }
    await new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
  } finally {
    for (const browser of browsers) {
      try {
        browser.stop()
      } catch {
        // 忽略停止失败
      }
    }
    try {
      bonjour.destroy()
    } catch {
      // 忽略销毁失败
    }
  }

  return [...records.values()]
}
