import Bonjour from 'bonjour-service'
import type { DetectedServiceId, ProtocolId, ServiceFingerprint } from '../../shared/types'

/** 单条 mDNS 服务类型 → 服务/端口/连接协议的映射 */
export interface MdnsServiceType {
  readonly type: string
  readonly protocol?: 'tcp' | 'udp'
  readonly service: DetectedServiceId
  readonly defaultPort: number
  /** 仅 rfb→vnc、rdp→rdp 填写；避免把指纹服务类型污染进 MdnsRecord.protocols 的连接协议枚举 */
  readonly connectProtocol?: ProtocolId
}

/**
 * 需要监听的 mDNS 服务类型表（纯常量，运行时冻结只读）。
 * 只读发现：仅补充设备名、端口、服务指纹与平台线索，不发起任何连接或网络外发。
 */
const SERVICE_TYPES: MdnsServiceType[] = [
  // _rfb._tcp：macOS 屏幕共享与通用 VNC，默认 5900
  { type: 'rfb', service: 'vnc', defaultPort: 5900, connectProtocol: 'vnc' },
  // _rdp._tcp：仅为兼容个别第三方/手工注册而保留。
  // 注意：Windows 原生远程桌面默认【不】通过 mDNS 广播 RDP，实际局域网环境基本收不到；
  // RDP 识别的主力是 3389 端口的存活探测 + X.224 握手层指纹，而非本表。
  { type: 'rdp', service: 'rdp', defaultPort: 3389, connectProtocol: 'rdp' },
  { type: 'smb', service: 'smb', defaultPort: 445 },
  { type: 'ssh', service: 'ssh', defaultPort: 22 },
  { type: 'sftp-ssh', service: 'ssh', defaultPort: 22 },
  { type: 'afpovertcp', service: 'afp', defaultPort: 548 },
  // _device-info._tcp：只携带 TXT 的 model/osxvers 机型信息，不承载可连接端口。
  // defaultPort=0，ingest 时禁止据此生成端口（不进入 MdnsRecord.ports / detectedPorts）。
  { type: 'device-info', service: 'unknown', defaultPort: 0 },
  // _net-assistant._udp：Apple Remote Desktop（ARD），默认 UDP 3283。
  // 已核实 bonjour-service 1.4.4 的 BrowserConfig 支持 protocol:'udp'，
  // 且 browser.js 构造查询时使用 opts.protocol，故此处可安全监听。
  { type: 'net-assistant', protocol: 'udp', service: 'unknown', defaultPort: 3283 }
]

export const MDNS_SERVICE_TYPES: readonly MdnsServiceType[] = Object.freeze(SERVICE_TYPES)

/** TXT 记录白名单：仅保留有助于设备名/平台识别的键，其余一律丢弃 */
const TXT_ALLOWLIST = [
  'model', 'osxvers', 'Mac', 'manufacturer', 'modelName', 'server', 'vendor', 'os'
] as const
const TXT_MAX_LENGTH = 256

/**
 * 解析 mDNS TXT 记录：统一转字符串、截断到 256 字符、只保留白名单键。
 * 纯函数，无副作用。
 */
export function parseMdnsTxt(
  raw: Record<string, string | Buffer | undefined> | undefined
): Record<string, string> {
  if (!raw) return {}
  const result: Record<string, string> = {}
  for (const key of TXT_ALLOWLIST) {
    const value = raw[key]
    if (value == null) continue
    let text: string
    if (typeof value === 'string') text = value
    else if (Buffer.isBuffer(value)) text = value.toString('utf8')
    else text = String(value)
    result[key] = text.length > TXT_MAX_LENGTH ? text.slice(0, TXT_MAX_LENGTH) : text
  }
  return result
}

/**
 * 由单条 mDNS 服务推断服务指纹。纯函数，可单测。
 * 说明：vnc→macos 属弱信号（macOS 屏幕共享广播 rfb，但部分 Linux VNC 也广播），
 * 因此置于返回数组末尾；manager 汇总时再把 mDNS 指纹追加到 L3 指纹之后，
 * 由 inferOsHint「首个命中即返回」保证 L3 的 003.889 等更精确判定优先、不被覆盖。
 */
export function inferMdnsFingerprint(input: {
  service: DetectedServiceId
  port: number
  name: string
  txt: Record<string, string>
}): ServiceFingerprint[] {
  const { service, port, name, txt } = input
  const result: ServiceFingerprint[] = []
  const lower = name.toLowerCase()

  // 1) 平台关键字/机型补充信号：port=0（aggregator 以 fp.port>=1 过滤，不会并入 detectedPorts）。
  //    置于数组前部，优先于泛化的 vnc→macos 弱信号。
  if (txt.model || txt.osxvers || /(mac|macbook|imac)/.test(lower)) {
    result.push({ port: 0, service: 'http', osHint: 'macos', raw: 'mdns:device-info' })
  }
  // 飞牛OS 没有稳定公开的专属 mDNS 服务类型，只靠设备名关键字识别，不编造类型名。
  if (/(fnos|飞牛|nas)/.test(lower)) {
    result.push({ port: 0, service: 'http', osHint: 'fnos' })
  }

  // 2) 由服务类型直接推断的主指纹；vnc 弱信号放最后。
  if (service === 'ssh') {
    result.push({ port: 22, service: 'ssh', osHint: 'linux' })
  } else if (service === 'smb') {
    result.push({ port: 445, service: 'smb' }) // Windows/NAS 都可能，不推断 OS
  } else if (service === 'afp') {
    result.push({ port: 548, service: 'afp', osHint: 'macos' })
  } else if (service === 'vnc' && port === 5900) {
    result.push({ port: 5900, service: 'vnc', osHint: 'macos', raw: 'mdns:rfb' })
  }

  return result
}

export interface MdnsRecord {
  name: string
  ip: string
  port: number
  protocols: ProtocolId[]
  source: 'mdns'
  /** 该 IP 上 mDNS 发现的真实服务端口（去重，不含 0）；向后兼容新增 */
  ports?: number[]
  /** 由 mDNS 服务类型/TXT 推断的服务指纹；向后兼容新增 */
  fingerprint?: ServiceFingerprint[]
  /** 白名单过滤后的 TXT 记录；向后兼容新增 */
  txt?: Record<string, string>
}

interface BonjourServiceLike {
  name?: string
  host?: string
  port?: number
  addresses?: string[]
  txt?: Record<string, string | Buffer | undefined>
}

interface BonjourBrowserLike {
  stop(): void
}

interface BonjourLike {
  find(
    options: { type: string; protocol?: 'tcp' | 'udp' },
    callback: (service: BonjourServiceLike) => void
  ): BonjourBrowserLike
  destroy(): void
}

const IPV4_PATTERN = /^\d{1,3}(\.\d{1,3}){3}$/

function normalizePort(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535
    ? value
    : undefined
}

/**
 * 通过 mDNS 监听多种原生服务类型，补充设备名、端口、服务指纹与平台线索。
 * 监听窗口结束后立刻销毁 bonjour 实例，不驻留后台、不发起任何连接或网络外发。
 */
export async function browseMdns(
  timeoutMs = 2500,
  onFound?: (record: MdnsRecord) => void
): Promise<MdnsRecord[]> {
  const bonjour = new Bonjour() as unknown as BonjourLike
  const records = new Map<string, MdnsRecord>()
  const browsers: BonjourBrowserLike[] = []

  const ingest = (entry: MdnsServiceType, service: BonjourServiceLike): void => {
    const ip = service.addresses?.find((address) => IPV4_PATTERN.test(address)) ?? service.host
    if (!ip || !IPV4_PATTERN.test(ip)) return

    const instanceName = service.name ?? ''
    const txt = parseMdnsTxt(service.txt)
    // device-info 等 defaultPort=0 的类型不生成端口：即便 SRV 带 port 也忽略。
    const effectivePort = entry.defaultPort >= 1
      ? (normalizePort(service.port) ?? entry.defaultPort)
      : 0
    const fingerprints = inferMdnsFingerprint({
      service: entry.service,
      port: effectivePort,
      name: instanceName,
      txt
    })

    const existing = records.get(ip)
    if (existing) {
      if (!existing.name && instanceName) existing.name = instanceName
      if (entry.connectProtocol && !existing.protocols.includes(entry.connectProtocol)) {
        existing.protocols.push(entry.connectProtocol)
      }
      existing.ports = [
        ...new Set([...(existing.ports ?? []), ...(effectivePort >= 1 ? [effectivePort] : [])])
      ]
      if (effectivePort >= 1 && existing.port < 1) existing.port = effectivePort
      existing.fingerprint = [...(existing.fingerprint ?? []), ...fingerprints]
      existing.txt = { ...(existing.txt ?? {}), ...txt }
      return
    }

    const record: MdnsRecord = {
      name: instanceName,
      ip,
      port: effectivePort,
      protocols: entry.connectProtocol ? [entry.connectProtocol] : [],
      ports: effectivePort >= 1 ? [effectivePort] : [],
      fingerprint: [...fingerprints],
      txt: { ...txt },
      source: 'mdns'
    }
    records.set(ip, record)
    onFound?.(record)
  }

  try {
    for (const entry of MDNS_SERVICE_TYPES) {
      try {
        const options = entry.protocol
          ? { type: entry.type, protocol: entry.protocol }
          : { type: entry.type }
        const browser = bonjour.find(options, (service) => {
          // 单个服务解析失败不能让整个扫描崩掉
          try {
            ingest(entry, service)
          } catch {
            // 忽略该服务的解析异常
          }
        })
        browsers.push(browser)
      } catch {
        // 单个服务类型的浏览器创建失败（如某环境不支持 udp）→ 跳过，不阻断其它类型
      }
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
