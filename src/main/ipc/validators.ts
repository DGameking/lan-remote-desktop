import path from 'node:path'
import type {
  AppSettings,
  CredentialInput,
  Device,
  DiscoverySource,
  IpcResponse,
  OsHint,
  ProtocolId
} from '../../shared/types'
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
    useCmdkey: value.useCmdkey === true
  }
  if (typeof value.port === 'number' && Number.isInteger(value.port) && value.port > 0 && value.port <= 65535) {
    request.port = value.port
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
  return patch
}

export function validateId(value: unknown): string {
  const id = asString(value).trim()
  if (!id) throw new Error('缺少记录 ID')
  // ID 由本应用生成，禁止引入路径分隔符等异常字符
  if (/[\\/:*?"<>|\s]/.test(id)) throw new Error('记录 ID 格式不合法')
  return id
}
