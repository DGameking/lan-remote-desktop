import type { OsConfidence, OsEvidence, OsHint, ServiceFingerprint } from '../../shared/types'

/**
 * v1.4-B：系统识别分层置信度引擎（纯函数，无副作用、可单测）。
 *
 * 信号分层（强 → 弱）：
 *  - high   协议握手层/横幅强信号：RFB 003.889、RDP X.224 CC、SSH 发行版 banner、fnOS Server 头
 *  - medium 半结构化线索：MAC OUI(Apple)、mDNS TXT 机型字段、AFP 服务
 *  - low    启发式线索：默认端口、TTL、设备名关键字
 *  - none   无任何信号
 *
 * 设计原则：
 *  1. 不确定时宁可给 low/none + 证据，也不硬报 high；用户可据此判断可信度并手动指定。
 *  2. 证据 detail 不含 MAC 全值等敏感信息（OUI 只声明"前 3 字节匹配"）。
 *  3. 标准 RFB 003.003/003.007/003.008 无法确定系统，绝不臆测为 macOS。
 *  4. 非 Apple 厂商 OUI（华为/小米等）多为手机/路由器，不硬判系统，避免误报。
 */

const WEIGHT: Record<OsConfidence, number> = { high: 3, medium: 2, low: 1, none: 0 }

interface OsSignal extends OsEvidence {
  confidence: Exclude<OsConfidence, 'none'>
}

export interface DetectOsInput {
  ports?: number[]
  name?: string
  fingerprint?: ServiceFingerprint[]
  mac?: string
  ttl?: number
  mdnsTxt?: Record<string, string>
  /** 用户手动指定的系统（若给定则直接作为 high 信号，但仍保留其它证据供诊断） */
  manualHint?: OsHint
}

export interface OsDetection {
  osHint: OsHint
  confidence: OsConfidence
  evidence: OsEvidence[]
}

/** 常见 Apple OUI（MAC 前 3 字节，小写无分隔符）。仅用于给出 macOS 中置信线索。 */
const APPLE_OUIS = new Set([
  '001b63', '001ec2', '002500', '00281c', '002c54', '003ee1', '004e8f', '0056cd',
  '00a040', '00c0ee', '00d48a', '040cce', '0454ef', '080007', '109add', '14206c',
  '18af61', '1caba7', '24abfb', '28cfe9', '340804', '3c22fb', '403004', '5855ca',
  '5c95ae', '600308', '64b9e8', '68967b', '70cd60', '74e2f5', '7831c1', '7c6d62',
  '80e650', '84fcfe', '88665a', '8c2daa', '985aeb', 'a45e60', 'a85b76', 'ac87a3',
  'b065bd', 'bc52b7', 'c0847d', 'c82a14', 'cc08e0', 'd0036b', 'd4619d', 'd83062',
  'e0accb', 'e49ace', 'ecade0', 'f01898', 'f40fcc', 'f81ef7', 'fc253f'
])

/** 提取 MAC 前 3 字节（归一化：去掉分隔符、转小写）。 */
export function macOui(mac?: string): string | null {
  if (!mac) return null
  const clean = mac.trim().replace(/[^0-9a-fA-F]/g, '').toLowerCase()
  return clean.length >= 6 ? clean.slice(0, 6) : null
}

function collectSignals(input: DetectOsInput): OsSignal[] {
  const signals: OsSignal[] = []
  const ports = input.ports ?? []
  const name = (input.name ?? '').toLowerCase()
  const fps = input.fingerprint ?? []
  const txt = input.mdnsTxt ?? {}

  // 用户手动指定：最高优先级
  if (input.manualHint && input.manualHint !== 'unknown') {
    signals.push({
      source: 'manual',
      osHint: input.manualHint,
      confidence: 'high',
      detail: '用户手动指定的系统类型（优先于自动识别）'
    })
  }

  // L1 强信号：协议横幅 / 握手层
  for (const fp of fps) {
    if (fp.service === 'vnc' && fp.version === '003.889') {
      signals.push({
        source: 'rfb', osHint: 'macos', confidence: 'high',
        detail: 'RFB 003.889 是 Apple 屏幕共享的私有版本标识'
      })
    } else if (fp.service === 'rdp' && fp.osHint === 'windows') {
      signals.push({
        source: 'rdp', osHint: 'windows', confidence: 'high',
        detail: 'RDP X.224 连接确认（Windows 远程桌面强信号）'
      })
    } else if (fp.service === 'ssh' && fp.osHint === 'linux') {
      signals.push({
        source: 'ssh', osHint: 'linux', confidence: 'high',
        detail: 'SSH 横幅含 Linux 发行版标识'
      })
    } else if (fp.service === 'http' && fp.osHint === 'fnos') {
      signals.push({
        source: 'http', osHint: 'fnos', confidence: 'high',
        detail: 'HTTP Server 响应头标识为飞牛OS'
      })
    }
  }

  // L2 中信号：结构化元数据
  const oui = macOui(input.mac)
  if (oui && APPLE_OUIS.has(oui)) {
    signals.push({
      source: 'mac-oui', osHint: 'macos', confidence: 'medium',
      detail: 'MAC OUI 前 3 字节匹配 Apple 厂商'
    })
  }
  if (txt.model || txt.osxvers || txt.Mac) {
    signals.push({
      source: 'mdns-txt', osHint: 'macos', confidence: 'medium',
      detail: 'mDNS TXT 含 Apple 机型字段（model/osxvers/Mac）'
    })
  }
  if (fps.some((fp) => fp.service === 'afp')) {
    signals.push({
      source: 'port', osHint: 'macos', confidence: 'medium',
      detail: '发现 AFP 文件共享服务（548），常见于 macOS'
    })
  }

  // L3 弱信号：启发式线索
  if (ports.includes(3389)) {
    signals.push({
      source: 'port', osHint: 'windows', confidence: 'low',
      detail: '开放 3389 端口（RDP 默认端口，可被修改，也可能为 xrdp）'
    })
  }
  if (ports.includes(22)) {
    signals.push({
      source: 'port', osHint: 'linux', confidence: 'low',
      detail: '开放 22 端口（SSH，类 Unix 常见，也可能为其它设备）'
    })
  }
  if (input.ttl === 128) {
    signals.push({
      source: 'ttl', osHint: 'windows', confidence: 'low',
      detail: 'TTL=128 倾向 Windows（弱参考，可被改写）'
    })
  }
  if (/(fnos|飞牛)/.test(name)) {
    signals.push({ source: 'name', osHint: 'fnos', confidence: 'low', detail: '设备名含飞牛/fnOS 关键字' })
  } else if (/\bnas\b/.test(name)) {
    signals.push({ source: 'name', osHint: 'fnos', confidence: 'low', detail: '设备名含 NAS 关键字（仅提示，未确认品牌）' })
  }
  if (/(macbook|imac|mac\s?os|\bmac\b)/.test(name)) {
    signals.push({ source: 'name', osHint: 'macos', confidence: 'low', detail: '设备名含 Mac/macOS 关键字' })
  }
  if (/(ubuntu|debian|centos|fedora|redhat|archlinux|linux)/.test(name)) {
    signals.push({ source: 'name', osHint: 'linux', confidence: 'low', detail: '设备名含 Linux 发行版关键字' })
  }
  if (/^(desktop-|win-)/.test(name)) {
    signals.push({ source: 'name', osHint: 'windows', confidence: 'low', detail: '设备名符合 Windows 默认命名（DESKTOP-/WIN-）' })
  }

  return signals
}

/**
 * 分层识别主入口：输出 osHint + 置信度 + 证据列表。
 * 置信度取最高权重信号的层级；最终系统取最高权重且非 unknown 的信号。
 */
export function detectOs(input: DetectOsInput): OsDetection {
  const sorted = collectSignals(input).sort((a, b) => WEIGHT[b.confidence] - WEIGHT[a.confidence])

  // 同源同系统的重复证据只保留一条（最高层已在最前）
  const dedup: OsSignal[] = []
  const seen = new Set<string>()
  for (const signal of sorted) {
    const key = `${signal.source}:${signal.osHint}`
    if (seen.has(key)) continue
    seen.add(key)
    dedup.push(signal)
  }

  const winner = dedup.find((signal) => signal.osHint !== 'unknown')
  const evidence: OsEvidence[] = dedup.slice(0, 12).map(({ source, osHint, detail }) => ({
    source, osHint, detail
  }))
  return {
    osHint: winner?.osHint ?? 'unknown',
    confidence: winner?.confidence ?? 'none',
    evidence
  }
}

/**
 * 兼容 v1.3 的 3 参接口：只取系统推测，供既有调用与测试使用。
 * 新代码应优先使用 detectOs() 以获得置信度与证据。
 */
export function inferOsHint(
  ports: number[],
  name: string,
  fingerprint: ServiceFingerprint[] = []
): OsHint {
  return detectOs({ ports, name, fingerprint }).osHint
}
