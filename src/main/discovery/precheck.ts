import net from 'node:net'
import type { PrecheckResult } from '../../shared/types'

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
