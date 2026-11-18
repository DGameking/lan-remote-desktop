import { randomUUID } from 'node:crypto'
import type { ConnectRequest, ConnectResult, SessionRecord, SessionStatus } from '../../shared/types'
import { logger } from '../logger'
import { getAdapter } from '../protocols/registry'
import { decryptPassword } from '../store/crypto'
import { getStore, now, rowToDevice } from '../store'

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
      return { ok: true, message, sessionId, launched: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      record.status = 'failed'
      record.endedAt = now()
      record.errorMessage = message
      getStore().updateSession(record)
      this.state = 'failed'
      this.current = record
      logger.error('连接失败', { sessionId, message })
      return { ok: false, message, sessionId, launched: false }
    }
  }
}
