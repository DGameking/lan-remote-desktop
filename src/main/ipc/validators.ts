import path from 'node:path'
import type {
  AppSettings,
  CredentialInput,
  Device,
  DiscoverySource,
  IpcResponse,
  LogLevel,
  LogQuery,
  OsHint,
  PrecheckResult,
  ProtocolId,
  ServerLinkTarget,
  WakeTarget
} from '../../shared/types'
import { parseMac } from '../discovery/wol'
import { isProtocolId } from '../protocols/registry'

const OS_HINTS: OsHint[] = ['windows', 'macos', 'linux', 'fnos', 'unknown']
const SOURCES: DiscoverySource[] = ['subnet', 'mdns', 'arp', 'manual']
const FORBIDDEN_PATH_CHARS = /[;&|`$<>!]/ // 杜绝 shell 元字符（虽然一律用参数数组调起）

export function ok<T>(data: T, message = 'success'): IpcResponse<T> {
  return { code: 0, message, data }
}

export function fail(message: string, code = 1): IpcResponse<never> {
  return { code, message, data: null }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

export function isValidIp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const parts = value.split('.')
  if (parts.length !== 4) return false
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false
    const num = Number(part)
    return num >= 0 && num <= 255
  })
}

/** 校验外部可执行文件路径：必须绝对、.exe、无 shell 元字符、位于本机允许根目录 */
export function validateExecutablePath(value: unknown): string {
  const input = asString(value).trim()
  if (!input) return ''
  if (!path.isAbsolute(input)) throw new Error('可执行文件路径必须是绝对路径')
  if (path.extname(input).toLowerCase() !== '.exe') throw new Error('可执行文件必须是 .exe 文件')
  if (FORBIDDEN_PATH_CHARS.test(input)) throw new Error('路径包含非法字符')
  const resolved = path.resolve(input).toLowerCase()
  const roots = [
    process.env.SystemRoot,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA,
    process.env.APPDATA,
    process.env.USERPROFILE,
    path.parse(process.cwd()).root
  ].filter((root): root is string => !!root)
  const allowed = roots.some((root) => resolved.startsWith(path.resolve(root).toLowerCase() + path.sep))
  if (!allowed) throw new Error('路径不在允许的目录范围内（Program Files / 用户目录 / 系统盘）')
  return resolved
}

export function validateDevice(value: unknown): Device {
  if (!isRecord(value)) throw new Error('设备参数格式错误')
  if (!isValidIp(value.ip)) throw new Error('IP 地址格式不合法')
  const protocols = Array.isArray(value.availableProtocols)
    ? value.availableProtocols.filter(isProtocolId)
    : []
  // 仅保留 1-65535 的整数端口并去重，避免脏数据进入存储层。
  const detectedPorts = Array.isArray(value.detectedPorts)
    ? [
        ...new Set(
          value.detectedPorts.filter(
            (p): p is number =>
              typeof p === 'number' && Number.isInteger(p) && p >= 1 && p <= 65535
          )
        )
      ]
    : []
  const osHint = OS_HINTS.includes(value.osHint as OsHint) ? (value.osHint as OsHint) : 'unknown'
  const source = SOURCES.includes(value.source as DiscoverySource)
    ? (value.source as DiscoverySource)
    : 'manual'
  const timestamp = new Date().toISOString()
  return {
    id: asString(value.id) || `dev-${value.ip.replace(/\./g, '-')}`,
    name: asString(value.name).trim() || value.ip,
    ip: value.ip,
    mac: asString(value.mac),
    osHint,
    source,
    availableProtocols: protocols,
    detectedPorts,
    online: value.online !== false,
    lastSeenAt: asString(value.lastSeenAt, timestamp),
    createdAt: asString(value.createdAt, timestamp),
    updatedAt: asString(value.updatedAt, timestamp)
  }
}

export function validateConnectRequest(value: unknown) {
  if (!isRecord(value)) throw new Error('连接参数格式错误')
  if (!isValidIp(value.ip)) throw new Error('目标 IP 格式不合法')
  if (!isProtocolId(value.protocol)) throw new Error('不支持的协议')
  const request = {
    deviceId: asString(value.deviceId),
    ip: value.ip,
    protocol: value.protocol as ProtocolId,
    port: undefined as number | undefined,
    username: typeof value.username === 'string' ? value.username : undefined,
    password: typeof value.password === 'string' ? value.password : undefined,
    rustdeskId: typeof value.rustdeskId === 'string' ? value.rustdeskId : undefined,
    screenMode: (value.screenMode === 'fullscreen' ? 'fullscreen' : 'window') as 'fullscreen' | 'window',
    useCmdkey: value.useCmdkey === true,
    clipboardSharing: typeof value.clipboardSharing === 'boolean' ? value.clipboardSharing : undefined,
    driveRedirection: typeof value.driveRedirection === 'boolean' ? value.driveRedirection : undefined,
    precheck: undefined as PrecheckResult | undefined
  }
  if (typeof value.port === 'number' && Number.isInteger(value.port) && value.port > 0 && value.port <= 65535) {
    request.port = value.port
  }
  // 端口预检结果：可选字段，逐字段白名单校验后才透传，用于把预检与本次连接串进同一条事件链。
  // 校验失败不阻断连接，只丢弃这段附加元数据（避免渲染层伪造任意对象进入日志）。
  const pc = value.precheck
  if (
    isRecord(pc) &&
    isValidIp(pc.ip) &&
    typeof pc.port === 'number' && Number.isInteger(pc.port) && pc.port >= 0 && pc.port <= 65535 &&
    typeof pc.reachable === 'boolean' &&
    typeof pc.latencyMs === 'number' && Number.isFinite(pc.latencyMs) && pc.latencyMs >= 0
  ) {
    request.precheck = {
      ip: pc.ip,
      port: pc.port,
      reachable: pc.reachable,
      latencyMs: pc.latencyMs,
      ...(pc.skipped === true ? { skipped: true } : {})
    }
  }
  return request
}

export function validateCredentialInput(value: unknown): CredentialInput {
  if (!isRecord(value)) throw new Error('凭据参数格式错误')
  if (!asString(value.deviceId).trim()) throw new Error('缺少设备 ID')
  if (!isProtocolId(value.protocol)) throw new Error('不支持的协议')
  return {
    deviceId: asString(value.deviceId),
    protocol: value.protocol,
    username: asString(value.username),
    password: asString(value.password)
  }
}

export function validateSettingsPatch(value: unknown): Partial<AppSettings> {
  if (!isRecord(value)) throw new Error('设置参数格式错误')
  const patch: Partial<AppSettings> = {}
  if (typeof value.vncViewerPath === 'string') {
    patch.vncViewerPath = value.vncViewerPath.trim() ? validateExecutablePath(value.vncViewerPath) : ''
  }
  if (typeof value.rustdeskPath === 'string') {
    patch.rustdeskPath = value.rustdeskPath.trim() ? validateExecutablePath(value.rustdeskPath) : ''
  }
  if (typeof value.useCmdkey === 'boolean') patch.useCmdkey = value.useCmdkey
  if (typeof value.complianceAccepted === 'boolean') patch.complianceAccepted = value.complianceAccepted
  if (typeof value.telemetryConsent === 'boolean') patch.telemetryConsent = value.telemetryConsent
  if (typeof value.clipboardSharing === 'boolean') patch.clipboardSharing = value.clipboardSharing
  if (typeof value.driveRedirection === 'boolean') patch.driveRedirection = value.driveRedirection
  if (typeof value.defaultShareName === 'string') {
    // 只允许安全的共享名字符，杜绝反斜杠/斜杠造成的路径逃逸
    const share = value.defaultShareName.trim()
    if (share && !/^[A-Za-z0-9_.\- $\u4e00-\u9fa5]+$/.test(share)) {
      throw new Error('共享名包含非法字符（仅允许字母、数字、空格、点、下划线、连字符及中文）')
    }
    patch.defaultShareName = share
  }
  return patch
}

/** 校验文件传输目标：合法 IPv4 + 安全共享名 */
export function validateFileTransferTarget(value: unknown): { ip: string; share: string; hint: OsHint } {
  if (!isRecord(value)) throw new Error('文件传输参数格式错误')
  if (!isValidIp(value.ip)) throw new Error('目标 IP 格式不合法')
  const hint = OS_HINTS.includes(value.hint as OsHint) ? (value.hint as OsHint) : 'unknown'
  const share = typeof value.share === 'string' ? value.share.trim() : ''
  if (share && !/^[A-Za-z0-9_.\- $\u4e00-\u9fa5]+$/.test(share)) {
    throw new Error('共享名包含非法字符（仅允许字母、数字、空格、点、下划线、连字符及中文）')
  }
  if (share.includes('..')) throw new Error('共享名不合法')
  return { ip: value.ip, share, hint }
}

export function validateId(value: unknown): string {
  const id = asString(value).trim()
  if (!id) throw new Error('缺少记录 ID')
  // ID 由本应用生成，禁止引入路径分隔符等异常字符
  if (/[\\/:*?"<>|\s]/.test(id)) throw new Error('记录 ID 格式不合法')
  return id
}

/* ---------- v1.3.0 诊断查询 / 管理页 / 远程唤醒入参校验 ---------- */

const LOG_LEVELS: LogLevel[] = ['INFO', 'WARN', 'ERROR']
const DEFAULT_LOG_LIMIT = 200
const MAX_LOG_LIMIT = 1000
const MAX_LOG_TEXT_LEN = 200

/** trim 后限长；空串 / 非法值返回 undefined（宽松忽略） */
function limitedText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().slice(0, MAX_LOG_TEXT_LEN)
  return trimmed || undefined
}

/**
 * 日志查询条件：白名单字段，非法值宽松忽略而非抛错。
 * limit 钳到 1..1000，非法或缺省取默认 200。
 */
export function validateLogQuery(payload: unknown): LogQuery {
  const query: LogQuery = {}
  if (!isRecord(payload)) {
    query.limit = DEFAULT_LOG_LIMIT
    return query
  }
  if (Array.isArray(payload.levels)) {
    const levels = payload.levels.filter(
      (level): level is LogLevel =>
        typeof level === 'string' && (LOG_LEVELS as string[]).includes(level)
    )
    if (levels.length > 0) query.levels = [...new Set(levels)]
  }
  const module = limitedText(payload.module)
  if (module) query.module = module
  const traceId = limitedText(payload.traceId)
  if (traceId) query.traceId = traceId
  const keyword = limitedText(payload.keyword)
  if (keyword) query.keyword = keyword
  if (typeof payload.from === 'string' && payload.from.trim()) query.from = payload.from.trim()
  if (typeof payload.to === 'string' && payload.to.trim()) query.to = payload.to.trim()
  if (typeof payload.limit === 'number' && Number.isFinite(payload.limit)) {
    query.limit = Math.min(MAX_LOG_LIMIT, Math.max(1, Math.trunc(payload.limit)))
  } else {
    query.limit = DEFAULT_LOG_LIMIT
  }
  return query
}

/** 管理页目标：合法 IPv4 + 1..65535 整数端口，否则抛中文错误。 */
export function validateServerLinkTarget(payload: unknown): ServerLinkTarget {
  if (!isRecord(payload)) throw new Error('管理页目标参数格式错误')
  if (!isValidIp(payload.ip)) throw new Error('目标 IP 地址格式不合法')
  if (
    typeof payload.port !== 'number' ||
    !Number.isInteger(payload.port) ||
    payload.port < 1 ||
    payload.port > 65535
  ) {
    throw new Error('管理页端口必须是 1..65535 的整数')
  }
  return { ip: payload.ip, port: payload.port }
}

/**
 * 远程唤醒目标：MAC 必须可被 parseMac 解析；ip 可选、合法才保留。
 * 注意：错误文案与任何日志都不写入 MAC 值本身。
 */
export function validateWakeTarget(payload: unknown): WakeTarget {
  if (!isRecord(payload)) throw new Error('远程唤醒目标参数格式错误')
  if (typeof payload.mac !== 'string' || parseMac(payload.mac) === null) {
    throw new Error('MAC 地址格式不合法，请提供 6 字节硬件地址')
  }
  const target: WakeTarget = { mac: payload.mac.trim() }
  if (isValidIp(payload.ip)) target.ip = payload.ip
  return target
}
