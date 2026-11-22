/**
 * LanDesk 本地可观测性 —— JSON Lines 序列化 / 解析纯函数。
 *
 * 每行一条 LogEntry 的 JSON。traceId 只允许随机 sessionId（randomUUID），
 * 绝不使用 deviceId。解析层对坏行一律返回 null，绝不抛错。
 */
import type { LogEntry, LogLevel } from '../../shared/types'
import { redactContext, redactText } from './redact'

const LEVELS: readonly LogLevel[] = ['INFO', 'WARN', 'ERROR']

/** 序列化为单行 JSON（不含换行；换行由 logger 追加） */
export function serializeLogLine(entry: LogEntry): string {
  return JSON.stringify(entry)
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** 校验必需字段 ts/level/module/event，可选字段类型也要合法，否则视为坏行 */
function isLogEntry(o: Record<string, unknown>): o is LogEntry & Record<string, unknown> {
  if (typeof o.ts !== 'string' || typeof o.module !== 'string' || typeof o.event !== 'string') return false
  if (!LEVELS.includes(o.level as LogLevel)) return false
  if (o.context !== undefined && !isPlainObject(o.context)) return false
  if (o.traceId !== undefined && typeof o.traceId !== 'string') return false
  return true
}

/** 解析结构化 JSON Lines；非法 JSON / 字段不全 / 类型不符 -> null */
export function parseLogLine(line: string): LogEntry | null {
  let obj: unknown
  try {
    obj = JSON.parse(line)
  } catch {
    return null
  }
  if (!isPlainObject(obj)) return null
  return isLogEntry(obj) ? obj : null
}

const LEGACY_RE = /^\[([^\]]+)\]\s*\[(INFO|WARN|ERROR)\]\s*([\s\S]*)$/

/**
 * 兼容旧文本日志：[ISO] [LEVEL] msg {json}
 * 解析出的 msg 与 {json} 都再走一次脱敏，防止历史明文被带进诊断包。
 * 不匹配旧格式 / 坏行 -> null。
 */
export function parseLegacyLogLine(line: string): LogEntry | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  const m = LEGACY_RE.exec(trimmed)
  if (!m) return null

  const ts = m[1]
  const level = m[2] as LogLevel
  const rest = m[3]

  let message = rest
  let context: Record<string, unknown> | undefined
  const jsonMatch = /\s+(\{[\s\S]*\})\s*$/.exec(rest)
  if (jsonMatch) {
    try {
      const parsed: unknown = JSON.parse(jsonMatch[1])
      if (isPlainObject(parsed)) {
        message = rest.slice(0, jsonMatch.index).trim() || rest
        context = redactContext(parsed)
      }
    } catch {
      // 尾部不是合法 JSON 对象，整段按纯文本消息处理
    }
  }

  return {
    ts,
    level,
    module: 'legacy',
    event: redactText(message),
    ...(context !== undefined ? { context } : {})
  }
}
