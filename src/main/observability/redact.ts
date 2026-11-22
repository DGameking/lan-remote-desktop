/**
 * LanDesk 本地可观测性 —— 脱敏纯函数层。
 *
 * 零遥测：只在主进程内对"即将写入本机日志 / 即将导出诊断包"的数据做脱敏，
 * 不做任何网络外发，不采集远程画面、键盘记录或明文凭据。
 *
 * 关于 traceId：LogEntry.traceId 只允许使用随机 sessionId（randomUUID），
 * 绝不使用 deviceId，避免把设备稳定标识串进可追溯链；本模块不生成 traceId。
 */

/** 敏感键：命中即把"值"替换为 [REDACTED]（不区分大小写、子串匹配） */
export const SENSITIVE_KEYS = [
  'password', 'passwd', 'pwd', 'encryptedPassword', 'passwordHex',
  'token', 'secret', 'credential', 'privateKey', 'authorization',
  'cookie', 'dpapi', 'hex', 'username', 'user', 'mac'
] as const

const REDACTED = '[REDACTED]'

/** 路径类键：值取 basename，并去掉 C:\Users\<用户名> / UNC 用户名段（精确匹配键名） */
const PATH_KEYS = [
  'file', 'rdpFile', 'tempFile', 'executable', 'path',
  'vncViewerPath', 'rustdeskPath', 'detail'
] as const

/** 用户自定义别名：省略或 [REDACTED]，此处统一 [REDACTED]（精确匹配键名） */
const ALIAS_KEYS = ['share', 'defaultShareName', 'deviceName', 'name'] as const

/**
 * IP 类例外键：值保留完整 IPv4（诊断定位必需）。
 * 用户把诊断文本贴给 AI 时要能看出是哪台设备端口不通，故 context 内绝不掩码。
 */
const IP_KEYS = ['ip', 'rustdeskId', 'id', 'subnet', 'cidr'] as const

/** deviceId 单独归一化：dev-192-168-1-20 / quick-192-168-1-20 -> 192.168.1.20 */
const DEVICE_ID_KEY = 'deviceId'

function inSet(keyLower: string, set: readonly string[]): boolean {
  return set.some((k) => k.toLowerCase() === keyLower)
}

function containsSensitive(keyLower: string): boolean {
  return SENSITIVE_KEYS.some((w) => keyLower.includes(w.toLowerCase()))
}

/**
 * 自由文本清洗：RDP 密码行 / ≥32 位连续 hex / Bearer / URL userinfo（user:pass@）。
 * IPv4 不含上述结构，故 LAN IP 会原样保留。
 */
export function redactText(text: string): string {
  let out = text
  out = out.replace(/password\s*51:b:[0-9a-fA-F]+/gi, REDACTED)
  out = out.replace(/\bBearer\s+\S+/gi, REDACTED)
  out = out.replace(/[^\s:/@]+:[^\s@/]+@/g, REDACTED)
  out = out.replace(/\b[0-9a-fA-F]{32,}\b/g, REDACTED)
  return out
}

/** 路径归一化：去用户名段 -> 取 basename -> 自由文本清洗 */
function redactPath(text: string): string {
  const unified = text.replace(/\\/g, '/')
  const withoutUser = unified
    .replace(/(?:^|\/)[A-Za-z]:\/Users\/[^/]+/gi, '') // C:/Users/<name>
    .replace(/\/Users\/[^/]+/gi, '') // UNC 里的 /Users/<name>
  const parts = withoutUser.split('/').filter(Boolean)
  const base = parts.length ? parts[parts.length - 1] : ''
  return base ? redactText(base) : REDACTED
}

/** deviceId 值归一化为普通 IPv4；不是 dev-/quick- 形式则按普通文本清洗 */
function normalizeDeviceId(value: string): string {
  const m = /^(?:dev|quick)-(\d{1,3})-(\d{1,3})-(\d{1,3})-(\d{1,3})$/.exec(value)
  return m ? `${m[1]}.${m[2]}.${m[3]}.${m[4]}` : redactText(value)
}

/**
 * IPv4 掩码：把最后一段换成星号（192.168.1.20 -> 192.168.1 星），
 * 保留 CIDR 后缀（192.168.1.0/24 -> 192.168.1 星 加 /24）。
 * 仅用于快照的 subnetRedacted / lastScan.subnetRedacted，绝不用于 context。
 */
export function redactIpv4(ip: string): string {
  return ip.replace(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g, '$1.$2.$3.*')
}

function redactPrimitive(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value)
  // BigInt / Symbol / Function 无法被 JSON.stringify，统一降级为安全字符串
  if (typeof value === 'bigint') return `[BigInt:${value.toString()}]`
  if (typeof value === 'symbol') return '[Symbol]'
  if (typeof value === 'function') return '[Function]'
  return value // number / boolean / null / undefined
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** 递归脱敏；用回溯式 WeakSet 只拦真正的循环引用，不误伤共享引用 */
function redactAny(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') return redactPrimitive(value)
  const obj = value as object
  // Error 只取 message，再走自由文本正则，避免泄漏堆栈里的路径/凭据
  if (value instanceof Error) return { message: redactText(value.message) }
  if (seen.has(obj)) return '[CIRCULAR]'
  seen.add(obj)
  let result: unknown
  if (Array.isArray(value)) {
    result = value.map((v) => redactAny(v, seen))
  } else {
    const out: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactKeyValue(key, val, seen)
    }
    result = out
  }
  seen.delete(obj)
  return result
}

/** 按 key 语义分派：敏感 > 路径 > 别名 > IP 例外 > deviceId > 默认递归 */
function redactKeyValue(key: string, value: unknown, seen: WeakSet<object>): unknown {
  const keyLower = key.toLowerCase()

  // 1. 敏感键（子串匹配，最高优先级，命中即 [REDACTED]）
  if (containsSensitive(keyLower)) return REDACTED

  // 2. 路径类：字符串值取 basename + 去用户名段
  if (inSet(keyLower, PATH_KEYS)) {
    return typeof value === 'string' ? redactPath(value) : redactAny(value, seen)
  }

  // 3. 用户自定义别名
  if (inSet(keyLower, ALIAS_KEYS)) return REDACTED

  // 4. IP 类例外：保留完整 IPv4（仍走自由文本清洗，IPv4 不受影响）
  if (inSet(keyLower, IP_KEYS)) {
    return typeof value === 'string' ? redactText(value) : redactAny(value, seen)
  }

  // 5. deviceId 归一化
  if (keyLower === DEVICE_ID_KEY.toLowerCase()) {
    return typeof value === 'string' ? normalizeDeviceId(value) : redactAny(value, seen)
  }

  // 6. 默认：递归，字符串值统一走自由文本清洗
  return redactAny(value, seen)
}

/**
 * 把任意值脱敏成一个可安全 JSON 序列化的 Record。
 * 对象/数组/Error/循环引用/undefined/BigInt/Symbol 都不会抛错；
 * 顶层标量或数组统一包进 { value }，保证返回类型恒为 Record<string, unknown>。
 */
export function redactContext(value: unknown): Record<string, unknown> {
  const redacted = redactAny(value, new WeakSet<object>())
  return isPlainObject(redacted) ? redacted : { value: redacted }
}
