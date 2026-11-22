import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  IPC_CHANNELS,
  type ElectronAPI,
  type ScanProgress
} from '../shared/types'

/** 只暴露明确列入白名单的通道，渲染层无法访问 ipcRenderer / Node 能力 */
const api: ElectronAPI = {
  discoveryStart: () => ipcRenderer.invoke(IPC_CHANNELS.DISCOVERY_START),
  discoveryStop: () => ipcRenderer.invoke(IPC_CHANNELS.DISCOVERY_STOP),
  onDiscoveryProgress: (callback: (progress: ScanProgress) => void) => {
    const listener = (_event: IpcRendererEvent, progress: ScanProgress): void => {
      callback(progress)
    }
    ipcRenderer.on(IPC_CHANNELS.DISCOVERY_PROGRESS, listener)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.DISCOVERY_PROGRESS, listener)
  },
  deviceList: () => ipcRenderer.invoke(IPC_CHANNELS.DEVICE_LIST),
  deviceUpsert: (device) => ipcRenderer.invoke(IPC_CHANNELS.DEVICE_UPSERT, device),
  deviceDelete: (id) => ipcRenderer.invoke(IPC_CHANNELS.DEVICE_DELETE, id),
  credentialSet: (input) => ipcRenderer.invoke(IPC_CHANNELS.CREDENTIAL_SET, input),
  credentialList: () => ipcRenderer.invoke(IPC_CHANNELS.CREDENTIAL_LIST),
  credentialDelete: (id) => ipcRenderer.invoke(IPC_CHANNELS.CREDENTIAL_DELETE, id),
  sessionConnect: (request) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_CONNECT, request),
  sessionPrecheck: (ip, protocol, port) =>
    ipcRenderer.invoke(IPC_CHANNELS.SESSION_PRECHECK, ip, protocol, port),
  sessionList: () => ipcRenderer.invoke(IPC_CHANNELS.SESSION_LIST),
  fileTransferOpen: (target) => ipcRenderer.invoke(IPC_CHANNELS.FILE_TRANSFER_OPEN, target),
  appGetStatus: () => ipcRenderer.invoke(IPC_CHANNELS.APP_GET_STATUS),
  appGetDiagnostics: () => ipcRenderer.invoke(IPC_CHANNELS.APP_GET_DIAGNOSTICS),
  appExportDiagnostics: () => ipcRenderer.invoke(IPC_CHANNELS.APP_EXPORT_DIAGNOSTICS),
  logQuery: (query) => ipcRenderer.invoke(IPC_CHANNELS.LOG_QUERY, query),
  serverOpen: (target) => ipcRenderer.invoke(IPC_CHANNELS.SERVER_OPEN, target),
  deviceWake: (target) => ipcRenderer.invoke(IPC_CHANNELS.DEVICE_WAKE, target),
  settingsGet: () => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET),
  settingsSet: (patch) => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SET, patch)
}

contextBridge.exposeInMainWorld('electronAPI', api)
