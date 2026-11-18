import net from 'node:net'
import type { PrecheckResult } from '../../shared/types'

/** 单次 TCP 连接探测，测量目标端口是否可达与往返耗时。不发送任何协议数据。 */
export function probePort(ip: string, port: number, timeout = 1200): Promise<PrecheckResult> {
  return new Promise((resolve) => {
    const started = Date.now()
    let settled = false
    let socket: net.Socket | null = null
    const finish = (reachable: boolean): void => {
      if (settled) return
      settled = true
      const latencyMs = Date.now() - started
      socket?.destroy()
      resolve({ ip, port, reachable, latencyMs })
    }

    try {
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
