/**
 * LanDesk 本地可观测性 —— 采集层（主进程内唯一读 store / fs / electron 的地方）。
 *
 * 职责：把分散在各模块的运行状态汇聚成 DiagnosticsInput 纯数据，交给
 * diagnostics.ts 脱敏后产出快照 / 诊断包；并负责读本机日志与缓存最近一次扫描统计。
 *
 * 零遥测：本模块所有产出只写本机 userData，绝不网络外发。
 * app.getPath('userData') 一律在函数体内懒调用，避免 app ready 前 import 崩溃。
 */
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type {
  DiagnosticsBundle,
  DiagnosticsExportResult,
  DiagnosticsSnapshot,
  LogEntry,
  ScanProgress,
  SessionStatus
} from '../../shared/types'
import { detectSubnets } from '../discovery/subnet'
import { getAvailability } from '../protocols/registry'
import { isEncryptionAvailable } from '../store/crypto'
import { getSettings, getStore } from '../store'
import { buildDiagnosticsSnapshot, formatDiagnosticsBundle, type DiagnosticsInput } from './diagnostics'
import { redactIpv4 } from './redact'
import { parseLegacyLogLine, parseLogLine } from './serialize'

const LOG_FILE_RE = /\.(log|jsonl)$/i
/** 单次查询最多解析的新旧日志文件行数，避免诊断把历史全量读进内存 */
const MAX_LOG_LINES = 5000

function logsDir(): string {
  return path.join(app.getPath('userData'), 'logs')
}

/** 读 logs 目录下 .jsonl（新）与 .log（旧），文件名倒序即最新优先；坏行跳过。 */
export function readRecentLogs(): LogEntry[] {
  let names: string[]
  try {
    names = fs
      .readdirSync(logsDir())
      .filter((name) => LOG_FILE_RE.test(name))
      .sort()
      .reverse()
  } catch {
    return []
  }

  const out: LogEntry[] = []
  for (const name of names) {
    let content: string
    try {
      content = fs.readFileSync(path.join(logsDir(), name), 'utf8')
    } catch {
      continue
    }
    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      const parsed = parseLogLine(line) ?? parseLegacyLogLine(line)
      if (parsed) out.push(parsed)
      if (out.length >= MAX_LOG_LINES) return out
    }
  }
  return out
}

function countLogFiles(): number {
  try {
    return fs.readdirSync(logsDir()).filter((name) => LOG_FILE_RE.test(name)).length
  } catch {
    return 0
  }
}

/** 最近一次扫描统计：只存原始 subnet，掩码交给 buildDiagnosticsSnapshot 统一处理。 */
let lastScanCache: DiagnosticsInput['lastScan']
/** 首次非 idle 进度的时间戳，用于估算扫描耗时（ScanProgress 本身不含 durationMs）。 */
let scanStartedAt = 0

/**
 * 由 setOnProgress 每帧调用：非完成态只记录起点，done/stopped 才落缓存。
 * 这样诊断快照能回答"最近一次扫描是什么时候、扫到几台、耗时多久"。
 */
export function recordScanFinished(progress: ScanProgress): void {
  if (progress.phase === 'done' || progress.phase === 'stopped') {
    lastScanCache = {
      subnet: progress.subnet,
      deviceCount: progress.devices.length,
      finishedAt: new Date().toISOString(),
      ...(scanStartedAt > 0 ? { durationMs: Date.now() - scanStartedAt } : {})
    }
    scanStartedAt = 0
    return
  }
  if (scanStartedAt === 0 && progress.phase !== 'idle') scanStartedAt = Date.now()
}

export function getLastScan(): DiagnosticsSnapshot['lastScan'] {
  if (!lastScanCache) return undefined
  // 与快照保持同样的掩码口径，便于独立调用方直接消费
  return {
    subnetRedacted: redactIpv4(lastScanCache.subnet),
    deviceCount: lastScanCache.deviceCount,
    finishedAt: lastScanCache.finishedAt,
    ...(lastScanCache.durationMs !== undefined ? { durationMs: lastScanCache.durationMs } : {})
  }
}

/** 供单测隔离状态：清空扫描缓存与计时起点。 */
export function resetCollectorForTest(): void {
  lastScanCache = undefined
  scanStartedAt = 0
}

/**
 * 汇聚运行状态为 DiagnosticsInput 纯数据。
 * getSessionState 由调用方注入，避免 collector 直接依赖 SessionManager 实例（便于单测）。
 */
export async function collectDiagnosticsInput(options?: {
  getSessionState?: () => SessionStatus
}): Promise<DiagnosticsInput> {
  const store = getStore()
  const settings = getSettings()
  const subnet = detectSubnets()[0]?.cidr ?? '未检测到局域网网卡'
  const protocols = (await getAvailability()).map((p) => ({ id: p.id, available: p.available }))
  const history = store.listSessions()
  const recentSessions = history.map((row) => ({
    protocol: row.protocol,
    status: row.status,
    startedAt: row.startedAt,
    ...(row.errorMessage ? { errorMessage: row.errorMessage } : {})
  }))

  return {
    app: {
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      electronVersion: process.versions.electron ?? '',
      uptimeSeconds: Math.floor(process.uptime()),
      storeMode: store.mode(),
      subnet,
      safeStorageAvailable: isEncryptionAvailable()
    },
    settings: {
      complianceAccepted: settings.complianceAccepted,
      telemetryConsent: settings.telemetryConsent,
      clipboardSharing: settings.clipboardSharing,
      driveRedirection: settings.driveRedirection,
      vncViewerPath: settings.vncViewerPath,
      rustdeskPath: settings.rustdeskPath,
      defaultShareName: settings.defaultShareName
    },
    protocols,
    counts: {
      devices: store.listDevices().length,
      credentials: store.listCredentials().length,
      sessions: history.length,
      logFiles: countLogFiles()
    },
    sessionState: options?.getSessionState?.() ?? 'idle',
    recentSessions,
    recentErrors: readRecentLogs(),
    ...(lastScanCache ? { lastScan: lastScanCache } : {})
  }
}

/**
 * 导出诊断包：快照 + 最近日志 → 脱敏文本 → 写本机 userData/diagnostics/。
 * text 供一键复制，filePath 供归档；全程无网络。
 */
export async function exportDiagnosticsBundle(): Promise<DiagnosticsExportResult> {
  const snapshot = buildDiagnosticsSnapshot(await collectDiagnosticsInput())
  const bundle: DiagnosticsBundle = { schemaVersion: 1, snapshot, logs: readRecentLogs() }
  const text = formatDiagnosticsBundle(bundle)

  const dir = path.join(app.getPath('userData'), 'diagnostics')
  fs.mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const filePath = path.join(dir, `lanDesk-diagnostics-${stamp}.txt`)
  fs.writeFileSync(filePath, text, 'utf8')
  return { text, filePath }
}
