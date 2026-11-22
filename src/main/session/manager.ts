import { randomUUID } from 'node:crypto'
import type { ConnectRequest, ConnectResult, SessionRecord, SessionStatus } from '../../shared/types'
import { CAPABILITY_MATRIX } from '../../shared/types'
import { logger, scopedLogger } from '../logger'
import { getAdapter } from '../protocols/registry'
import { decryptPassword } from '../store/crypto'
import { getSettings, getStore, now, rowToDevice } from '../store'
import { shouldReuseSavedCredential } from './credential-policy'

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

/** 会话状态机 + 连接历史。外部客户端一旦调起即视为 connected，本应用不接管远端会话生命周期。 */
export class SessionManager {
  private state: SessionStatus = 'idle'
  private current: SessionRecord | null = null

  getStatus(): { state: SessionStatus; current: SessionRecord | null } {
    return { state: this.state, current: this.current }
  }

  listHistory(): SessionRecord[] {
    return getStore().listSessions()
  }

  async connect(request: ConnectRequest): Promise<ConnectResult> {
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
      errorMessage: ''
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
              resolved.password = decryptPassword(saved.encryptedPassword)
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

      const message = await getAdapter(request.protocol).connect(resolved)
      record.status = 'connected'
      record.endedAt = now()
      getStore().updateSession(record)
      this.state = 'connected'
      this.current = record

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
