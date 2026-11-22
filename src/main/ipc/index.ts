import { randomUUID } from 'node:crypto'
import { app, ipcMain, shell, type BrowserWindow } from 'electron'
import {
  IPC_CHANNELS,
  PROTOCOL_PRECHECK_PORT,
  type AppStatus,
  type CredentialView,
  type IpcResponse,
  type ServerLinkResult,
  type WakeResult
} from '../../shared/types'
import type { ScanManager } from '../discovery/manager'
import { probePortWithRetry } from '../discovery/precheck'
import { detectSubnets } from '../discovery/subnet'
import { broadcastForCidr, sendWakeOnLan } from '../discovery/wol'
import { logger, scopedLogger } from '../logger'
import {
  collectDiagnosticsInput,
  exportDiagnosticsBundle,
  readRecentLogs,
  recordScanFinished
} from '../observability/collector'
import { buildDiagnosticsSnapshot } from '../observability/diagnostics'
import { filterLogEntries } from '../observability/query'
import { openFileShare } from '../protocols/fileshare'
import { getAvailability, isProtocolId } from '../protocols/registry'
import { buildManageUrl } from '../protocols/serverlink'
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
  validateLogQuery,
  validateServerLinkTarget,
  validateSettingsPatch,
  validateWakeTarget
} from './validators'

function errorResponse(context: string, error: unknown): IpcResponse<never> {
  const message = error instanceof Error ? error.message : String(error)
  logger.error(`IPC ${context} 失败`, message)
  return fail(message)
}

/** 端口不可达时按端口给出可执行的排查提示，避免用户只看到"连不上"。 */
function precheckFailureHint(port: number): string {
  if (port === 3389) return '被控端可能未开启远程桌面/非专业版/防火墙拦截，请检查后再试。'
  if (port >= 5900 && port <= 5910) return '被控端可能未开启屏幕共享/VNC，请检查后再试。'
  if (port === 22) return '被控端 SSH 服务未开启，请检查后再试。'
  return '端口未响应，请确认被控端已开启对应服务或检查防火墙。'
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
          // rustdesk 走 21116/中继，TCP 探测无意义，返回 skipped 语义（UI 不应显示为「不可达」）
          return ok(
            { ip: rawIp, port: 0, reachable: false, latencyMs: 0, skipped: true },
            '该协议跳过端口预检'
          )
        }
        const result = await probePortWithRetry(rawIp, port)
        // 事件链埋点：IP 交给 scopedLogger 内部 redact 统一处理，此处只传原始值
        scopedLogger('ipc').event({
          level: 'INFO',
          event: 'precheck.done',
          context: {
            ip: rawIp,
            port,
            reachable: result.reachable,
            latencyMs: result.latencyMs,
            skipped: result.skipped ?? false
          }
        })
        return result.reachable ? ok(result) : ok(result, precheckFailureHint(port))
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

  // 诊断快照：采集本机运行状态（零遥测、绝不含凭据 / 路径 / MAC）
  ipcMain.handle(IPC_CHANNELS.APP_GET_DIAGNOSTICS, async (): Promise<IpcResponse> => {
    try {
      return ok(
        buildDiagnosticsSnapshot(
          await collectDiagnosticsInput({ getSessionState: () => sessionManager.getStatus().state })
        )
      )
    } catch (error) {
      return errorResponse('app:getDiagnostics', error)
    }
  })

  // 诊断包导出：全程本机读写，绝不上传
  ipcMain.handle(IPC_CHANNELS.APP_EXPORT_DIAGNOSTICS, async (): Promise<IpcResponse> => {
    try {
      return ok(await exportDiagnosticsBundle(), '诊断包已导出到本机，可直接复制文本反馈')
    } catch (error) {
      return errorResponse('app:exportDiagnostics', error)
    }
  })

  // 本地日志查询：入参经白名单校验后再过滤，limit 有硬上限
  ipcMain.handle(IPC_CHANNELS.LOG_QUERY, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const query = validateLogQuery(payload)
      return ok(filterLogEntries(readRecentLogs(), query))
    } catch (error) {
      return errorResponse('log:query', error)
    }
  })

  // 内网管理页：防 SSRF 白名单必须取自主进程 store 中该设备真实 detectedPorts，
  // 渲染层只传单个目标 port；URL 由主进程生成后交给系统默认浏览器打开。
  ipcMain.handle(IPC_CHANNELS.SERVER_OPEN, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const { ip, port } = validateServerLinkTarget(payload)
      const device = getStore()
        .listDevices()
        .map(rowToDevice)
        .find((item) => item.ip === ip)
      const detectedPorts = device?.detectedPorts ?? []
      const built = buildManageUrl({ ip, port, detectedPorts })
      if (!built.ok || !built.url) return fail(built.message)
      await shell.openExternal(built.url)
      const result: ServerLinkResult = { ok: true, message: built.message, url: built.url }
      return ok(result)
    } catch (error) {
      return errorResponse('server:open', error)
    }
  })

  // 远程唤醒：广播地址只由主进程依据本机网段生成，绝不接受渲染层传入；
  // 返回与日志都不写 MAC（sendWakeOnLan 的 message 只含广播地址）。
  ipcMain.handle(IPC_CHANNELS.DEVICE_WAKE, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const { mac } = validateWakeTarget(payload)
      const cidr = detectSubnets()[0]?.cidr
      const broadcast = cidr ? (broadcastForCidr(cidr) ?? '255.255.255.255') : '255.255.255.255'
      const sent = await sendWakeOnLan({ mac, broadcast })
      const result: WakeResult = { ok: sent.ok, message: sent.message, broadcast: sent.broadcast }
      return ok(result)
    } catch (error) {
      return errorResponse('device:wake', error)
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

  // 扫描进度由主进程主动推送，使用独立事件通道；同时缓存最近一次扫描统计供诊断快照使用
  scanManager.setOnProgress((progress) => {
    recordScanFinished(progress)
    getWindow()?.webContents.send(IPC_CHANNELS.DISCOVERY_PROGRESS, progress)
  })
}
