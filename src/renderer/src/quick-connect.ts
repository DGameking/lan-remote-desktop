import type { ProtocolId } from '../../shared/types'

/** 快速连接目标解析结果 */
export interface ParsedTarget {
  ip: string
  port?: number
  protocolHint?: ProtocolId
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/** 严格校验四段 IPv4，每段必须是 0-255 的十进制整数 */
function isValidIpv4(ip: string): boolean {
  const match = IPV4_RE.exec(ip)
  if (!match) return false
  for (let i = 1; i <= 4; i++) {
    const segment = Number(match[i])
    if (!Number.isInteger(segment) || segment < 0 || segment > 255) return false
  }
  return true
}

/**
 * 解析用户输入的目标地址。
 * 支持纯 IPv4（如 192.168.1.20）与 IP:端口（如 192.168.1.20:5900）。
 * 端口 3389 推断为 rdp，5900-5910 推断为 vnc，其余不给出协议提示。
 * 非法输入返回 null。
 */
export function parseTarget(input: string): ParsedTarget | null {
  if (typeof input !== 'string') return null
  const value = input.trim()
  if (!value) return null

  let ip = value
  let port: number | undefined

  const firstColon = value.indexOf(':')
  if (firstColon >= 0) {
    // 仅允许单个冒号，杜绝 IPv6 等其它格式
    if (value.indexOf(':', firstColon + 1) >= 0) return null
    ip = value.slice(0, firstColon).trim()
    const portText = value.slice(firstColon + 1).trim()
    if (!/^\d+$/.test(portText)) return null
    port = Number(portText)
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  }

  if (!isValidIpv4(ip)) return null

  let protocolHint: ProtocolId | undefined
  if (port !== undefined) {
    if (port === 3389) protocolHint = 'rdp'
    else if (port >= 5900 && port <= 5910) protocolHint = 'vnc'
  }

  return { ip, port, protocolHint }
}

/** 协议对应的默认端口；rustdesk 无固定端口，返回 undefined */
export function defaultPortFor(protocol: ProtocolId): number | undefined {
  switch (protocol) {
    case 'rdp':
      return 3389
    case 'vnc':
      return 5900
    case 'rustdesk':
      return undefined
  }
}
