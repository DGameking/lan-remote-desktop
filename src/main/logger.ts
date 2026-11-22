import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { LogEntry, LogLevel } from '../shared/types'
import { redactContext, redactText } from './observability/redact'
import { serializeLogLine } from './observability/serialize'
import { planRotation } from './observability/rotation'

/**
 * 本地结构化文件日志（v1.3.0，JSON Lines）。
 * 写入 userData/logs/lanDesk-YYYY-MM-DD.jsonl，仅保留最近 30 天。
 * 零遥测：不采集任何被控画面、键盘记录或明文凭据；写前对 context 统一脱敏。
 *
 * app.getPath('userData') 只在 ensureDir() 内懒调用，绝不在模块顶层执行
 * （否则 app ready 之前 import 本模块会崩溃）。
 */
const RETENTION_DAYS = 30
const MAX_BYTES = 5 * 1024 * 1024 // 单个分片上限 5MB，达到即切下一片
const LOG_FILE_RE = /\.(log|jsonl)$/i
const DEFAULT_MODULE = 'app'

let logDir = ''
let initialized = false

interface FileMeta {
  name: string
  mtimeMs: number
  size: number
}

/** 读取 logs 目录下 .jsonl 与旧 .log 文件的元信息；单个文件 stat 失败则跳过 */
function listLogFiles(): FileMeta[] {
  const out: FileMeta[] = []
  for (const name of fs.readdirSync(logDir)) {
    if (!LOG_FILE_RE.test(name)) continue
    try {
      const st = fs.statSync(path.join(logDir, name))
      out.push({ name, mtimeMs: st.mtimeMs, size: st.size })
    } catch {
      // 单个文件不可读不影响整体
    }
  }
  return out
}

/** 30 天清理：通过 planRotation 得到过期清单，.jsonl 与旧 .log 都识别 */
function cleanup(): void {
  try {
    const { deleteNames } = planRotation(listLogFiles(), MAX_BYTES, RETENTION_DAYS, Date.now())
    for (const name of deleteNames) {
      try {
        fs.unlinkSync(path.join(logDir, name))
      } catch {
        // 删除失败不影响主流程
      }
    }
  } catch {
    // 清理失败不影响主流程
  }
}

function ensureDir(): void {
  if (initialized) return
  try {
    logDir = path.join(app.getPath('userData'), 'logs')
    fs.mkdirSync(logDir, { recursive: true })
    cleanup()
    initialized = true
  } catch {
    logDir = ''
  }
}

/** 统一结构化写入口：构造 LogEntry -> 脱敏 -> JSON Lines -> 追加到分片文件 */
function writeEntry(input: {
  level: LogLevel
  module: string
  event: string
  context?: unknown
  traceId?: string
}): void {
  ensureDir()
  if (!logDir) return
  try {
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level: input.level,
      module: input.module,
      event: redactText(input.event),
      ...(input.context !== undefined ? { context: redactContext(input.context) } : {}),
      // traceId 只允许随机 sessionId（randomUUID），绝不使用 deviceId
      ...(input.traceId !== undefined ? { traceId: input.traceId } : {})
    }
    const { targetFile } = planRotation(listLogFiles(), MAX_BYTES, RETENTION_DAYS, Date.now())
    // 结构化写入统一走 serializeLogLine；safeStringify 仅作极端序列化异常的兜底
    let line: string
    try {
      line = serializeLogLine(entry)
    } catch {
      line = safeStringify(entry)
    }
    fs.appendFileSync(path.join(logDir, targetFile), line + '\n', 'utf8')
  } catch {
    // 日志写入失败一律静默吞掉，绝不抛到主流程
  }
}

/** 兼容 23 处旧调用点：message -> event，extra -> context；第三参可选 module */
function write(level: LogLevel, message: string, extra?: unknown, module?: string): void {
  writeEntry({
    level,
    module: module ?? DEFAULT_MODULE,
    event: message,
    ...(extra !== undefined ? { context: extra } : {})
  })
}

/** 历史兜底格式化：保留以兼容极端场景；结构化写入一律走 serializeLogLine */
function safeStringify(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export const logger = {
  info(message: string, extra?: unknown, module?: string): void {
    write('INFO', message, extra, module)
  },
  warn(message: string, extra?: unknown, module?: string): void {
    write('WARN', message, extra, module)
  },
  error(message: string, extra?: unknown, module?: string): void {
    write('ERROR', message, extra, module)
  },
  /** 结构化事件写入；traceId 仅使用随机 sessionId（randomUUID），绝不使用 deviceId */
  event(entry: {
    level: LogLevel
    module: string
    event: string
    context?: Record<string, unknown>
    traceId?: string
  }): void {
    writeEntry({
      level: entry.level,
      module: entry.module,
      event: entry.event,
      ...(entry.context !== undefined ? { context: entry.context } : {}),
      ...(entry.traceId !== undefined ? { traceId: entry.traceId } : {})
    })
  }
}

/**
 * 绑定 module 的 logger；连接埋点等模块直接用它免除每次手填 module。
 * 该签名被连接埋点直接引用，保持逐字一致。
 */
export function scopedLogger(module: string): {
  info(message: string, extra?: unknown): void
  warn(message: string, extra?: unknown): void
  error(message: string, extra?: unknown): void
  event(entry: { level: LogLevel; event: string; context?: Record<string, unknown>; traceId?: string }): void
} {
  return {
    info(message: string, extra?: unknown): void {
      write('INFO', message, extra, module)
    },
    warn(message: string, extra?: unknown): void {
      write('WARN', message, extra, module)
    },
    error(message: string, extra?: unknown): void {
      write('ERROR', message, extra, module)
    },
    event(entry: { level: LogLevel; event: string; context?: Record<string, unknown>; traceId?: string }): void {
      writeEntry({
        level: entry.level,
        module,
        event: entry.event,
        ...(entry.context !== undefined ? { context: entry.context } : {}),
        ...(entry.traceId !== undefined ? { traceId: entry.traceId } : {})
      })
    }
  }
}
