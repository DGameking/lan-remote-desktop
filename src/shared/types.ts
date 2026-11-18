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
  /** 是否在发起 RDP 前用 cmdkey 预置凭据（默认 false；兼容旧版本字段，已不再生效） */
  useCmdkey: boolean
  /** 是否已确认首次合规声明 */
  complianceAccepted: boolean
  /** 匿名遥测默认关闭 */
  telemetryConsent: boolean
  /** 会话内共享剪贴板（RDP 剪贴板重定向，默认开启） */
  clipboardSharing: boolean
  /** RDP 会话内磁盘重定向（把主控端磁盘映射进远程会话以传输文件，默认关闭） */
  driveRedirection: boolean
  /** 常用 SMB 共享名，文件传输时作为默认子路径（留空则打开 \\IP 根目录） */
  defaultShareName: string
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
  /** 本次会话是否共享剪贴板（不传则沿用全局设置） */
  clipboardSharing?: boolean
  /** 本次会话是否开启磁盘重定向（不传则沿用全局设置） */
  driveRedirection?: boolean
}

/** 连接结果 */
export interface ConnectResult {
  ok: boolean
  message: string
  sessionId: string
  launched: boolean
  /** 本次会话实际启用的共享能力说明，用于 UI 回显 */
  capabilities: string[]
}

/**
 * 共享能力描述。
 * source=channel 表示由连接通道本身原生提供；
 * source=client 表示由本机外部客户端提供（LanDesk 只负责调起）；
 * source=unsupported 表示该通道不具备该能力。
 */
export interface Capability {
  supported: boolean
  source: 'channel' | 'client' | 'unsupported'
  note: string
}

export interface ProtocolCapabilities {
  protocol: ProtocolId
  clipboard: Capability
  fileTransfer: Capability
}

/** 连接前 TCP 端口预检结果 */
export interface PrecheckResult {
  ip: string
  port: number
  reachable: boolean
  latencyMs: number
}

/** 文件传输目标（SMB 共享） */
export interface FileTransferTarget {
  ip: string
  /** 共享名，留空则打开 \\IP 根目录 */
  share?: string
  /** 平台提示，用于生成不同的引导文案 */
  hint?: OsHint
}

/** 文件传输结果 */
export interface FileTransferResult {
  ok: boolean
  message: string
  /** 实际打开的 UNC 路径（仅本机路径，不含任何凭据） */
  path: string
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
  SESSION_PRECHECK: 'session:precheck',
  SESSION_LIST: 'session:list',
  FILE_TRANSFER_OPEN: 'file-transfer:open',
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
  telemetryConsent: false,
  clipboardSharing: true,
  driveRedirection: false,
  defaultShareName: ''
}

/**
 * 各协议的共享能力矩阵。全部基于各平台/客户端原生能力，LanDesk 不自研协议栈。
 * 该表是 UI 提示与文档披露的唯一事实来源。
 */
export const CAPABILITY_MATRIX: Record<ProtocolId, ProtocolCapabilities> = {
  rdp: {
    protocol: 'rdp',
    clipboard: {
      supported: true,
      source: 'channel',
      note: '由 Windows RDP 剪贴板重定向提供，复制文本/图片可直接在两台电脑间粘贴。'
    },
    fileTransfer: {
      supported: true,
      source: 'channel',
      note: '开启磁盘重定向后，本机磁盘映射进远程会话，可像本地一样拖拽复制文件。'
    }
  },
  vnc: {
    protocol: 'vnc',
    clipboard: {
      supported: true,
      source: 'client',
      note: '由 VNC Viewer 自身的剪贴板转发提供（RFB CutText），需 Viewer 支持。'
    },
    fileTransfer: {
      supported: false,
      source: 'unsupported',
      note: '标准 VNC 不含文件传输；请使用 RDP、RustDesk，或“传文件”通道（SMB）。'
    }
  },
  rustdesk: {
    protocol: 'rustdesk',
    clipboard: {
      supported: true,
      source: 'client',
      note: '由 RustDesk 官方客户端原生提供，连接会话内自动同步剪贴板。'
    },
    fileTransfer: {
      supported: true,
      source: 'client',
      note: '由 RustDesk 官方客户端原生提供，会话窗口内使用“文件传输”功能。'
    }
  }
}

/** 协议对应的默认 TCP 预检端口；rustdesk 主要走 21116/中继，返回 0 表示跳过预检 */
export const PROTOCOL_PRECHECK_PORT: Record<ProtocolId, number> = {
  rdp: 3389,
  vnc: 5900,
  rustdesk: 0
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
  sessionPrecheck: (ip: string, protocol: ProtocolId, port?: number) => Promise<IpcResponse<PrecheckResult>>
  sessionList: () => Promise<IpcResponse<SessionRecord[]>>
  fileTransferOpen: (target: FileTransferTarget) => Promise<IpcResponse<FileTransferResult>>
  appGetStatus: () => Promise<IpcResponse<AppStatus>>
  settingsGet: () => Promise<IpcResponse<AppSettings>>
  settingsSet: (patch: Partial<AppSettings>) => Promise<IpcResponse<AppSettings>>
}
