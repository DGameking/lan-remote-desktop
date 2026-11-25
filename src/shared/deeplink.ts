/**
 * v1.7-D: 命令行 / 协议链接直连参数解析（纯函数，无 Node / DOM 依赖）。
 *
 * 安全边界：本模块只把外部输入解析成"预填参数"，绝不发起连接、不拼装 shell 命令。
 * 解析结果必须由用户在连接界面再次点击「发起连接」才会调起外部客户端。
 */

import { normalizeRustdeskId } from './rustdesk-id'
import type { DeepLinkRequest, ProtocolId } from './types'

/** 协议白名单：只接受这三种，杜绝 javascript: / file: 等注入 */
const PROTOCOL_IDS: readonly ProtocolId[] = ['rdp', 'vnc', 'rustdesk']

/**
 * 严格 IPv4：四段十进制整数，无前导零歧义（单独的 0 合法），每段 0-255。
 * 拒绝 01.2.3.4 / 1.2.3.4.5 / localhost / IPv6 等一切非规范写法。
 */
const IPV4_RE = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/

function isValidIpv4(value: string): boolean {
  const match = IPV4_RE.exec(value)
  if (!match) return false
  for (let i = 1; i <= 4; i++) {
    if (Number(match[i]) > 255) return false
  }
  return true
}

/** 端口必须是纯十进制数字且在 1-65535 之间；非法返回 undefined，不抛异常 */
function parsePort(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined
  return port
}

/** 协议参数白名单校验，大小写不敏感 */
function parseProtocol(value: string): ProtocolId | undefined {
  const normalized = value.trim().toLowerCase()
  return PROTOCOL_IDS.find((id) => id === normalized)
}

/**
 * 按端口推断协议：3389→rdp，5900-5910→vnc，其余不预设（返回 undefined）。
 * ip 参数保留在签名中用于表达"基于目标推断"的语义，当前规则只依赖端口。
 */
export function inferProtocol(_ip: string, port: number): ProtocolId | undefined {
  if (port === 3389) return 'rdp'
  if (port >= 5900 && port <= 5910) return 'vnc'
  return undefined
}

/** 解析 IP[:端口] 文本；显式协议优先于端口推断 */
function parseTarget(text: string, explicitProtocol?: ProtocolId): DeepLinkRequest | null {
  const value = text.trim()
  if (!value) return null

  // v1.9: RustDesk 会话码（字母数字串）不是 IPv4。显式指定 rustdesk 且
  // 目标不是 IPv4 时，按会话码白名单解析；端口对会话码无意义，直接忽略。
  if (explicitProtocol === 'rustdesk' && !isValidIpv4(value)) {
    const sessionId = normalizeRustdeskId(value)
    if (!sessionId) return null
    return { ip: sessionId, protocol: 'rustdesk', rustdeskId: sessionId }
  }

  let ip = value
  let port: number | undefined
  const colon = value.indexOf(':')
  if (colon >= 0) {
    // 仅允许一个冒号，杜绝 IPv6 / 带认证的写法
    if (value.indexOf(':', colon + 1) >= 0) return null
    ip = value.slice(0, colon).trim()
    port = parsePort(value.slice(colon + 1).trim())
    if (port === undefined) return null
  }

  if (!isValidIpv4(ip)) return null
  const protocol = explicitProtocol ?? (port !== undefined ? inferProtocol(ip, port) : undefined)
  return {
    ip,
    ...(port !== undefined ? { port } : {}),
    ...(protocol !== undefined ? { protocol } : {})
  }
}

/**
 * 解析命令行参数：
 * - `--connect=<ip>[:<port>]` / `--connect <ip>[:<port>]`
 * - `--protocol=rdp|vnc|rustdesk` / `--protocol rdp|vnc|rustdesk`（可出现在任意位置）
 * - Electron 自身参数（如 `--electron-run-after-stdio`、`--no-sandbox`）一律忽略
 *
 * 没有任何 --connect 时返回 null（正常启动，不算错误）；出现 --connect 但参数非法同样返回 null。
 * 任何输入都不抛异常。
 */
export function parseConnectArgv(argv: string[]): DeepLinkRequest | null {
  if (!Array.isArray(argv)) return null

  let target: string | null = null
  let protocol: ProtocolId | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (typeof arg !== 'string') continue

    if (arg === '--connect') {
      const next = argv[i + 1]
      // 缺值或值以 -- 开头（下一个 Electron 参数）都视为非法
      if (typeof next !== 'string' || next.startsWith('--')) return null
      if (target === null) target = next
      i++
      continue
    }
    if (arg.startsWith('--connect=')) {
      if (target === null) target = arg.slice('--connect='.length)
      continue
    }
    if (arg === '--protocol') {
      const next = argv[i + 1]
      if (typeof next !== 'string' || next.startsWith('--')) return null
      const parsed = parseProtocol(next)
      if (!parsed) return null
      protocol = parsed
      i++
      continue
    }
    if (arg.startsWith('--protocol=')) {
      const parsed = parseProtocol(arg.slice('--protocol='.length))
      if (!parsed) return null
      protocol = parsed
    }
    // 其余参数（含 Electron 内部参数）忽略
  }

  if (target === null) return null
  return parseTarget(target, protocol)
}

/**
 * 解析协议链接：`landesk://connect?ip=...&port=...&protocol=...`。
 * - 只接受 protocol === 'landesk:'；javascript: / file: / http: 一律拒绝
 * - hostname + pathname 去斜杠后必须等于 connect（兼容 landesk://connect 与 landesk:///connect）
 * - ip 必填且严格校验；port / protocol 可选，出现即校验，非法返回 null
 * 任何输入都不抛异常。
 */
export function parseDeepLinkUrl(raw: string): DeepLinkRequest | null {
  if (typeof raw !== 'string' || !raw.trim()) return null

  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }

  if (url.protocol !== 'landesk:') return null

  const route = `${url.hostname}${url.pathname}`.replace(/^\/+/, '').replace(/\/+$/, '')
  if (route.toLowerCase() !== 'connect') return null

  const ip = url.searchParams.get('ip')
  // v1.9: rustdesk 会话码可用 id 参数传入；ip 仍兼容（承载会话码或 IPv4）
  const idParam = url.searchParams.get('id')
  const target = (idParam ?? ip ?? '').trim()
  if (!target) return null

  let port: number | undefined
  const portText = url.searchParams.get('port')
  if (portText !== null) {
    port = parsePort(portText.trim())
    if (port === undefined) return null
  }

  let protocol: ProtocolId | undefined
  const protocolText = url.searchParams.get('protocol')
  if (protocolText !== null) {
    const parsed = parseProtocol(protocolText)
    if (!parsed) return null
    protocol = parsed
  }

  // v1.9: 显式 rustdesk 时目标可为会话码（借 parseTarget 的白名单分支）；
  // 其余协议维持严格 IPv4 校验，安全边界不削弱。
  if (protocol === 'rustdesk') {
    const sessionTarget = parseTarget(idParam ?? target, 'rustdesk')
    if (!sessionTarget) return null
    return {
      ...sessionTarget,
      ...(port !== undefined ? { port } : {})
    }
  }

  if (!isValidIpv4(target)) return null
  protocol = protocol ?? (port !== undefined ? inferProtocol(target, port) : undefined)

  return {
    ip: target,
    ...(port !== undefined ? { port } : {}),
    ...(protocol !== undefined ? { protocol } : {})
  }
}
