import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { logger } from '../logger'

/**
 * 仅用于日志的临时文件指纹（sha256 前 12 位）。
 * 绝不输出完整路径——路径含用户名/IP，属敏感信息。
 */
export function tempFileHash(filePath: string): string {
  return createHash('sha256').update(filePath).digest('hex').slice(0, 12)
}

export interface CleanupDecisionInput {
  alive: boolean
  elapsedMs: number
  consecutiveMisses: number
  graceMs: number
  confirmStreak: number
}

export type CleanupDecision = 'cleanup' | 'wait'

/**
 * 纯函数：是否该清理临时文件。
 * - 宽限期内永不判定（防 mstsc 单实例启动的假退出，与会话监控同款策略）；
 * - 进程仍存活 → 等待；
 * - 连续 N 次检测不到 → 清理。
 */
export function cleanupDecision(input: CleanupDecisionInput): CleanupDecision {
  if (input.elapsedMs < input.graceMs) return 'wait'
  if (input.alive) return 'wait'
  return input.consecutiveMisses >= input.confirmStreak ? 'cleanup' : 'wait'
}

/**
 * 删除临时文件，幂等：ENOENT（已被清理/从未创建）视为成功。
 * 其它失败记 WARN，只带哈希与错误码，不写路径。
 */
export function removeTempFile(filePath: string): { removed: boolean; failed: boolean } {
  try {
    fs.unlinkSync(filePath)
    return { removed: true, failed: false }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { removed: false, failed: false }
    logger.warn('临时凭据文件清理失败', { hash: tempFileHash(filePath), code })
    return { removed: false, failed: true }
  }
}

export interface ScheduleCleanupOptions {
  filePath: string
  pid: number
  isAlive: (pid: number) => Promise<boolean>
  pollMs?: number
  graceMs?: number
  fallbackMs?: number
  confirmStreak?: number
}

/**
 * v1.5-R2-5：调起外部进程后调度临时凭据文件清理。
 * - PID 有效：宽限期后轮询存活，连续确认退出即清理；
 * - 无 PID 或始终检测不到：fallbackMs 兜底清理（幂等）；
 * - 任何清理失败均记 WARN（含哈希不含路径）。
 * 返回 cancel() 供上层取消定时器；所有 timer 均 unref，不阻塞进程退出。
 */
export function scheduleTempFileCleanup(options: ScheduleCleanupOptions): () => void {
  const { filePath, pid } = options
  const pollMs = options.pollMs ?? 2000
  const graceMs = options.graceMs ?? 5000
  const fallbackMs = options.fallbackMs ?? 30000
  const confirmStreak = options.confirmStreak ?? 2
  const startedAt = Date.now()
  let consecutiveMisses = 0
  let done = false
  let pollTimer: ReturnType<typeof setInterval> | undefined
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined

  const finish = (): void => {
    if (done) return
    done = true
    if (pollTimer) clearInterval(pollTimer)
    if (fallbackTimer) clearTimeout(fallbackTimer)
    removeTempFile(filePath)
  }

  fallbackTimer = setTimeout(finish, fallbackMs)
  fallbackTimer.unref?.()

  if (!Number.isInteger(pid) || pid <= 0) {
    // 无有效 PID：无法做存活检测，只靠兜底定时器清理。
    return finish
  }

  pollTimer = setInterval(async () => {
    if (done) return
    let alive = true
    try {
      alive = await options.isAlive(pid)
    } catch {
      return // 检测异常按"仍存活"处理，交给兜底，绝不误删未读完的凭据文件
    }
    if (alive) {
      consecutiveMisses = 0
      return
    }
    consecutiveMisses += 1
    const decision = cleanupDecision({
      alive,
      elapsedMs: Date.now() - startedAt,
      consecutiveMisses,
      graceMs,
      confirmStreak
    })
    if (decision === 'cleanup') finish()
  }, pollMs)
  pollTimer.unref?.()

  return finish
}
