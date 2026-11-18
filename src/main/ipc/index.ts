import { randomUUID } from 'node:crypto'
import { app, ipcMain, type BrowserWindow } from 'electron'
import {
  IPC_CHANNELS,
  type AppStatus,
  type CredentialView,
  type IpcResponse
} from '../../shared/types'
import type { ScanManager } from '../discovery/manager'
import { probePort } from '../discovery/precheck'
import { detectSubnets } from '../discovery/subnet'
import { logger } from '../logger'
import { openFileShare } from '../protocols/fileshare'
import { getAvailability, isProtocolId } from '../protocols/registry'
import { PROTOCOL_PRECHECK_PORT } from '../../shared/types'
import type { SessionManager } from '../session/manager'
import { encryptPassword } from '../store/crypto'
import { deviceToRow, getSettings, getStore, now, rowToDevice, saveSettings } from '../store'
import {
  fail,
  isValidIp,
  ok,
  validateConnectRequest,
  validateCredentialInput,
  validateDevice,
  validateFileTransferTarget,
  validateId,
  validateSettingsPatch
} from './validators'

function errorResponse(context: string, error: unknown): IpcResponse<never> {
  const message = error instanceof Error ? error.message : String(error)
  logger.error(`IPC ${context} 失败`, message)
  return fail(message)
}

/** 注册全部 IPC handler。所有 renderer 入参都经过 validators 校验。 */
export function registerIpc(
  getWindow: () => BrowserWindow | null,
  scanManager: ScanManager,
  sessionManager: SessionManager
): void {
  ipcMain.handle(IPC_CHANNELS.DISCOVERY_START, async (): Promise<IpcResponse> => {
    try {
      if (scanManager.isScanning) return fail('扫描正在进行中')
      return ok(await scanManager.start())
    } catch (error) {
      return errorResponse('discovery:start', error)
    }
  })

  ipcMain.handle(IPC_CHANNELS.DISCOVERY_STOP, async (): Promise<IpcResponse> => {
    scanManager.stop()
    return ok(true, '已发送停止扫描请求')
  })

  ipcMain.handle(IPC_CHANNELS.DEVICE_LIST, async (): Promise<IpcResponse> => {
    try {
      return ok(getStore().listDevices().map(rowToDevice))
    } catch (error) {
      return errorResponse('device:list', error)
    }
  })

  ipcMain.handle(IPC_CHANNELS.DEVICE_UPSERT, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const device = validateDevice(payload)
      getStore().upsertDevice(deviceToRow(device))
      return ok(device, '设备已保存')
    } catch (error) {
      return errorResponse('device:upsert', error)
    }
  })

  ipcMain.handle(IPC_CHANNELS.DEVICE_DELETE, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const id = validateId(payload)
      getStore().deleteDevice(id)
      return ok(true, '设备已删除')
    } catch (error) {
      return errorResponse('device:delete', error)
    }
  })

  ipcMain.handle(IPC_CHANNELS.CREDENTIAL_SET, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const input = validateCredentialInput(payload)
      const encrypted = encryptPassword(input.password)
      const existing = getStore()
        .listCredentials()
        .find((item) => item.deviceId === input.deviceId && item.protocol === input.protocol)
      const row = {
        id: existing?.id ?? randomUUID(),
        deviceId: input.deviceId,
        protocol: input.protocol,
        username: input.username,
        encryptedPassword: encrypted,
        createdAt: existing?.createdAt ?? now(),
        updatedAt: now()
      }
      getStore().setCredential(row)
      const view: CredentialView = {
        id: row.id,
        deviceId: row.deviceId,
        protocol: row.protocol,
        username: row.username,
        hasPassword: !!row.encryptedPassword,
        updatedAt: row.updatedAt
      }
      logger.info('凭据已加密保存', { deviceId: input.deviceId, protocol: input.protocol })
      return ok(view, '凭据已使用系统加密保存')
    } catch (error) {
      return errorResponse('credential:set', error)
    }
  })

  ipcMain.handle(IPC_CHANNELS.CREDENTIAL_LIST, async (): Promise<IpcResponse> => {
    try {
      const views: CredentialView[] = getStore().listCredentials().map((row) => ({
        id: row.id,
        deviceId: row.deviceId,
        protocol: row.protocol,
        username: row.username,
        hasPassword: !!row.encryptedPassword,
        updatedAt: row.updatedAt
      }))
      return ok(views)
    } catch (error) {
      return errorResponse('credential:list', error)
    }
  })

  ipcMain.handle(IPC_CHANNELS.CREDENTIAL_DELETE, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      getStore().deleteCredential(validateId(payload))
      return ok(true, '凭据已删除')
    } catch (error) {
      return errorResponse('credential:delete', error)
    }
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_CONNECT, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const result = await sessionManager.connect(validateConnectRequest(payload))
      return ok(result, result.message)
    } catch (error) {
      return errorResponse('session:connect', error)
    }
  })

  // 连接前 TCP 端口预检：只测可达性与延迟，不发送协议数据，帮助用户快速定位"服务未开启"。
  ipcMain.handle(
    IPC_CHANNELS.SESSION_PRECHECK,
    async (_event, rawIp: unknown, rawProtocol: unknown, rawPort: unknown): Promise<IpcResponse> => {
      try {
        if (!isValidIp(rawIp)) throw new Error('目标 IP 格式不合法')
        if (!isProtocolId(rawProtocol)) throw new Error('不支持的协议')
        const fallback = PROTOCOL_PRECHECK_PORT[rawProtocol]
        const port =
          typeof rawPort === 'number' && rawPort > 0 && rawPort <= 65535 ? rawPort : fallback
        if (!port) {
          // rustdesk 走 21116/中继，单纯 TCP 探测无意义，直接返回 skipped 语义（reachable=true 仅供参考）
          return ok({ ip: rawIp, port: 0, reachable: true, latencyMs: 0 }, '该协议跳过端口预检')
        }
        return ok(await probePort(rawIp, port))
      } catch (error) {
        return errorResponse('session:precheck', error)
      }
    }
  )

  ipcMain.handle(IPC_CHANNELS.SESSION_LIST, async (): Promise<IpcResponse> => {
    try {
      return ok(sessionManager.listHistory())
    } catch (error) {
      return errorResponse('session:list', error)
    }
  })

  // 文件传输通道：调起 Windows 资源管理器打开 \\IP\共享名（SMB 原生能力）
  ipcMain.handle(IPC_CHANNELS.FILE_TRANSFER_OPEN, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const target = validateFileTransferTarget(payload)
      const result = await openFileShare(target)
      return ok(result, result.message)
    } catch (error) {
      return errorResponse('file-transfer:open', error)
    }
  })

  ipcMain.handle(IPC_CHANNELS.APP_GET_STATUS, async (): Promise<IpcResponse> => {
    try {
      const protocols = await getAvailability()
      const status: AppStatus = {
        platform: process.platform,
        version: app.getVersion(),
        subnet: detectSubnets()[0]?.cidr ?? '未检测到局域网网卡',
        storeMode: getStore().mode(),
        protocols
      }
      return ok(status)
    } catch (error) {
      return errorResponse('app:getStatus', error)
    }
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, async (): Promise<IpcResponse> => {
    try {
      return ok(getSettings())
    } catch (error) {
      return errorResponse('settings:get', error)
    }
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      return ok(saveSettings(validateSettingsPatch(payload)), '设置已保存')
    } catch (error) {
      return errorResponse('settings:set', error)
    }
  })

  // 扫描进度由主进程主动推送，使用独立事件通道
  scanManager.setOnProgress((progress) => {
    getWindow()?.webContents.send(IPC_CHANNELS.DISCOVERY_PROGRESS, progress)
  })
}
