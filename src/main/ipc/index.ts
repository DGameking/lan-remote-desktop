import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { app, dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import {
  IPC_CHANNELS,
  PROTOCOL_PRECHECK_PORT,
  type AppStatus,
  type CredentialView,
  type Device,
  type ExportData,
  type IpcResponse,
  type ImportResult,
  type ServerLinkResult,
  type SubnetView,
  type WakeResult
} from '../../shared/types'
import type { ScanManager } from '../discovery/manager'
import { probePort, probePortWithRetry, runFullPrecheck } from '../discovery/precheck'
import { detectSubnets } from '../discovery/subnet'
import { broadcastForCidr, sendWakeOnLan } from '../discovery/wol'
import { logger, scopedLogger } from '../logger'
import { OnlineMonitor } from '../scheduler/online-monitor'
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
import {
  deviceToRow,
  getSettings,
  getStore,
  latencyRowToRecord,
  now,
  rowToDevice,
  saveSettings,
  type DeviceRow,
  type LatencyRow
} from '../store'
import {
  fail,
  isValidIp,
  ok,
  validateConnectRequest,
  validateCredentialInput,
  validateDevice,
  validateDeviceMetaInput,
  validateExportData,
  validateFileTransferTarget,
  validateId,
  validateLatencyListIp,
  validateLatencyMeasure,
  validateLogQuery,
  validateServerLinkTarget,
  validateSessionNote,
  validateSettingsPatch,
  validateTargetCidr,
  validateDeviceSetOs,
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

/** registerIpc 返回的调度器句柄；main/index.ts 在 before-quit 中调用 disposeSchedulers 清理定时器。 */
export interface IpcSchedulerHandle {
  disposeSchedulers(): void
}

/**
 * v1.7: 每台设备选一个用于在线探测的端口：
 * 优先 detectedPorts 中的 3389 或 5900-5910，否则按协议回退（vnc→5900，其余→3389）。
 */
function pickOnlineProbePort(device: Device): number {
  const preferred = (device.detectedPorts ?? []).find(
    (port) => port === 3389 || (port >= 5900 && port <= 5910)
  )
  if (preferred !== undefined) return preferred
  return device.availableProtocols.includes('vnc') ? 5900 : 3389
}

/** 读取自动扫描分钟数：容忍字符串并收敛到 0（关闭）或 >=1 分钟。 */
function resolveAutoScanMinutes(raw: unknown): number {
  const value = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.max(1, Math.trunc(value))
}

/** 注册全部 IPC handler。所有 renderer 入参都经过 validators 校验。 */
export function registerIpc(
  getWindow: () => BrowserWindow | null,
  scanManager: ScanManager,
  sessionManager: SessionManager
): IpcSchedulerHandle {
  // v1.7: 在线状态巡检器。目标端口在每轮动态读取设备列表，避免缓存导致的陈旧探测。
  const onlineMonitor = new OnlineMonitor({
    getTargets: () =>
      getStore()
        .listDevices()
        .map(rowToDevice)
        .map((device) => ({ ip: device.ip, port: pickOnlineProbePort(device) })),
    onStatusChange: (event) => {
      getWindow()?.webContents.send(IPC_CHANNELS.ONLINE_STATUS_CHANGED, event)
    },
    getSettings,
    getStore
  })

  // 窗口焦点联动：失焦降频、回焦恢复全频。app 级事件无需等待 BrowserWindow 创建。
  const onWindowFocus = (): void => onlineMonitor.setWindowFocused(true)
  const onWindowBlur = (): void => onlineMonitor.setWindowFocused(false)
  app.on('browser-window-focus', onWindowFocus)
  app.on('browser-window-blur', onWindowBlur)

  // v1.7: 定时自动扫描。扫描进行中（含手动扫描）跳过，避免并发扫描互相踩踏。
  let autoScanTimer: ReturnType<typeof setInterval> | null = null
  let autoScanMinutes = 0
  const applyAutoScan = (): void => {
    const minutes = resolveAutoScanMinutes(getSettings().autoScanIntervalMin)
    if (minutes <= 0) {
      if (autoScanTimer !== null) clearInterval(autoScanTimer)
      autoScanTimer = null
      autoScanMinutes = 0
      return
    }
    if (autoScanTimer !== null && minutes === autoScanMinutes) return
    if (autoScanTimer !== null) clearInterval(autoScanTimer)
    autoScanMinutes = minutes
    autoScanTimer = setInterval(() => {
      if (scanManager.isScanning) return
      void scanManager.start().catch((error: unknown) => {
        logger.warn('定时自动扫描失败', error)
      })
    }, minutes * 60 * 1000)
  }

  // 设置变更后统一刷新调度器（在线巡检启停/间隔 + 自动扫描重建）。
  const applySchedulers = (): void => {
    onlineMonitor.applySettings()
    applyAutoScan()
  }
  // 启动时按已保存设置决定是否开启（默认在线刷新关闭、自动扫描关闭）。
  applySchedulers()

  ipcMain.handle(IPC_CHANNELS.DISCOVERY_START, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      if (scanManager.isScanning) return fail('扫描正在进行中')
      const targetCidr = validateTargetCidr(payload)
      return ok(await scanManager.start(targetCidr))
    } catch (error) {
      return errorResponse('discovery:start', error)
    }
  })

  ipcMain.handle(IPC_CHANNELS.DISCOVERY_STOP, async (): Promise<IpcResponse> => {
    scanManager.stop()
    return ok(true, '已发送停止扫描请求')
  })

  // v1.4-A: 列出所有网卡网段，UI 展示主网段/虚拟网卡并允许手动选择扫描目标。
  ipcMain.handle(IPC_CHANNELS.DISCOVERY_SUBNETS, async (): Promise<IpcResponse> => {
    try {
      const views: SubnetView[] = detectSubnets().map((s) => ({
        cidr: s.cidr,
        ip: s.ip,
        kind: s.kind ?? 'physical',
        isPrimary: s.isPrimary === true,
        iface: s.iface ?? '',
        hostCount: s.hosts.length
      }))
      return ok(views)
    } catch (error) {
      return errorResponse('discovery:subnets', error)
    }
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

  // v1.4-B: 手动指定系统类型。写入 osManual 锁，后续扫描不再自动覆盖；返回更新后的设备。
  ipcMain.handle(
    IPC_CHANNELS.DEVICE_SET_OS,
    async (_event, deviceId: unknown, osHint: unknown): Promise<IpcResponse> => {
      try {
        const input = validateDeviceSetOs(deviceId, osHint)
        const store = getStore()
        const row = store.listDevices().find((item) => item.id === input.deviceId)
        if (!row) return fail('设备不存在，请先扫描或手动添加')
        const updated = {
          ...row,
          osHint: input.osHint,
          osConfidence: 'high' as const,
          osEvidence: JSON.stringify([
            { source: 'manual', osHint: input.osHint, detail: '用户手动指定的系统类型（扫描不再覆盖）' }
          ]),
          osManual: 1,
          updatedAt: now()
        }
        store.upsertDevice(updated)
        return ok(rowToDevice(updated), '系统类型已更新，后续扫描将保留此设置')
      } catch (error) {
        return errorResponse('device:setOs', error)
      }
    }
  )

  ipcMain.handle(IPC_CHANNELS.CREDENTIAL_SET, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const input = validateCredentialInput(payload)
      const encrypted = await encryptPassword(input.password)
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
        // v1.5-P0-4: 用完整预检（TCP 端口 + ICMP 存活）产出三类可执行结论
        const result = await runFullPrecheck(rawIp, rawProtocol, port)
        // 事件链埋点：IP 交给 scopedLogger 内部 redact 统一处理，此处只传原始值；
        // 结论为枚举 token（无用户数据），可安全入日志供诊断证据回流。
        scopedLogger('ipc').event({
          level: 'INFO',
          event: 'precheck.done',
          context: {
            ip: rawIp,
            port,
            reachable: result.reachable,
            latencyMs: result.latencyMs,
            skipped: result.skipped ?? false,
            conclusion: result.conclusion ?? 'unknown',
            icmpReachable: result.icmpReachable ?? null
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

  // v1.5-P0-2: 主动结束当前会话并回收（托盘/UI 共用）
  ipcMain.handle(IPC_CHANNELS.SESSION_END, async (): Promise<IpcResponse> => {
    try {
      const ended = sessionManager.endSession()
      return ok(ended, ended ? '会话已结束' : '当前没有进行中的会话')
    } catch (error) {
      return errorResponse('session:end', error)
    }
  })

  // v1.5-P0-3: 清空连接历史（对应 REQ-009）
  ipcMain.handle(IPC_CHANNELS.SESSION_CLEAR, async (): Promise<IpcResponse> => {
    try {
      getStore().clearSessions()
      return ok(true, '连接历史已清空')
    } catch (error) {
      return errorResponse('session:clear', error)
    }
  })

  // v1.5-P0-2: 托盘"回到主控"唤出主窗口
  ipcMain.handle(IPC_CHANNELS.APP_SHOW, async (): Promise<IpcResponse> => {
    try {
      const win = getWindow()
      if (!win) return ok(false, '主窗口尚未就绪')
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      return ok(true)
    } catch (error) {
      return errorResponse('app:show', error)
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
      // v1.5-P1 纵深防御：detectedPorts 可由渲染层 upsert 写入，信任锚不绝对。
      // 打开前由主进程实时 TCP 探测该 IP:port，确认服务确实存活，堵住"伪造端口借道打开"的 SSRF 变体。
      const live = await probePortWithRetry(ip, port)
      if (!live.reachable) {
        return fail('该管理端口当前未响应，已拒绝打开（可能是设备已离线或端口记录已过期）')
      }
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
      const saved = saveSettings(validateSettingsPatch(payload))
      // v1.7: 设置成功后立即让调度器生效（启停在线巡检 / 重建自动扫描定时器）。
      applySchedulers()
      return ok(saved, '设置已保存')
    } catch (error) {
      return errorResponse('settings:set', error)
    }
  })

  // v1.6: 设备元数据更新（收藏/置顶/别名/分组），原地写入，不触碰扫描所得字段。
  ipcMain.handle(IPC_CHANNELS.DEVICE_UPDATE_META, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const input = validateDeviceMetaInput(payload)
      const patch: Partial<Pick<DeviceRow, 'favorite' | 'pinned' | 'alias' | 'group'>> = {}
      if (input.favorite !== undefined) patch.favorite = input.favorite ? 1 : 0
      if (input.pinned !== undefined) patch.pinned = input.pinned ? 1 : 0
      if (input.alias !== undefined) patch.alias = input.alias
      if (input.group !== undefined) patch.group = input.group
      const row = getStore().updateDeviceMeta(input.deviceId, patch)
      if (!row) return fail('设备不存在，请先扫描或手动添加')
      logger.info('设备元数据已更新', { fields: Object.keys(patch) })
      return ok(rowToDevice(row), '设备信息已更新')
    } catch (error) {
      return errorResponse('device:updateMeta', error)
    }
  })

  // v1.6: 会话备注更新（纯本地）。
  ipcMain.handle(
    IPC_CHANNELS.SESSION_SET_NOTE,
    async (_event, sessionId: unknown, note: unknown): Promise<IpcResponse> => {
      try {
        const input = validateSessionNote(sessionId, note)
        if (!getStore().setSessionNote(input.id, input.note)) return fail('会话记录不存在或已清空')
        return ok(true, '会话备注已保存')
      } catch (error) {
        return errorResponse('session:setNote', error)
      }
    }
  )

  // v1.6: 导出设备与设置为本机 JSON 文件。
  // 安全边界：绝不导出 credentials —— 其密文由 DPAPI 绑定本机本用户，换机无法解密且泄露风险高。
  ipcMain.handle(IPC_CHANNELS.DATA_EXPORT, async (): Promise<IpcResponse> => {
    try {
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
      const { canceled, filePath } = await dialog.showSaveDialog({
        title: '导出 LanDesk 数据',
        defaultPath: `landesk-backup-${stamp}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }]
      })
      if (canceled || !filePath) return fail('已取消导出')
      const data: ExportData = {
        format: 'landesk-backup',
        version: 1,
        exportedAt: new Date().toISOString(),
        devices: getStore().listDevices().map(rowToDevice),
        settings: getSettings()
      }
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8')
      logger.info('数据已导出', { deviceCount: data.devices.length })
      return ok(filePath, '数据已导出到本机（不含凭据）')
    } catch (error) {
      return errorResponse('data:export', error)
    }
  })

  // v1.6: 从用户选择的 JSON 导入。文件内容一律视为不可信数据：只做白名单解析与字段校验，
  // 绝不执行其中任何路径/命令，也不读取凭据字段。
  ipcMain.handle(
    IPC_CHANNELS.DATA_IMPORT,
    async (_event, includeSettings: unknown): Promise<IpcResponse> => {
      try {
        const { canceled, filePaths } = await dialog.showOpenDialog({
          title: '导入 LanDesk 数据',
          properties: ['openFile'],
          filters: [{ name: 'JSON', extensions: ['json'] }]
        })
        if (canceled || filePaths.length === 0) return fail('已取消导入')
        const file = filePaths[0]
        if (!file || path.extname(file).toLowerCase() !== '.json') {
          throw new Error('仅支持导入 .json 备份文件')
        }
        // JSON.parse 只产生纯数据；随后经 validateExportData 白名单校验后才使用。
        const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
        const imported = validateExportData(parsed)
        const store = getStore()
        const existing = store.listDevices()
        const existingById = new Map(existing.map((item) => [item.id, item]))
        const existingByIp = new Map(existing.map((item) => [item.ip, item]))
        const seenIds = new Set<string>()
        const seenIps = new Set<string>()
        let added = 0
        let updated = 0
        let skipped = 0
        for (const device of imported.devices) {
          const row = deviceToRow(device)
          // 备份包内部重复：直接跳过，避免重复计数或覆盖。
          if (seenIds.has(row.id) || seenIps.has(row.ip)) {
            skipped++
            continue
          }
          seenIds.add(row.id)
          seenIps.add(row.ip)
          const dup = existingById.get(row.id) ?? existingByIp.get(row.ip)
          if (dup) {
            // v1.10 P0 修复：本地已存在的设备必须以本地行为基底，
            // 只把备份中非空的显示名带过来。此前用 {...row} 覆盖会把本地的
            // osHint/osEvidence/已发现端口/在线状态/延迟一并清掉——备份导入变成数据丢失。
            store.upsertDevice({
              ...dup,
              name: row.name || dup.name,
              updatedAt: now()
            })
            updated++
          } else {
            store.upsertDevice(row)
            added++
          }
        }
        let settingsImported = false
        if (includeSettings === true) {
          // telemetryConsent 由 saveSettings/getSettings 统一强制为 false，无需在此处理。
          saveSettings(imported.settings)
          settingsImported = true
          // v1.7: 设置随备份导入后同样刷新调度器，避免旧的启停状态残留。
          applySchedulers()
        }
        const result: ImportResult = { added, updated, skipped, settingsImported }
        logger.info('数据导入完成', { added, updated, skipped, settingsImported })
        return ok(result, `导入完成：新增 ${added}，更新 ${updated}，跳过 ${skipped}`)
      } catch (error) {
        return errorResponse('data:import', error)
      }
    }
  )

  // v1.7: 延迟测速。探测一次 TCP 端口并把结果落库，返回契约记录（0/1 归一为 boolean）。
  ipcMain.handle(
    IPC_CHANNELS.LATENCY_MEASURE,
    async (_event, rawIp: unknown, rawPort: unknown): Promise<IpcResponse> => {
      try {
        const { ip, port } = validateLatencyMeasure(rawIp, rawPort)
        const result = await probePort(ip, port)
        const row: LatencyRow = {
          id: randomUUID(),
          ip,
          port,
          latencyMs: result.latencyMs,
          reachable: result.reachable ? 1 : 0,
          measuredAt: now()
        }
        getStore().addLatency(row)
        scopedLogger('ipc').event({
          level: 'INFO',
          event: 'latency.measure',
          context: { ip, port, reachable: result.reachable, latencyMs: result.latencyMs }
        })
        return ok(latencyRowToRecord(row))
      } catch (error) {
        return errorResponse('latency:measure', error)
      }
    }
  )

  // v1.7: 延迟历史查询（可选按 IP 过滤，最多 100 条）。
  ipcMain.handle(IPC_CHANNELS.LATENCY_LIST, async (_event, rawIp: unknown): Promise<IpcResponse> => {
    try {
      const ip = validateLatencyListIp(rawIp)
      return ok(getStore().listLatency(ip, 100).map(latencyRowToRecord))
    } catch (error) {
      return errorResponse('latency:list', error)
    }
  })

  // 扫描进度由主进程主动推送，使用独立事件通道；同时缓存最近一次扫描统计供诊断快照使用
  scanManager.setOnProgress((progress) => {
    recordScanFinished(progress)
    getWindow()?.webContents.send(IPC_CHANNELS.DISCOVERY_PROGRESS, progress)
  })

  // 退出前由 main/index.ts 的 before-quit 调用，清理本模块创建的全部定时器与事件监听。
  return {
    disposeSchedulers(): void {
      onlineMonitor.stop()
      if (autoScanTimer !== null) {
        clearInterval(autoScanTimer)
        autoScanTimer = null
      }
      app.removeListener('browser-window-focus', onWindowFocus)
      app.removeListener('browser-window-blur', onWindowBlur)
    }
  }
}
