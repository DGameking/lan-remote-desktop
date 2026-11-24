import type { AppSettings, OnlineStatusEvent } from '../../shared/types'
import { probePort } from '../discovery/precheck'
import { scopedLogger } from '../logger'
import type { Store } from '../store/types'

const log = scopedLogger('online-monitor')

/** 在线刷新间隔下限（秒），与设置项校验保持一致。 */
export const MIN_REFRESH_INTERVAL_SEC = 15
/** 单轮并发探测上限，避免同时打开过多 socket。 */
export const DEFAULT_PROBE_CONCURRENCY = 8
/** 窗口失焦时的降频倍数：每 3 个 tick 只真正探测 1 次。 */
export const UNFOCUSED_SKIP_FACTOR = 3

export interface OnlineTarget {
  ip: string
  port: number
}

export interface OnlineMonitorDeps {
  /** 每轮开始时动态读取探测目标（设备列表会随扫描/增删变化）。 */
  getTargets: () => OnlineTarget[]
  /** 仅在线状态真正翻转时触发，用于向渲染层推送。 */
  onStatusChange: (event: OnlineStatusEvent) => void
  getSettings: () => AppSettings
  getStore: () => Store
}

/* ==========================================================================
 * 纯函数：并发分批、设置收敛、状态 diff。无副作用，便于单测。
 * ========================================================================== */

/** 把数组按 size 切块（size 收敛到 >=1）。 */
export function chunkTargets<T>(items: T[], size: number): T[][] {
  const chunkSize = Math.max(1, Math.floor(size))
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize))
  }
  return chunks
}

/** 读取设置里的秒数：容忍旧库/未归一化造成的字符串，收敛到 15..3600。 */
export function resolveRefreshIntervalSec(raw: unknown): number {
  const value = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(value)) return 60
  return Math.min(3600, Math.max(MIN_REFRESH_INTERVAL_SEC, Math.trunc(value)))
}

/** 设置里的布尔值：仅 true / 'true' 视为开启，兼容未归一化的存储读取。 */
export function isRefreshEnabled(raw: unknown): boolean {
  return raw === true || raw === 'true'
}

/**
 * 对比前后两次的在线状态，返回发生翻转的 IP。
 * 只比较 before 中已存在的 IP（新设备首轮不上报，避免噪声）。
 */
export function diffOnlineStatus(
  before: Map<string, boolean>,
  after: Map<string, boolean>
): string[] {
  const flipped: string[] = []
  for (const [ip, online] of after) {
    const previous = before.get(ip)
    if (previous !== undefined && previous !== online) flipped.push(ip)
  }
  return flipped
}

/* ==========================================================================
 * OnlineMonitor
 * ========================================================================== */

/**
 * v1.7: 设备在线状态定时巡检。
 *
 * - 用 setInterval 按设置间隔调度；窗口失焦时通过内部计数器跳过 2/3 的轮次降频，
 *   不重设定时器，避免频繁 clearInterval/setInterval 造成的抖动。
 * - 每轮对所有目标并发探测（分批 Promise.all，并发上限 8），单个探测失败按离线处理，
 *   整体不抛错。
 * - 批量落库交给 store.setDeviceOnlineBatch（内部只在真正翻转时 persist 一次），
 *   翻转的设备通过 onStatusChange 推送给渲染层。
 */
export class OnlineMonitor {
  private readonly getTargets: () => OnlineTarget[]
  private readonly onStatusChange: (event: OnlineStatusEvent) => void
  private readonly getSettings: () => AppSettings
  private readonly getStore: () => Store

  private timer: ReturnType<typeof setInterval> | null = null
  private running = false
  private focused = true
  private tickCounter = 0
  private inFlight = false
  private intervalSec = resolveRefreshIntervalSec(60)

  constructor(deps: OnlineMonitorDeps) {
    this.getTargets = deps.getTargets
    this.onStatusChange = deps.onStatusChange
    this.getSettings = deps.getSettings
    this.getStore = deps.getStore
  }

  get isRunning(): boolean {
    return this.running
  }

  /** 窗口焦点变化：失焦时降频，回焦后下一个 tick 立即恢复全频。 */
  setWindowFocused(focused: boolean): void {
    if (this.focused === focused) return
    this.focused = focused
    // 回焦时清零计数器，保证下一拍就探测；失焦时从 1 开始数，第三拍才探测。
    this.tickCounter = 0
  }

  /**
   * 依据当前设置启停 / 重建定时器：
   * - 开关关闭 → 停止；
   * - 未运行且开启 → 启动；
   * - 已运行且间隔变化 → 重启定时器。
   */
  applySettings(): void {
    const settings = this.getSettings()
    if (!isRefreshEnabled(settings.onlineRefreshEnabled)) {
      this.stop()
      return
    }
    const nextIntervalSec = resolveRefreshIntervalSec(settings.onlineRefreshIntervalSec)
    if (!this.running) {
      this.startWithInterval(nextIntervalSec)
      return
    }
    if (nextIntervalSec !== this.intervalSec) {
      this.stop()
      this.startWithInterval(nextIntervalSec)
    }
  }

  /** 启动巡检（按当前设置间隔）。重复调用安全。 */
  start(): void {
    if (this.running) return
    this.startWithInterval(resolveRefreshIntervalSec(this.getSettings().onlineRefreshIntervalSec))
  }

  private startWithInterval(intervalSec: number): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.intervalSec = intervalSec
    this.tickCounter = 0
    this.timer = setInterval(() => this.tick(), intervalSec * 1000)
    this.running = true
    log.info('在线状态巡检已启动', { intervalSec })
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.running) {
      this.running = false
      log.info('在线状态巡检已停止')
    }
    this.tickCounter = 0
  }

  /** 定时器节拍：失焦时每 UNFOCUSED_SKIP_FACTOR 拍才真正探测一次。 */
  private tick(): void {
    this.tickCounter += 1
    if (!this.focused && this.tickCounter % UNFOCUSED_SKIP_FACTOR !== 0) return
    void this.runRound()
  }

  /** 执行一轮巡检；所有异常在内部消化，绝不让定时器回调抛出未捕获错误。 */
  private async runRound(): Promise<void> {
    if (this.inFlight) return
    this.inFlight = true
    const checkedAt = new Date().toISOString()
    try {
      const targets = this.getTargets()
      // before 取当轮探测前的库内状态，与 setDeviceOnlineBatch 的比较基准一致，
      // 这样推送的翻转事件与实际落盘的翻转行严格对应。
      const before = new Map<string, boolean>()
      for (const row of this.getStore().listDevices()) {
        before.set(row.ip, row.online === 1)
      }

      const after = new Map<string, boolean>()
      for (const batch of chunkTargets(targets, DEFAULT_PROBE_CONCURRENCY)) {
        const results = await Promise.all(
          batch.map(async (target) => {
            try {
              const result = await probePort(target.ip, target.port)
              return { ip: target.ip, online: result.reachable }
            } catch (error) {
              // 单个目标失败按离线处理，记录结构化日志后继续，不影响其余目标。
              log.warn('单目标在线探测失败，按离线处理', {
                ip: target.ip,
                port: target.port,
                error: error instanceof Error ? error.message : String(error)
              })
              return { ip: target.ip, online: false }
            }
          })
        )
        for (const result of results) {
          // 同一 IP 多个端口时，任一可达即视为在线。
          if (!after.has(result.ip) || result.online) after.set(result.ip, result.online)
        }
      }

      const updates = [...after].map(([ip, online]) => ({ ip, online }))
      // 落盘失败时不推送翻转：否则 UI 显示在线/离线，但重启后回退到旧状态，
      // 界面与持久化短期矛盾，用户会看到「状态自己跳回去」。
      let persisted = false
      try {
        this.getStore().setDeviceOnlineBatch(updates)
        persisted = true
      } catch (error) {
        log.error('批量写入在线状态失败，本轮不推送状态变化', {
          error: error instanceof Error ? error.message : String(error)
        })
      }

      const flipped = diffOnlineStatus(before, after)
      if (persisted) {
        for (const ip of flipped) {
          try {
            this.onStatusChange({ ip, online: after.get(ip) ?? false, checkedAt })
          } catch (error) {
            log.error('推送在线状态变化失败', {
              ip,
              error: error instanceof Error ? error.message : String(error)
            })
          }
        }
      }
      log.event({
        level: 'INFO',
        event: 'online.round',
        context: {
          targets: targets.length,
          online: [...after.values()].filter(Boolean).length,
          flipped: flipped.length,
          focused: this.focused
        }
      })
    } catch (error) {
      // 读取目标 / 遍历设备列表等整体异常：记录后静默，等待下一轮重试。
      log.error('在线状态巡检轮次异常', {
        error: error instanceof Error ? error.message : String(error)
      })
    } finally {
      this.inFlight = false
    }
  }
}
