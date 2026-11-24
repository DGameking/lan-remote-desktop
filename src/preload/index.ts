import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { toPlain } from '../shared/ipc-sanitize'
import {
  IPC_CHANNELS,
  type DeepLinkRequest,
  type ElectronAPI,
  type OnlineStatusEvent,
  type ScanProgress
} from '../shared/types'

/** 只暴露明确列入白名单的通道，渲染层无法访问 ipcRenderer / Node 能力 */
const api: ElectronAPI = {
  // 所有对象参数先过 toPlain：渲染层的 ref/reactive Proxy 无法被结构化克隆，
  // 在 preload 边界净化后主进程收到的必是纯数据（防 DataCloneError）。
  discoveryStart: (targetCidr) => ipcRenderer.invoke(IPC_CHANNELS.DISCOVERY_START, targetCidr),
  discoveryStop: () => ipcRenderer.invoke(IPC_CHANNELS.DISCOVERY_STOP),
  onDiscoveryProgress: (callback: (progress: ScanProgress) => void) => {
    const listener = (_event: IpcRendererEvent, progress: ScanProgress): void => {
      callback(progress)
    }
    ipcRenderer.on(IPC_CHANNELS.DISCOVERY_PROGRESS, listener)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.DISCOVERY_PROGRESS, listener)
  },
  discoverySubnets: () => ipcRenderer.invoke(IPC_CHANNELS.DISCOVERY_SUBNETS),
  deviceList: () => ipcRenderer.invoke(IPC_CHANNELS.DEVICE_LIST),
  deviceUpsert: (device) => ipcRenderer.invoke(IPC_CHANNELS.DEVICE_UPSERT, toPlain(device)),
  deviceDelete: (id) => ipcRenderer.invoke(IPC_CHANNELS.DEVICE_DELETE, id),
  deviceSetOs: (deviceId, osHint) => ipcRenderer.invoke(IPC_CHANNELS.DEVICE_SET_OS, deviceId, osHint),
  credentialSet: (input) => ipcRenderer.invoke(IPC_CHANNELS.CREDENTIAL_SET, toPlain(input)),
  credentialList: () => ipcRenderer.invoke(IPC_CHANNELS.CREDENTIAL_LIST),
  credentialDelete: (id) => ipcRenderer.invoke(IPC_CHANNELS.CREDENTIAL_DELETE, id),
  sessionConnect: (request) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_CONNECT, toPlain(request)),
  sessionPrecheck: (ip, protocol, port) =>
    ipcRenderer.invoke(IPC_CHANNELS.SESSION_PRECHECK, ip, protocol, port),
  sessionList: () => ipcRenderer.invoke(IPC_CHANNELS.SESSION_LIST),
  sessionEnd: () => ipcRenderer.invoke(IPC_CHANNELS.SESSION_END),
  sessionClear: () => ipcRenderer.invoke(IPC_CHANNELS.SESSION_CLEAR),
  appShow: () => ipcRenderer.invoke(IPC_CHANNELS.APP_SHOW),
  fileTransferOpen: (target) => ipcRenderer.invoke(IPC_CHANNELS.FILE_TRANSFER_OPEN, toPlain(target)),
  appGetStatus: () => ipcRenderer.invoke(IPC_CHANNELS.APP_GET_STATUS),
  appGetDiagnostics: () => ipcRenderer.invoke(IPC_CHANNELS.APP_GET_DIAGNOSTICS),
  appExportDiagnostics: () => ipcRenderer.invoke(IPC_CHANNELS.APP_EXPORT_DIAGNOSTICS),
  logQuery: (query) => ipcRenderer.invoke(IPC_CHANNELS.LOG_QUERY, toPlain(query)),
  serverOpen: (target) => ipcRenderer.invoke(IPC_CHANNELS.SERVER_OPEN, toPlain(target)),
  deviceWake: (target) => ipcRenderer.invoke(IPC_CHANNELS.DEVICE_WAKE, toPlain(target)),
  settingsGet: () => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET),
  settingsSet: (patch) => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SET, toPlain(patch)),
  deviceUpdateMeta: (input) => ipcRenderer.invoke(IPC_CHANNELS.DEVICE_UPDATE_META, toPlain(input)),
  sessionSetNote: (sessionId, note) =>
    ipcRenderer.invoke(IPC_CHANNELS.SESSION_SET_NOTE, sessionId, note),
  dataExport: () => ipcRenderer.invoke(IPC_CHANNELS.DATA_EXPORT),
  dataImport: (includeSettings) => ipcRenderer.invoke(IPC_CHANNELS.DATA_IMPORT, includeSettings),
  // v1.7: 延迟测速 / 历史查询。均为基本类型参数，无需过 toPlain。
  latencyMeasure: (ip, port) => ipcRenderer.invoke(IPC_CHANNELS.LATENCY_MEASURE, ip, port),
  latencyList: (ip) => ipcRenderer.invoke(IPC_CHANNELS.LATENCY_LIST, ip),
  onOnlineStatusChanged: (callback) => {
    const listener = (_event: IpcRendererEvent, event: OnlineStatusEvent): void => {
      callback(event)
    }
    ipcRenderer.on(IPC_CHANNELS.ONLINE_STATUS_CHANGED, listener)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.ONLINE_STATUS_CHANGED, listener)
  },
  // v1.7-D: 直连预填推送。回调前过 toPlain，避免主进程传来的对象带不可克隆字段。
  onDeepLinkRequest: (callback) => {
    const listener = (_event: IpcRendererEvent, request: DeepLinkRequest): void => {
      callback(toPlain(request))
    }
    ipcRenderer.on(IPC_CHANNELS.DEEPLINK_REQUEST, listener)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.DEEPLINK_REQUEST, listener)
  }
}

contextBridge.exposeInMainWorld('electronAPI', api)
