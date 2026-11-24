import { randomUUID } from 'node:crypto'
import type { ConnectRequest, ConnectResult, SessionRecord, SessionStatus } from '../../shared/types'
import { CAPABILITY_MATRIX } from '../../shared/types'
import { logger, scopedLogger } from '../logger'
import { takeLastLaunchedImageName, takeLastLaunchedPid } from '../protocols/base'
import { getAdapter } from '../protocols/registry'
import { decryptPassword } from '../store/crypto'
import { getSettings, getStore, now, rowToDevice } from '../store'
import { shouldReuseSavedCredential } from './credential-policy'
import { isPidAlive, isProcessByNameAlive } from './process-liveness'

// 保持既有测试/调用方的导入路径兼容；进程检测实现已抽到 process-liveness.ts 供 rdp 清理复用。
export { isPidAlive, taskListCsvShowsPid } from './process-liveness'

/** 外部客户端进程轮询间隔（毫秒） */
const PROCESS_POLL_INTERVAL_MS = 4000
/** 调起后宽限期：mstsc 等客户端启动较慢，10 秒内不做存活判定，避免误回收 */
const PROCESS_START_GRACE_MS = 10000
/** 连续 N 次检测不到进程才判定退出（防 mstsc 单实例启动时的假退出） */
const EXIT_CONFIRM_STREAK = 2

/** startedAt→endedAt 的整秒数；任一时间无效时返回 undefined（UI 应显示"时长不可测"）。 */
export function computeDurationSec(startedAt: string, endedAt: string): number | undefined {
  const start = Date.parse(startedAt)
  const end = Date.parse(endedAt)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined
  const sec = Math.floor((end - start) / 1000)
  return sec >= 0 ? sec : undefined
}

/** 根据协议与本次会话开关，生成能力回显文案 */
function describeCapabilities(request: ConnectRequest): string[] {
  const matrix = CAPABILITY_MATRIX[request.protocol]
  const settings = getSettings()
  const notes: string[] = []
  if (matrix.clipboard.supported) {
    const on = request.clipboardSharing ?? settings.clipboardSharing
    notes.push(`剪贴板共享：${on ? '已开启' : '已关闭'}`)
  }
  if (matrix.fileTransfer.supported && request.protocol === 'rdp') {
    const on = request.driveRedirection ?? settings.driveRedirection
    notes.push(`会话内文件传输（磁盘重定向）：${on ? '已开启' : '已关闭'}`)
  }
  if (matrix.fileTransfer.source === 'client') {
    notes.push('文件传输：在外部客户端窗口内使用')
  }
  return notes
}

/**
 * 把连接异常压缩成有限的分类标签（简短分类），绝不回显原始错误文本 / 堆栈，
 * 避免 IP、临时文件路径、账号等可能的内容进入结构化日志。
 * 仅依据关键字归类，输出恒为下面这几个固定 token 之一。
 */
function classifyConnectError(message: string): string {
  const text = message.toLowerCase()
  if (text.includes('mstsc') || text.includes('rdp')) return 'rdp_launch_failed'
  if (text.includes('vnc')) return 'vnc_launch_failed'
  if (text.includes('rustdesk')) return 'rustdesk_launch_failed'
  if (text.includes('powershell') || text.includes('凭据') || text.includes('credential')) {
    return 'credential_failed'
  }
  if (text.includes('未找到') || text.includes('not found')) return 'client_missing'
  return 'adapter_error'
}

/**
 * 会话状态机 + 连接历史。
 * v1.5-P0-2: 调起外部客户端后进入 connected，轮询其退出后自动 ended 回收；
 * 会话时长按 startedAt→endedAt 计算，PID 不可测时显式标记 durationUnavailable。
 */
export class SessionManager {
  private state: SessionStatus = 'idle'
  private current: SessionRecord | null = null

  /** 调起成功后由 index.ts 注入：隐藏主窗口并退到托盘驻留 */
  private onSessionLaunched?: () => void

  private monitorTimer: ReturnType<typeof setInterval> | null = null
  private monitorPid: number | null = null
  /** v1.7.1: 调起的可执行文件名，PID 失效时按进程名兜底判定会话是否仍在。 */
  private monitorImageName: string | undefined
  private monitorStartedAt = 0
  private missingStreak = 0
  private checking = false

  /** 注入"已调起外部客户端"回调；回调异常被吞掉，绝不影响 connect 结果。 */
  setSessionLaunchedHandler(handler: () => void): void {
    this.onSessionLaunched = handler
  }

  getStatus(): { state: SessionStatus; current: SessionRecord | null } {
    return { state: this.state, current: this.current }
  }

  listHistory(): SessionRecord[] {
    return getStore().listSessions()
  }

  /** 停止进程存活轮询并清空检测状态（不做任何持久化）。 */
  private stopProcessMonitor(): void {
    if (this.monitorTimer !== null) {
      clearInterval(this.monitorTimer)
      this.monitorTimer = null
    }
    this.monitorPid = null
    this.monitorImageName = undefined
    this.monitorStartedAt = 0
    this.missingStreak = 0
    this.checking = false
  }

  /** 调起成功后开始轮询外部进程；PID 无效时不启动（仅由用户/托盘主动结束）。 */
  private startProcessMonitor(pid: number, imageName?: string): void {
    this.stopProcessMonitor()
    if (!Number.isInteger(pid) || pid <= 0) {
      scopedLogger('session').warn('外部进程 PID 无效，跳过自动存活检测，会话将由用户主动结束')
      return
    }
    this.monitorPid = pid
    this.monitorImageName = imageName
    this.monitorStartedAt = Date.now()
    this.missingStreak = 0
    this.monitorTimer = setInterval(() => {
      void this.checkExternalProcess()
    }, PROCESS_POLL_INTERVAL_MS)
    // 轮询句柄不应阻止应用退出
    const timer = this.monitorTimer as unknown as { unref?: () => void }
    timer.unref?.()
  }

  /** 单次存活检测：宽限期内直接跳过；连续两次检测不到才判定进程退出。 */
  private async checkExternalProcess(): Promise<void> {
    if (this.checking) return
    const pid = this.monitorPid
    if (pid === null || this.state !== 'connected') return
    if (Date.now() - this.monitorStartedAt < PROCESS_START_GRACE_MS) return

    this.checking = true
    try {
      let alive = await isPidAlive(pid)
      // v1.7.1: PID 找不到时按进程名兜底。TigerVNC viewer 等 GUI 客户端在认证阶段
      // 可能退出启动进程并派生新 PID，仅看启动 PID 会把仍在显示的窗口误判为已退出
      // （实测会话 16 秒即被 process-exit 回收，但 viewer 认证框仍在）。
      if (!alive && this.monitorImageName) {
        alive = await isProcessByNameAlive(this.monitorImageName)
        if (alive) {
          this.missingStreak = 0
          return
        }
      }
      if (alive) {
        this.missingStreak = 0
        return
      }
      this.missingStreak += 1
      scopedLogger('session').info('外部进程存活检测：本次未找到进程', {
        streak: this.missingStreak,
        required: EXIT_CONFIRM_STREAK
      })
      if (this.missingStreak >= EXIT_CONFIRM_STREAK) {
        this.endSession('process-exit')
      }
    } catch (error) {
      // 检测命令异常时按"仍存活"处理，宁可不回收也不误结束用户会话
      scopedLogger('session').warn('外部进程存活检测异常，本次忽略', error)
    } finally {
      this.checking = false
    }
  }

  /**
   * v1.5-P0-2: 主动结束当前会话并回收状态。
   * @param reason 'manual'（UI/托盘主动）或 'process-exit'（检测到外部客户端退出）
   */
  endSession(reason: 'manual' | 'process-exit' = 'manual'): boolean {
    const log = scopedLogger('session')
    if (this.state === 'idle' || !this.current) return false
    // failed 是终态：连接失败记录必须保留 failed 供历史/诊断，不能被"结束会话"改写成 ended。
    // 调起失败时本就没有存活进程可回收，直接短路即可。
    if (this.state === 'failed') return false
    const record = this.current
    this.stopProcessMonitor()

    const endedAt = now()
    const durationSec = computeDurationSec(record.startedAt, endedAt)
    const pid = record.externalPid
    const hasValidPid = typeof pid === 'number' && Number.isInteger(pid) && pid > 0
    // 无有效 PID 或时间不可解析时不写 0，显式标记"不可测"，避免 UI 误显示"0 秒"
    const durationUnavailable = !hasValidPid || durationSec === undefined

    const ended: SessionRecord = {
      ...record,
      status: 'ended',
      endedAt,
      ...(durationSec !== undefined ? { durationSec } : {}),
      ...(durationUnavailable ? { durationUnavailable: true } : {})
    }
    getStore().updateSession(ended)
    this.state = 'idle'
    this.current = null

    log.event({
      level: 'INFO',
      event: 'session.ended',
      traceId: record.id,
      context: {
        reason,
        protocol: record.protocol,
        hasPid: hasValidPid,
        durationSec: durationSec ?? null,
        durationUnavailable
      }
    })
    return true
  }

  async connect(request: ConnectRequest): Promise<ConnectResult> {
    // in-flight 去重：连接串行化，避免重复点击并发拉起多个外部客户端
    if (this.state === 'connecting') {
      throw new Error('已有连接正在进行中，请勿重复点击')
    }
    // 上一条仍 connected 的会话先回收（含停止旧轮询），防止多个监听器并存
    if (this.state === 'connected') this.endSession('manual')

    const sessionId = randomUUID()
    const t0 = Date.now()
    const traceId = sessionId
    // 函数内取得 logger：避免模块顶层调用（并行 worker 的导出可能尚未落盘，且便于单测隔离）
    const log = scopedLogger('session')
    const deviceRow = getStore().listDevices().find((row) => row.id === request.deviceId)
    const deviceName = deviceRow ? rowToDevice(deviceRow).name : request.ip

    const record: SessionRecord = {
      id: sessionId,
      deviceId: request.deviceId,
      deviceName,
      protocol: request.protocol,
      status: 'connecting',
      startedAt: now(),
      endedAt: '',
      errorMessage: '',
      // 本地会话元数据：设备被删除后历史仍可用此 ip 一键重连
      ip: request.ip
    }
    getStore().addSession(record)
    this.state = 'connecting'
    this.current = record
    logger.info('发起连接', { sessionId, ip: request.ip, protocol: request.protocol })

    // 事件链起点：只放非敏感的连接元数据（protocol / port / deviceId / hasPassword），
    // 绝不写入 password、username、ip 原文、DPAPI hex。
    log.event({
      level: 'INFO',
      event: 'connect.start',
      traceId,
      context: {
        protocol: request.protocol,
        port: request.port ?? null,
        deviceId: request.deviceId,
        hasPassword: !!request.password,
        // 端口预检摘要：只放非敏感的连通性元数据，不写 ip 原文
        ...(request.precheck
          ? {
              precheck: {
                port: request.precheck.port,
                reachable: request.precheck.reachable,
                latencyMs: request.precheck.latencyMs,
                skipped: request.precheck.skipped ?? false
              }
            }
          : {})
      }
    })

    try {
      // 用户在对话框未填密码时，尝试用已保存的加密凭据（仅在内存中解密一次）
      const resolved: ConnectRequest = { ...request }
      let reused = false
      if (!resolved.password && resolved.deviceId) {
        const saved = getStore()
          .listCredentials()
          .find((item) => item.deviceId === resolved.deviceId && item.protocol === resolved.protocol)
        if (saved?.encryptedPassword) {
          // 此处已限定「未填密码」且「存在已存密码」，故该纯函数返回 false
          // 恰好等价于「用户改了用户名且与已存账号不一致」这一误回填场景。
          const reuse = shouldReuseSavedCredential({
            inputUsername: resolved.username,
            inputPassword: resolved.password,
            savedUsername: saved.username,
            hasSavedPassword: !!saved.encryptedPassword
          })
          if (reuse) {
            try {
              resolved.password = await decryptPassword(saved.encryptedPassword)
              // 用户下次不填账号也能直连：把保存的账号一并回填，供 rdp 写入 username:s:
              if (!resolved.username && saved.username) {
                resolved.username = saved.username
              }
              reused = true
            } catch (error) {
              logger.warn('已保存凭据解密失败，将改为提示用户手输', error)
            }
          } else {
            // 用户改了用户名但密码留空：绝不把旧账号的密码注入新用户名，提示手动输入。
            // 不记用户名（含账号信息），仅记这条决策本身。
            log.warn('跳过已保存凭据回填：本次用户名与已存账号不一致，请手动输入密码')
          }
        }
      }

      log.event({
        level: 'INFO',
        event: 'credential.resolved',
        traceId,
        context: { reused }
      })

      // 先清空可能残留的 PID/进程名（如之前的文件传输调起），确保取到的是本次调起的进程。
      takeLastLaunchedPid()
      takeLastLaunchedImageName()
      const message = await getAdapter(request.protocol).connect(resolved)
      const launchedPid = takeLastLaunchedPid()
      const launchedImageName = takeLastLaunchedImageName()
      if (typeof launchedPid === 'number' && Number.isInteger(launchedPid) && launchedPid > 0) {
        record.externalPid = launchedPid
      }
      record.status = 'connected'
      // v1.5: 不再于"已调起"时写 endedAt，否则 startedAt→endedAt 时长恒为 0。
      record.endedAt = ''
      getStore().updateSession(record)
      this.state = 'connected'
      this.current = record
      this.startProcessMonitor(launchedPid ?? 0, launchedImageName)

      // 调起成功后退到托盘驻留（回调由 index.ts 注入；异常不影响连接结果）
      try {
        this.onSessionLaunched?.()
      } catch (error) {
        logger.warn('会话调起后的托盘隐藏回调执行失败', error)
      }

      log.event({
        level: 'INFO',
        event: 'connect.launched',
        traceId,
        context: {
          protocol: request.protocol,
          ok: true,
          durationMs: Date.now() - t0
        }
      })
      return { ok: true, message, sessionId, launched: true, capabilities: describeCapabilities(resolved) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.stopProcessMonitor()
      record.status = 'failed'
      record.endedAt = now()
      record.errorMessage = message
      getStore().updateSession(record)
      this.state = 'failed'
      this.current = record
      logger.error('连接失败', { sessionId, message })

      log.event({
        level: 'ERROR',
        event: 'connect.failed',
        traceId,
        context: {
          protocol: request.protocol,
          ok: false,
          durationMs: Date.now() - t0,
          errorMessageRedacted: classifyConnectError(message)
        }
      })
      return { ok: false, message, sessionId, launched: false, capabilities: [] }
    }
  }
}
