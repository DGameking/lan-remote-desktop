import { execFile } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import type { PrecheckConclusion, PrecheckResult } from '../../shared/types'

/**
 * 单次 TCP 连接探测，测量目标端口是否可达与往返耗时。不发送任何协议数据。
 *
 * 防泄漏写法（与 fingerprint.ts / wol.ts 同款）：absolute timeout 兜底 + settled guard +
 * socket.setTimeout + finish 内 clearTimeout / destroy() / removeAllListeners()，
 * 无论 connect / timeout / error 回调是否触发，都保证只结算一次并释放全部句柄，绝不悬挂。
 * 对外契约（签名、参数、返回值形状）保持不变。
 */
export function probePort(ip: string, port: number, timeout = 1200): Promise<PrecheckResult> {
  return new Promise((resolve) => {
    const started = Date.now()
    let settled = false
    let socket: net.Socket | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (reachable: boolean): void => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      if (socket !== null) {
        // 与 fingerprint.ts 同款：先摘掉全部监听再销毁句柄，避免残留 once 监听或二次 error
        socket.removeAllListeners()
        socket.destroy()
      }
      resolve({ ip, port, reachable, latencyMs: Date.now() - started })
    }

    try {
      // absolute timeout：即便底层 connect 卡死、socket 事件全部失灵，到点也必定结算
      timer = setTimeout(() => finish(false), timeout)
      socket = net.createConnection({ host: ip, port, family: 4 })
      socket.setTimeout(timeout)
      socket.once('connect', () => finish(true))
      socket.once('timeout', () => finish(false))
      socket.once('error', () => finish(false))
    } catch {
      finish(false)
    }
  })
}

/**
 * 从多次探测结果中挑选最终结果（纯函数，便于单测，不触碰任何句柄）。
 * 规则：有 reachable 时取 latencyMs 最小者；否则返回最后一个结果。
 * 全失败时返回「最后一个」也顺带保留了它的 skipped 等语义，供 UI 判定是否跳过预检。
 * 空数组为兜底（probePortWithRetry 至少探测一次，正常不会发生），避免 undefined 外泄。
 */
export function pickBestProbe(results: PrecheckResult[]): PrecheckResult {
  if (results.length === 0) {
    return { ip: '', port: 0, reachable: false, latencyMs: 0 }
  }
  const reachable = results.filter((result) => result.reachable)
  if (reachable.length === 0) return results[results.length - 1]
  return reachable.reduce((best, current) => (current.latencyMs < best.latencyMs ? current : best))
}

/**
 * 轻量 2 次 TCP 探测：第一次失败才试第二次（第二次超时略短），降低偶发丢包导致的假阴性。
 * 任一可达即返回可达结果并取最小 latencyMs；两次都失败返回不可达结果。
 * 本身不创建任何 socket / 定时器，完全复用 probePort 的防泄漏实现，不引入悬挂句柄。
 */
export async function probePortWithRetry(
  ip: string,
  port: number,
  timeoutMs = 1200
): Promise<PrecheckResult> {
  const results: PrecheckResult[] = []

  const first = await probePort(ip, port, timeoutMs)
  results.push(first)

  if (!first.reachable) {
    const secondTimeout = Math.max(1, Math.round(timeoutMs * 0.6))
    const second = await probePort(ip, port, secondTimeout)
    results.push(second)
  }

  return pickBestProbe(results)
}

/* ==========================================================================
 * v1.5-P0-4 / REQ-011：ping + 端口探测 → 三类可执行结论
 * 以下新增函数均为独立导出，不改动上方 probePort / pickBestProbe /
 * probePortWithRetry 的签名与行为（其它模块与既有单测依赖它们）。
 * ========================================================================== */

/** 严格 IPv4：逐段 0-255，且拒绝前导零（如 01.2.3.4）、域名、分号等注入载荷。 */
const STRICT_IPV4 =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

/** 合法 IPv4 判定（纯函数，供 icmpProbe 短路，防止命令注入）。 */
export function isValidIpv4Strict(ip: string): boolean {
  return typeof ip === 'string' && STRICT_IPV4.test(ip)
}

export interface PrecheckClassification {
  conclusion: PrecheckConclusion
  actions: string[]
}

/**
 * 把「TCP 端口是否可达 + ICMP 主机是否存活」翻译成用户可执行的结论。
 * 纯函数、无副作用，便于单测覆盖全部分支。
 *
 * - reachable=true：服务确实可达，无需排查。
 * - ICMP=false：主机不在线（先解决开机/组网）。
 * - ICMP=true：主机在线但端口不通 → 按端口区分「服务未开」还是「防火墙/认证」。
 * - ICMP=null：无法判断（ping 失败/超时/被禁），给通用排查清单。
 */
export function classifyPrecheck(input: {
  reachable: boolean
  icmpReachable: boolean | null
  port: number
  protocol?: string
}): PrecheckClassification {
  const { reachable, icmpReachable, port } = input

  if (reachable) return { conclusion: 'reachable', actions: [] }

  if (icmpReachable === null) {
    return {
      conclusion: 'unknown',
      actions: [
        '确认设备已开机并接入同一局域网',
        '确认目标服务已启动且正在监听对应端口',
        '检查两端防火墙是否放行该端口'
      ]
    }
  }

  if (icmpReachable === false) {
    return {
      conclusion: 'offline',
      actions: ['确认设备已开机', '确认设备与本机在同一局域网/同一网段']
    }
  }

  // 主机在线但端口不通：按端口给出针对性指引。
  if (port === 3389) {
    return {
      conclusion: 'firewall_or_auth',
      actions: [
        '到被控端确认已开启远程桌面，且系统为专业版/企业版',
        '检查被控端防火墙是否放行 3389 端口'
      ]
    }
  }
  if (port >= 5900 && port <= 5910) {
    return {
      conclusion: 'firewall_or_auth',
      actions: [
        '到被控端确认屏幕共享/VNC 服务已开启',
        '检查被控端防火墙是否放行对应 VNC 端口'
      ]
    }
  }
  return {
    conclusion: 'port_closed',
    actions: ['确认该服务已启动并正在监听此端口', '检查两端防火墙是否放行该端口']
  }
}

/**
 * 解析 ping 命令输出，判定主机是否在线。纯函数，便于单测覆盖各个平台文案。
 * 关键：ping 在"主机不在线"时通常以非零退出码结束（execFile 会给 error），
 * 绝不能仅凭 error 判为 null——否则 REQ-011 的"设备离线"结论永远无法命中。
 * - 命中回包特征（Reply from / bytes from）→ true
 * - 命中明确的"不可达/超时/丢包 100%"特征 → false
 * - 输出为空或无法判定 → null（不误报）
 */
export function parsePingOutput(output: string): boolean | null {
  const text = String(output ?? '')
  if (!text.trim()) return null
  // 失败信号必须先判：Windows 的"目标主机无法访问"回复同样带 "Reply from"
  // （来自网关而非目标机），若先判回包特征会把它误判为在线。
  const offlineSignals =
    /request\s+timed\s+out|destination\s+host\s+unreachable|100%\s*(packet\s*)?loss|general\s+failure|transmit\s+failed|unknown\s+host|could\s+not\s+find\s+host|请求超时|无法访问目标主机|目标主机无法访问|传输失败|一般故障|找不到主机/i
  if (offlineSignals.test(text)) return false
  // 统计行里 Received = 0 也判离线（须在回包判定之前，避免混合输出误判）
  if (/\breceived\s*=\s*0\b/i.test(text)) return false
  // 收到回包：Windows "Reply from 192.168.1.1: bytes=32 time=1ms TTL=64"
  //           Linux/macOS "64 bytes from 192.168.1.1: icmp_seq=1 ttl=64 time=0.03 ms"
  if (/\breply\s+from\b/i.test(text) || /\bbytes\s+from\b/i.test(text)) return true
  return null
}

/**
 * ICMP 存活探测：发一个 ping 包，判断主机是否在线。
 * - 收到带 TTL/time 的回包 → true（主机在线）
 * - 明确的超时/不可达输出 → false（主机不在线，即使退出码非零）
 * - 非法 IP / 命令无法执行 / 输出无法判定 → null（无法判断，绝不误报为 false）
 * 非法 IP 在 spawn 前短路，杜绝命令注入；使用 execFile（不经 shell）。
 */
export function icmpProbe(ip: string, timeoutMs = 1000): Promise<boolean | null> {
  if (!isValidIpv4Strict(ip)) return Promise.resolve(null)

  const isWin = process.platform === 'win32'
  const command = isWin
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'PING.EXE')
    : 'ping'
  const args = isWin
    ? ['-n', '1', '-w', String(timeoutMs), ip]
    : ['-c', '1', '-W', '1', ip]

  return new Promise((resolve) => {
    let settled = false
    const finish = (value: boolean | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    // absolute timeout 兜底：即便 execFile 回调失灵也必定结算，不悬挂。
    const timer = setTimeout(() => finish(null), timeoutMs + 800)

    try {
      execFile(
        command,
        args,
        { timeout: timeoutMs + 300, windowsHide: true },
        (_error, stdout, stderr) => {
          // 不看退出码：ping 离线主机时正常也会非零退出，但 stdout 里有明确的超时/不可达文案。
          // 合并 stderr 以兼容把诊断写到 stderr 的 ping 实现（如某些 Linux 发行版）。
          const output = `${String(stdout ?? '')}\n${String(stderr ?? '')}`
          finish(parsePingOutput(output))
        }
      )
    } catch {
      finish(null)
    }
  })
}

/**
 * 完整预检：并发执行 TCP 端口探测与 ICMP 存活探测，合并出带结论/行动指引的结果。
 * port<=0 或 rustdesk 协议不做无意义探测，直接返回 skipped 语义（reachable=true
 * 以免 UI 误显示为「不可达」，conclusion='unknown'）。
 */
export async function runFullPrecheck(
  ip: string,
  protocol: string,
  port: number,
  timeoutMs = 1200
): Promise<PrecheckResult> {
  if (port <= 0 || protocol === 'rustdesk') {
    return {
      ip,
      port: 0,
      reachable: true,
      latencyMs: 0,
      skipped: true,
      conclusion: 'unknown',
      actions: []
    }
  }

  const [portResult, icmpReachable] = await Promise.all([
    probePortWithRetry(ip, port, timeoutMs),
    icmpProbe(ip)
  ])
  const { conclusion, actions } = classifyPrecheck({
    reachable: portResult.reachable,
    icmpReachable,
    port,
    protocol
  })

  return {
    ...portResult,
    icmpReachable: icmpReachable === null ? undefined : icmpReachable,
    conclusion,
    actions
  }
}
