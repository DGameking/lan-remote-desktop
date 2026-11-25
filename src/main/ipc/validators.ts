import path from 'node:path'
import type {
  AppSettings,
  CredentialInput,
  Device,
  DeviceMetaInput,
  DiscoverySource,
  ExportData,
  IpcResponse,
  LogLevel,
  LogQuery,
  OsHint,
  PrecheckResult,
  ProtocolId,
  DisplayMode,
  ServerLinkTarget,
  WakeTarget
} from '../../shared/types'
import { parseManualSubnet } from '../discovery/subnet'
import { parseMac } from '../discovery/wol'
import { isProtocolId } from '../protocols/registry'

const OS_HINTS: OsHint[] = ['windows', 'macos', 'linux', 'fnos', 'unknown']
const SOURCES: DiscoverySource[] = ['subnet', 'mdns', 'arp', 'manual']
const DISPLAY_MODES: DisplayMode[] = ['fit', 'native', 'fixed', 'fullscreen']
const FORBIDDEN_PATH_CHARS = /[;&|`$<>!]/ // 杜绝 shell 元字符（虽然一律用参数数组调起）

export function isDisplayMode(value: unknown): value is DisplayMode {
  return typeof value === 'string' && (DISPLAY_MODES as string[]).includes(value)
}

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
  const osConfidence =
    value.osConfidence === 'high' || value.osConfidence === 'medium' || value.osConfidence === 'low'
      ? value.osConfidence
      : 'none'
  const osEvidence = Array.isArray(value.osEvidence)
    ? value.osEvidence
        .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
        .map((item) => ({
          source: asString(item.source) as import('../../shared/types').OsEvidence['source'],
          osHint: OS_HINTS.includes(item.osHint as OsHint) ? (item.osHint as OsHint) : 'unknown',
          detail: asString(item.detail)
        }))
        .filter((item) => item.detail.length > 0)
    : []
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
    osConfidence,
    osEvidence,
    osManual: value.osManual === true,
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
    displayMode: isDisplayMode(value.displayMode) ? value.displayMode : undefined,
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

/* ---------- v1.7: 延迟测速 / 在线刷新 / 定时扫描入参校验 ---------- */

/** 延迟测速入参：合法 IPv4 + 1..65535 整数端口。 */
export function validateLatencyMeasure(ip: unknown, port: unknown): { ip: string; port: number } {
  if (!isValidIp(ip)) throw new Error('目标 IP 格式不合法')
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('端口必须是 1..65535 的整数')
  }
  return { ip, port }
}

/** 延迟历史查询的 IP：空/undefined 表示不过滤，否则必须是合法 IPv4。 */
export function validateLatencyListIp(ip: unknown): string | undefined {
  if (ip === undefined || ip === null || ip === '') return undefined
  if (!isValidIp(ip)) throw new Error('IP 地址格式不合法')
  return ip
}

/** 在线刷新设置：开关为 boolean；间隔为 15..3600 的整数秒（最小 15，默认 60）。 */
export function validateOnlineRefreshSettings(
  enabled: unknown,
  intervalSec: unknown
): Pick<Partial<AppSettings>, 'onlineRefreshEnabled' | 'onlineRefreshIntervalSec'> {
  const patch: Pick<Partial<AppSettings>, 'onlineRefreshEnabled' | 'onlineRefreshIntervalSec'> = {}
  if (typeof enabled === 'boolean') patch.onlineRefreshEnabled = enabled
  if (typeof intervalSec === 'number') {
    if (!Number.isInteger(intervalSec) || intervalSec < 15 || intervalSec > 3600) {
      throw new Error('在线刷新间隔需在 15..3600 秒之间')
    }
    patch.onlineRefreshIntervalSec = intervalSec
  }
  return patch
}

/** 定时扫描设置：0=关闭，否则为 1..1440 的整数分钟。 */
export function validateAutoScanSettings(
  intervalMin: unknown
): Pick<Partial<AppSettings>, 'autoScanIntervalMin'> {
  const patch: Pick<Partial<AppSettings>, 'autoScanIntervalMin'> = {}
  if (typeof intervalMin === 'number') {
    if (!Number.isInteger(intervalMin) || intervalMin < 0 || intervalMin > 1440) {
      throw new Error('定时扫描间隔需在 0..1440 分钟之间（0 表示关闭）')
    }
    patch.autoScanIntervalMin = intervalMin
  }
  return patch
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
  // v1.6: RDP 连接预设。值域收敛，拒绝越界与非法组合，避免写进 .rdp 时产生异常参数。
  if (value.rdpScreenMode === 'adaptive' || value.rdpScreenMode === 'fullscreen') {
    patch.rdpScreenMode = value.rdpScreenMode
  }
  // v1.8: 统一显示模式
  if (isDisplayMode(value.displayMode)) patch.displayMode = value.displayMode
  if (typeof value.rdpWidth === 'number') {
    if (!Number.isInteger(value.rdpWidth) || value.rdpWidth < 0 || value.rdpWidth > 7680) {
      throw new Error('分辨率宽度需在 0（跟随窗口）到 7680 之间')
    }
    patch.rdpWidth = value.rdpWidth
  }
  if (typeof value.rdpHeight === 'number') {
    if (!Number.isInteger(value.rdpHeight) || value.rdpHeight < 0 || value.rdpHeight > 4320) {
      throw new Error('分辨率高度需在 0（跟随窗口）到 4320 之间')
    }
    patch.rdpHeight = value.rdpHeight
  }
  if (typeof value.rdpPrinterRedirection === 'boolean') {
    patch.rdpPrinterRedirection = value.rdpPrinterRedirection
  }
  // v1.7: 在线刷新与定时扫描（在原 v1.6 RDP 逻辑基础上追加，不覆盖既有字段）。
  Object.assign(
    patch,
    validateOnlineRefreshSettings(value.onlineRefreshEnabled, value.onlineRefreshIntervalSec),
    validateAutoScanSettings(value.autoScanIntervalMin)
  )
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
 * v1.4: 目标网段参数。允许 undefined（自动选主网段）、合法 CIDR（192.168.10.0/24）
 * 或单个 IPv4（192.168.10.68，按 /24 处理）。用 parseManualSubnet 做唯一解析来源。
 */
export function validateTargetCidr(payload: unknown): string | undefined {
  if (payload === undefined || payload === null || payload === '') return undefined
  if (typeof payload !== 'string') throw new Error('目标网段参数必须是字符串')
  const parsed = parseManualSubnet(payload)
  if (!parsed) throw new Error('网段格式不合法，请输入 192.168.10.0/24 或 192.168.10.68')
  return parsed.cidr
}

/** v1.4: 手动指定系统类型入参：deviceId 非空 + 合法 OsHint。 */
export function validateDeviceSetOs(deviceId: unknown, osHint: unknown): { deviceId: string; osHint: OsHint } {
  if (typeof deviceId !== 'string' || !deviceId.trim()) throw new Error('设备 ID 不能为空')
  if (!OS_HINTS.includes(osHint as OsHint)) throw new Error('不支持的系统类型')
  return { deviceId: deviceId.trim(), osHint: osHint as OsHint }
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

/* ---------- v1.6: 设备元数据 / 会话备注 / 导入备份包校验 ---------- */

/**
 * v1.6: 设备元数据更新入参。只接受 deviceId + 白名单字段，且至少带一个待更新字段，
 * 避免渲染层误传空对象造成无意义写入。
 */
export function validateDeviceMetaInput(payload: unknown): DeviceMetaInput {
  if (!isRecord(payload)) throw new Error('设备元数据参数格式错误')
  const deviceId = asString(payload.deviceId).trim()
  if (!deviceId) throw new Error('设备 ID 不能为空')
  const input: DeviceMetaInput = { deviceId }
  if (typeof payload.favorite === 'boolean') input.favorite = payload.favorite
  if (typeof payload.pinned === 'boolean') input.pinned = payload.pinned
  if (typeof payload.alias === 'string') {
    const alias = payload.alias.trim()
    if (alias.length > 80) throw new Error('设备别名不能超过 80 个字符')
    input.alias = alias
  }
  if (typeof payload.group === 'string') {
    const group = payload.group.trim()
    if (group.length > 40) throw new Error('设备分组不能超过 40 个字符')
    input.group = group
  }
  if (
    input.favorite === undefined &&
    input.pinned === undefined &&
    input.alias === undefined &&
    input.group === undefined
  ) {
    throw new Error('至少要提供一个待更新的元数据字段')
  }
  return input
}

/** v1.6: 会话备注入参。IPC 传两个独立参数（sessionId, note），故本函数也接收两个 unknown。 */
export function validateSessionNote(sessionId: unknown, note: unknown): { id: string; note: string } {
  const id = asString(sessionId).trim()
  if (!id) throw new Error('会话 ID 不能为空')
  if (typeof note !== 'string') throw new Error('会话备注必须是字符串')
  if (note.length > 500) throw new Error('会话备注不能超过 500 个字符')
  return { id, note }
}

/**
 * v1.6: 导入备份包校验。只认本应用导出的固定结构，拒绝损坏/恶意文件。
 * 设备复用 validateDevice 做规范化，确保 IP 合法、协议列表为数组、端口干净。
 */
export function validateExportData(payload: unknown): ExportData {
  if (!isRecord(payload)) throw new Error('备份文件格式错误')
  if (payload.format !== 'landesk-backup') throw new Error('不是 LanDesk 备份文件')
  if (payload.version !== 1) throw new Error('不支持的备份文件版本')
  if (!Array.isArray(payload.devices)) throw new Error('备份文件中的设备列表格式错误')
  const devices = payload.devices.map((item) => {
    if (!isRecord(item)) throw new Error('备份文件中的设备记录格式错误')
    if (!isValidIp(item.ip)) throw new Error('备份文件中的设备 IP 不合法')
    if (!Array.isArray(item.availableProtocols)) {
      throw new Error('备份文件中的设备协议列表格式错误')
    }
    return validateDevice(item)
  })
  if (!isRecord(payload.settings)) throw new Error('备份文件中的设置格式错误')
  return {
    format: 'landesk-backup',
    version: 1,
    exportedAt: asString(payload.exportedAt, new Date().toISOString()),
    devices,
    settings: payload.settings as unknown as AppSettings
  }
}
