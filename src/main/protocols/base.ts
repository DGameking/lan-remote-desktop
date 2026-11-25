import { spawn, execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import type { ConnectRequest, ProtocolAvailability, ProtocolId } from '../../shared/types'
import { logger } from '../logger'

const execFileAsync = promisify(execFile)

/**
 * v1.5-P0-2: 最近一次 detach 调起的外部进程 PID。
 *
 * Electron 主进程单实例，且 SessionManager 已把连接串行化（connecting 态去重），
 * 因此这里用一个模块级单例回传 PID 即可，不会出现并发覆盖。
 * 适配器（rdp/vnc/rustdesk）的 connect() 签名保持不变（UI 依赖其 string 消息），
 * SessionManager 在 await connect() 后调用 takeLastLaunchedPid() 取走本次 PID。
 */
let lastLaunchedPid: number | undefined
/** v1.7.1: 最近一次调起的可执行文件名（basename），用于 PID 失效时按进程名兜底判定存活。 */
let lastLaunchedImageName: string | undefined

/** 仅供测试/特殊路径显式写入；正常路径由 spawnDetached 自动记录。 */
export function setLastLaunchedPid(pid: number): void {
  lastLaunchedPid = pid
}

/** 读取并清空最近一次调起的 PID（一次性消费，避免跨会话残留污染）。 */
export function takeLastLaunchedPid(): number | undefined {
  const pid = lastLaunchedPid
  lastLaunchedPid = undefined
  return pid
}

/** 仅供测试/特殊路径显式写入进程名；正常路径由 spawnDetached 自动记录。 */
export function setLastLaunchedImageName(name: string | undefined): void {
  lastLaunchedImageName = name
}

/** 读取并清空最近一次调起的进程名（与 PID 成对消费）。 */
export function takeLastLaunchedImageName(): string | undefined {
  const name = lastLaunchedImageName
  lastLaunchedImageName = undefined
  return name
}

/** 从可执行文件路径提取纯文件名；路径/引号异常时返回空串。 */
export function imageNameOf(command: string): string {
  if (typeof command !== 'string' || !command.trim()) return ''
  const base = path.basename(command.trim().replace(/^["']|["']$/g, ''))
  return /^[\w.\- ]+\.exe$/i.test(base) ? base : ''
}

/** 协议适配器：只负责准备参数并调起本机已安装的外部客户端，不实现任何协议栈 */
export interface ProtocolAdapter {
  readonly id: ProtocolId
  readonly label: string
  isAvailable(): Promise<ProtocolAvailability>
  connect(request: ConnectRequest): Promise<string>
}

/**
 * 外部进程一律以参数数组调起，绝不使用 shell 字符串拼接。
 * v1.5-P0-2: 返回调起进程的 PID（用于会话存活检测）；PID 取不到时为 0 并记 WARN。
 */
export function spawnDetached(command: string, args: string[]): Promise<{ pid: number }> {
  return new Promise<{ pid: number }>((resolve, reject) => {
    let settled = false
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        shell: false
      })
    } catch (error) {
      reject(error)
      return
    }
    child.once('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
    child.once('spawn', () => {
      if (settled) return
      settled = true
      child.unref()
      const rawPid = child.pid
      const pid =
        typeof rawPid === 'number' && Number.isInteger(rawPid) && rawPid > 0 ? rawPid : 0
      if (!pid) {
        logger.warn('外部进程已调起但未取得有效 PID，会话时长将标记为不可测', { command })
      }
      setLastLaunchedPid(pid)
      lastLaunchedImageName = imageNameOf(command)
      resolve({ pid })
    })
  })
}

/** 同步执行短命令（如 cmdkey），不 detach，等待退出码 */
export async function execCommand(command: string, args: string[]): Promise<void> {
  await execFileAsync(command, args, { windowsHide: true, timeout: 5000 })
}

/** 在 PATH 中查找可执行文件（Windows 用 where，其他平台用 which） */
export async function findOnPath(command: string): Promise<string> {
  if (process.platform !== 'win32') return ''
  try {
    const { stdout } = await execFileAsync('where', [command], {
      windowsHide: true,
      timeout: 3000
    })
    return stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? ''
  } catch {
    return ''
  }
}

export function availability(
  id: ProtocolId,
  label: string,
  available: boolean,
  detail: string
): ProtocolAvailability {
  return { id, label, available, detail }
}
