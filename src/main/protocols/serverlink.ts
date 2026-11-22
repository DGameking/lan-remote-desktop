/**
 * 内网设备 Web 管理页入口（严格防 SSRF）。
 *
 * 安全边界：本模块只根据「已发现设备的私有局域网 IPv4 + 该设备已发现端口」构造 http URL，
 * 绝不接受任何外部传入的 scheme / hostname / path / query / userinfo。
 * 端口必须同时满足：整数 1..65535、出现在该设备 detectedPorts 内、属于管理页白名单。
 * 内网管理页多为 http，本模块只产出 http，不探测 https、不跟随重定向。
 */

/** 常见内网设备 Web 管理页端口，按优先级从高到低排列。 */
export const MANAGE_PORT_PRIORITY: readonly number[] = [8000, 8001, 5666, 548, 5985, 5986]

const MANAGE_PORT_SET: ReadonlySet<number> = new Set(MANAGE_PORT_PRIORITY)

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

/** 从已发现端口里筛出管理页端口，按优先级排序、去重、过滤非法值；无候选返回 []。 */
export function pickManagePorts(detectedPorts: number[]): number[] {
  const present = new Set<number>()
  for (const port of detectedPorts) {
    if (isValidPort(port) && MANAGE_PORT_SET.has(port)) present.add(port)
  }
  // MANAGE_PORT_PRIORITY 本身有序且无重复，filter 天然完成优先级排序与去重
  return MANAGE_PORT_PRIORITY.filter((port) => present.has(port))
}

/**
 * 仅接受「无前导零歧义」的点分十进制 IPv4 字面量。
 * 每段 0..255，且不允许 010 这类前导零写法，避免八进制 / IP 变体绕过。
 * 正则同时拒绝 hostname、IPv6、带端口 / 路径的字符串。
 */
const IPV4_LITERAL =
  /^(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})$/

/** 判断是否为可安全访问的私有局域网 IPv4 主机地址。 */
export function isPrivateLanIp(ip: string): boolean {
  if (typeof ip !== 'string' || !IPV4_LITERAL.test(ip)) return false
  const parts = ip.split('.').map(Number)
  if (parts.some((n) => n < 0 || n > 255)) return false
  const [a, b, , d] = parts

  // 显式拒绝回环 / 未指定 / 链路本地 / 组播及保留段
  if (a === 127 || a === 0) return false
  if (a === 169 && b === 254) return false
  if (a >= 224) return false

  // 拒绝 x.x.x.0 网络号与 x.x.x.255 广播地址
  if (d === 0 || d === 255) return false

  // 仅三个 RFC1918 私有段
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  return false
}

type ManageUrlResult = { ok: boolean; url?: string; message: string }

/**
 * 构造内网管理页 URL。URL 仅由已校验的 ip / port 两个字段拼接，杜绝 SSRF。
 * 任何校验失败均返回 { ok:false, message }，不抛异常。
 */
export function buildManageUrl(input: {
  ip: string
  port: number
  detectedPorts: number[]
}): ManageUrlResult {
  const { ip, port, detectedPorts } = input

  if (!isPrivateLanIp(ip)) {
    return { ok: false, message: '目标不是私有局域网 IPv4 地址，已拒绝打开管理页' }
  }
  if (!isValidPort(port)) {
    return { ok: false, message: '端口必须是 1..65535 的整数，已拒绝' }
  }
  // 核心防 SSRF：端口必须是该设备真实发现的端口，不能拿已发现设备当跳板访问任意端口
  if (!detectedPorts.includes(port)) {
    return { ok: false, message: '端口不在该设备已发现端口列表中，已拒绝' }
  }
  if (!MANAGE_PORT_SET.has(port)) {
    return { ok: false, message: '该端口不是受支持的管理页端口' }
  }

  return { ok: true, url: `http://${ip}:${port}`, message: '已生成内网管理页地址' }
}
