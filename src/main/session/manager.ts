import { randomUUID } from 'node:crypto'
import type { ConnectRequest, ConnectResult, SessionRecord, SessionStatus } from '../../shared/types'
import { CAPABILITY_MATRIX } from '../../shared/types'
import { logger } from '../logger'
import { getAdapter } from '../protocols/registry'
import { decryptPassword } from '../store/crypto'
import { getSettings, getStore, now, rowToDevice } from '../store'

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

    try {
      // 用户在对话框未填密码时，尝试用已保存的加密凭据（仅在内存中解密一次）
      const resolved: ConnectRequest = { ...request }
      if (!resolved.password && resolved.deviceId) {
        const saved = getStore()
          .listCredentials()
          .find((item) => item.deviceId === resolved.deviceId && item.protocol === resolved.protocol)
        if (saved?.encryptedPassword) {
          try {
            resolved.password = decryptPassword(saved.encryptedPassword)
            // 用户下次不填账号也能直连：把保存的账号一并回填，供 rdp 写入 username:s:
            if (!resolved.username && saved.username) {
              resolved.username = saved.username
            }
          } catch (error) {
            logger.warn('已保存凭据解密失败，将改为提示用户手输', error)
          }
        }
      }

      const message = await getAdapter(request.protocol).connect(resolved)
      record.status = 'connected'
      record.endedAt = now()
      getStore().updateSession(record)
      this.state = 'connected'
      this.current = record
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
      return { ok: false, message, sessionId, launched: false, capabilities: [] }
    }
  }
}
