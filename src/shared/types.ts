/**
 * LanDesk 共享类型定义（主进程 / 预加载 / 渲染进程共用）
 * 注意：本文件不得引入任何 Node 或 DOM 专有模块，保证两端都能编译。
 */

/** 支持的外部调起协议 */
export type ProtocolId = 'rdp' | 'vnc' | 'rustdesk'

/** 设备平台推测 */
export type OsHint = 'windows' | 'macos' | 'linux' | 'fnos' | 'unknown'

/** 设备来源 */
export type DiscoverySource = 'subnet' | 'mdns' | 'arp' | 'manual'

/** 会话状态机 */
export type SessionStatus = 'idle' | 'connecting' | 'connected' | 'failed'

/** 设备实体 */
export interface Device {
  id: string
  name: string
  ip: string
  mac: string
  osHint: OsHint
  source: DiscoverySource
  availableProtocols: ProtocolId[]
  online: boolean
  lastSeenAt: string
  createdAt: string
  updatedAt: string
}

/** 凭据实体：password 字段永不落明文，库中只保存 encryptedPassword */
export interface Credential {
  id: string
  deviceId: string
  protocol: ProtocolId
  username: string
  encryptedPassword: string
  createdAt: string
  updatedAt: string
}

/** 渲染层可见的凭据（不含密文） */
export interface CredentialView {
  id: string
  deviceId: string
  protocol: ProtocolId
  username: string
  hasPassword: boolean
  updatedAt: string
}

/** 连接历史实体 */
export interface SessionRecord {
  id: string
  deviceId: string
  deviceName: string
  protocol: ProtocolId
  status: SessionStatus
  startedAt: string
  endedAt: string
  errorMessage: string
}

/** 应用设置 */
export interface AppSettings {
  /** 外部 VNC Viewer 可执行文件路径（留空则自动探测） */
  vncViewerPath: string
  /** RustDesk 可执行文件路径（留空则自动探测） */
  rustdeskPath: string
  /** 是否在发起 RDP 前用 cmdkey 预置凭据（默认 false） */
  useCmdkey: boolean
  /** 是否已确认首次合规声明 */
  complianceAccepted: boolean
  /** 匿名遥测默认关闭 */
  telemetryConsent: boolean
}

/** 统一 IPC 响应包装 */
export interface IpcResponse<T = unknown> {
  code: number
  message: string
  data: T | null
}

/** 协议可用性检测结果 */
export interface ProtocolAvailability {
  id: ProtocolId
  label: string
  available: boolean
  detail: string
}

/** 应用状态（app:getStatus 返回） */
export interface AppStatus {
  platform: string
  version: string
  subnet: string
  storeMode: 'sqlite' | 'json'
  protocols: ProtocolAvailability[]
}

/** 扫描进度推送 */
export interface ScanProgress {
  phase: 'idle' | 'subnet' | 'ports' | 'mdns' | 'arp' | 'done' | 'stopped'
  percent: number
  message: string
  subnet: string
  devices: Device[]
}

/** 连接请求 */
export interface ConnectRequest {
  deviceId: string
  ip: string
  protocol: ProtocolId
  port?: number
  username?: string
  password?: string
  rustdeskId?: string
  screenMode?: 'fullscreen' | 'window'
  useCmdkey?: boolean
}

/** 连接结果 */
export interface ConnectResult {
  ok: boolean
  message: string
  sessionId: string
  launched: boolean
}

/** 凭据保存入参（明文只在 IPC 调用瞬间存在于内存） */
export interface CredentialInput {
  deviceId: string
  protocol: ProtocolId
  username: string
  password: string
}

/** IPC 通道常量，渲染层与主进程共用，防止拼写漂移 */
export const IPC_CHANNELS = {
  DISCOVERY_START: 'discovery:start',
  DISCOVERY_PROGRESS: 'discovery:progress',
  DISCOVERY_STOP: 'discovery:stop',
  DEVICE_LIST: 'device:list',
  DEVICE_UPSERT: 'device:upsert',
  DEVICE_DELETE: 'device:delete',
  CREDENTIAL_SET: 'credential:set',
  CREDENTIAL_LIST: 'credential:list',
  CREDENTIAL_DELETE: 'credential:delete',
  SESSION_CONNECT: 'session:connect',
  SESSION_LIST: 'session:list',
  APP_GET_STATUS: 'app:getStatus',
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set'
} as const

/** 默认设置（单一来源，避免两端各写一份） */
export const DEFAULT_SETTINGS: AppSettings = {
  vncViewerPath: '',
  rustdeskPath: '',
  useCmdkey: false,
  complianceAccepted: false,
  telemetryConsent: false
}

/** contextBridge 暴露给渲染层的 API 契约 */
export interface ElectronAPI {
  discoveryStart: () => Promise<IpcResponse<{ subnet: string }>>
  discoveryStop: () => Promise<IpcResponse<boolean>>
  onDiscoveryProgress: (callback: (progress: ScanProgress) => void) => () => void
  deviceList: () => Promise<IpcResponse<Device[]>>
  deviceUpsert: (device: Device) => Promise<IpcResponse<Device>>
  deviceDelete: (id: string) => Promise<IpcResponse<boolean>>
  credentialSet: (input: CredentialInput) => Promise<IpcResponse<CredentialView>>
  credentialList: () => Promise<IpcResponse<CredentialView[]>>
  credentialDelete: (id: string) => Promise<IpcResponse<boolean>>
  sessionConnect: (request: ConnectRequest) => Promise<IpcResponse<ConnectResult>>
  sessionList: () => Promise<IpcResponse<SessionRecord[]>>
  appGetStatus: () => Promise<IpcResponse<AppStatus>>
  settingsGet: () => Promise<IpcResponse<AppSettings>>
  settingsSet: (patch: Partial<AppSettings>) => Promise<IpcResponse<AppSettings>>
}
