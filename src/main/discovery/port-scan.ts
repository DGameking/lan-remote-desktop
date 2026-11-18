import net from 'node:net'

export interface PortScanOptions {
  /** 并发连接数上限，默认 50 */
  concurrency?: number
  /** 单连接超时（毫秒），默认 400 */
  timeout?: number
  /** 外部取消回调，返回 true 时停止派发新任务 */
  shouldStop?: () => boolean
}

export type PortScanProgress = (done: number, total: number) => void

function probe(ip: string, port: number, timeout: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    let socket: net.Socket | null = null
    const finish = (open: boolean): void => {
      if (settled) return
      settled = true
      socket?.destroy()
      resolve(open)
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

/**
 * 并发 TCP 端口探测。只建立连接判断端口是否开放，不发送任何协议数据。
 */
export async function scanPorts(
  hosts: string[],
  ports: number[],
  options: PortScanOptions = {},
  onProgress?: PortScanProgress
): Promise<Map<string, number[]>> {
  const concurrency = Math.max(1, options.concurrency ?? 50)
  const timeout = Math.max(50, options.timeout ?? 400)
  const tasks: Array<{ ip: string; port: number }> = []
  for (const host of hosts) {
    for (const port of ports) tasks.push({ ip: host, port })
  }

  const openPorts = new Map<string, number[]>()
  let cursor = 0
  let done = 0

  const worker = async (): Promise<void> => {
    while (cursor < tasks.length) {
      if (options.shouldStop?.()) return
      const task = tasks[cursor++]
      const open = await probe(task.ip, task.port, timeout)
      if (open) {
        const list = openPorts.get(task.ip) ?? []
        list.push(task.port)
        openPorts.set(task.ip, list)
      }
      done += 1
      onProgress?.(done, tasks.length)
    }
  }

  const workerCount = Math.min(concurrency, tasks.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return openPorts
}
