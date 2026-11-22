/**
 * LanDesk 本地可观测性 —— 诊断快照 / 诊断包构建纯函数。
 *
 * 零遥测：只吃采集层传入的纯数据，产出可安全贴给 AI 的自包含文本；
 *  telemetryConsent 恒为 false，绝不产生任何网络外发。
 * 输出绝不含 password / encryptedPassword / DPAPI hex / username / 完整本机路径，
 * 但保留完整局域网 IPv4（诊断定位设备端口所必需）。
 */
import type {
  DiagnosticsSnapshot,
  DiagnosticsBundle,
  LogEntry,
  ProtocolId,
  SessionStatus
} from '../../shared/types'
import { redactContext, redactText, redactIpv4 } from './redact'

/**
 * 采集层传给 buildDiagnosticsSnapshot 的纯数据。
 * 约定：带 *Path / ShareName / subnet / errorMessage 的字段是"原始值"，
 * 由本模块负责脱敏；诊断快照只暴露布尔位 / 计数 / 掩码后的子网。
 */
export interface DiagnosticsInput {
  /** 快照生成时间；缺省用当前时间 */
  generatedAt?: string
  app: {
    version: string
    platform: string
    arch: string
    electronVersion: string
    uptimeSeconds: number
    storeMode: 'sqlite' | 'json'
    /** 原始子网（如 192.168.1.0/24），输出经 redactIpv4 掩码 */
    subnet: string
    safeStorageAvailable: boolean
  }
  settings: {
    complianceAccepted: boolean
    /** 忽略入参，输出恒为 false（零遥测） */
    telemetryConsent?: boolean
    clipboardSharing: boolean
    driveRedirection: boolean
    /** 只用于判空推导 hasVncViewerPath，原值绝不输出 */
    vncViewerPath?: string
    rustdeskPath?: string
    defaultShareName?: string
  }
  protocols: { id: ProtocolId; available: boolean }[]
  counts: { devices: number; credentials: number; sessions: number; logFiles: number }
  sessionState: SessionStatus
  /** 原始会话历史（errorMessage 为可能含敏感信息的原文） */
  recentSessions: {
    protocol: ProtocolId
    status: SessionStatus
    startedAt: string
    errorMessage?: string
  }[]
  /** 原始日志条目，内部会过滤 WARN/ERROR 并逐条脱敏 */
  recentErrors: LogEntry[]
  lastScan?: {
    /** 原始子网，输出经 redactIpv4 掩码 */
    subnet: string
    deviceCount: number
    finishedAt: string
    durationMs?: number
  }
}

const REDACTED = '[REDACTED]'

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/**
 * 递归删掉值为 [REDACTED] 的键（连同 key 名一起消失）。
 * redactContext 已把敏感 key / 用户别名 key 的值统一替换为 [REDACTED]，
 * 诊断包无需保留这些键名，故省略以彻底满足"输出绝不含敏感字样"。
 */
function stripRedacted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripRedacted)
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      if (v === REDACTED) continue
      out[k] = stripRedacted(v)
    }
    return out
  }
  return value
}

/** 日志 context 深度脱敏：值级语义脱敏 + 省略敏感/别名键名 */
function scrubContext(ctx: Record<string, unknown>): Record<string, unknown> {
  return stripRedacted(redactContext(ctx)) as Record<string, unknown>
}

/** 逐条清洗日志条目；event 走自由文本清洗，context 走深度脱敏 */
function scrubLogEntry(e: LogEntry): LogEntry {
  return {
    ts: e.ts,
    level: e.level,
    module: e.module,
    event: sanitizeFreeText(e.event),
    ...(e.context !== undefined ? { context: scrubContext(e.context) } : {}),
    // traceId 只允许随机 sessionId（randomUUID），绝不使用 deviceId
    ...(e.traceId !== undefined ? { traceId: e.traceId } : {})
  }
}

/**
 * 诊断包自由文本（errorMessage / event）的额外防御清洗。
 * 先走规格约定的 redactText，再清凭据 KV 与完整 Windows/UNC 路径。
 * 说明：这是组装层防御，不改变 redact.ts 的公共脱敏口径，专为满足
 * "诊断输出绝不含凭据字样 / 完整本机路径" 的硬要求；不碰 IPv4。
 */
function sanitizeFreeText(text: string): string {
  let out = redactText(text)
  // password=xxx / username:xxx / encryptedPassword=xxx ... 连同 key 一起抹掉
  out = out.replace(
    /\b(?:password|passwd|pwd|encryptedPassword|passwordHex|token|secret|credential|username|user)\s*[:=]\s*[^\s,;"']+/gi,
    REDACTED
  )
  // 完整本机盘符路径 / UNC 路径整体抹掉（不保留任何可能等于用户名的段）
  out = out.replace(/[A-Za-z]:[\\/][^\s,;"']+/g, REDACTED)
  out = out.replace(/\\\\[^\s,;"']+/g, REDACTED)
  return out
}

/** 只把字符串值过一遍自由文本正则，保留所有结构 / 键名 / 数字，用于格式化兜底 */
function scrubStringsDeep(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value)
  if (Array.isArray(value)) return value.map(scrubStringsDeep)
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = scrubStringsDeep(v)
    return out
  }
  return value
}

function newestFirst<T>(arr: T[], timeOf: (x: T) => string): T[] {
  return arr
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const ta = timeOf(a.item)
      const tb = timeOf(b.item)
      if (ta < tb) return 1
      if (ta > tb) return -1
      return a.index - b.index
    })
    .map((x) => x.item)
}

/**
 * 由纯数据构建诊断快照。
 * - recentSessions 取最近 10 条，errorMessage 经 redactText
 * - recentErrors 过滤 WARN/ERROR 后取最近 20 条，逐条脱敏
 * - subnetRedacted / lastScan.subnetRedacted 经 redactIpv4 掩码
 * - telemetryConsent 恒 false
 */
export function buildDiagnosticsSnapshot(input: DiagnosticsInput): DiagnosticsSnapshot {
  const recentSessions = newestFirst(input.recentSessions, (s) => s.startedAt)
    .slice(0, 10)
    .map((s) => ({
      protocol: s.protocol,
      status: s.status,
      startedAt: s.startedAt,
      errorMessageRedacted: sanitizeFreeText(s.errorMessage ?? '')
    }))

  const recentErrors = newestFirst(
    input.recentErrors.filter((e) => e.level === 'WARN' || e.level === 'ERROR'),
    (e) => e.ts
  )
    .slice(0, 20)
    .map(scrubLogEntry)

  const lastScan = input.lastScan
    ? {
        subnetRedacted: redactIpv4(input.lastScan.subnet),
        deviceCount: input.lastScan.deviceCount,
        finishedAt: input.lastScan.finishedAt,
        ...(input.lastScan.durationMs !== undefined ? { durationMs: input.lastScan.durationMs } : {})
      }
    : undefined

  return {
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    app: {
      version: input.app.version,
      platform: input.app.platform,
      arch: input.app.arch,
      electronVersion: input.app.electronVersion,
      uptimeSeconds: input.app.uptimeSeconds,
      storeMode: input.app.storeMode,
      subnetRedacted: redactIpv4(input.app.subnet),
      safeStorageAvailable: input.app.safeStorageAvailable
    },
    settings: {
      complianceAccepted: input.settings.complianceAccepted,
      telemetryConsent: false,
      clipboardSharing: input.settings.clipboardSharing,
      driveRedirection: input.settings.driveRedirection,
      hasVncViewerPath: !!input.settings.vncViewerPath?.trim(),
      hasRustdeskPath: !!input.settings.rustdeskPath?.trim(),
      hasDefaultShareName: !!input.settings.defaultShareName?.trim()
    },
    protocols: input.protocols.map((p) => ({ id: p.id, available: p.available })),
    counts: { ...input.counts },
    sessionState: input.sessionState,
    recentSessions,
    recentErrors,
    ...(lastScan !== undefined ? { lastScan } : {})
  }
}

/**
 * 输出自包含、人类可读、可被 JSON.parse 的诊断包文本。
 * 中文说明作为 JSON 内的首字段（而非前缀文本），保证整体仍是合法 JSON。
 * logs 与 recentErrors 逐条脱敏，snapshot 其余字符串值兜底清洗。
 */
export function formatDiagnosticsBundle(bundle: DiagnosticsBundle): string {
  const readme =
    `LanDesk 本地诊断包（可整段复制给 AI 分析）。` +
    `生成时间：${bundle.snapshot.generatedAt}；` +
    `应用版本：${bundle.snapshot.app.version} (${bundle.snapshot.app.platform}/${bundle.snapshot.app.arch})；` +
    `schemaVersion：${bundle.schemaVersion}。` +
    `零遥测声明：本文件仅在本机离线生成，不含任何遥测上报、远程画面、键盘记录或明文凭据；` +
    `敏感字段（口令 / 凭据 / 用户名 / 完整本机路径）已脱敏，子网已掩码，` +
    `局域网设备 IP 保留完整以便定位端口连通性问题。`

  const snapshot = bundle.snapshot
  const safeSnapshot = scrubStringsDeep({
    ...snapshot,
    recentSessions: snapshot.recentSessions.map((s) => ({
      ...s,
      errorMessageRedacted: sanitizeFreeText(s.errorMessageRedacted)
    })),
    recentErrors: snapshot.recentErrors.map(scrubLogEntry)
  })

  const payload = scrubStringsDeep({
    _说明: readme,
    schemaVersion: bundle.schemaVersion,
    snapshot: safeSnapshot,
    logs: bundle.logs.map(scrubLogEntry)
  })

  return JSON.stringify(payload, null, 2)
}
