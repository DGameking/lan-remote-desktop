/**
 * LanDesk 本地可观测性 —— 日志查询纯函数。
 * 内存过滤 + 排序，不碰 fs / electron。
 */
import type { LogEntry, LogQuery } from '../../shared/types'

const DEFAULT_LIMIT = 200
const MAX_LIMIT = 1000

/**
 * 上界规范化：from / to 用 ISO 字符串字典序比较。
 * 若 to 是纯日期 YYYY-MM-DD，扩展到当天末尾（含当天所有时刻）；
 * from 为纯日期时其字典序天然是当天最小边界，无需处理。
 */
function upperBound(to: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(to) ? to + '\uffff' : to
}

/** 计算有效 limit：未提供 / 非法（NaN、0、负数）回退默认 200，硬上限 1000 */
function effectiveLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return DEFAULT_LIMIT
  return Math.min(Math.floor(limit), MAX_LIMIT)
}

/**
 * 过滤条件：levels / module / from / to / traceId / keyword。
 * keyword 在 event 与 context 文本里做大小写不敏感匹配。
 * 结果按 ts 倒序（最新在前），再按 limit 截断。
 */
export function filterLogEntries(entries: LogEntry[], q: LogQuery): LogEntry[] {
  const levels = Array.isArray(q.levels) && q.levels.length > 0 ? q.levels : undefined
  const from = q.from
  const to = q.to === undefined ? undefined : upperBound(q.to)
  const keyword =
    typeof q.keyword === 'string' && q.keyword.length > 0 ? q.keyword.toLowerCase() : undefined

  const filtered = entries.filter((e) => {
    if (levels && !levels.includes(e.level)) return false
    if (q.module !== undefined && e.module !== q.module) return false
    if (from !== undefined && e.ts < from) return false
    if (to !== undefined && e.ts > to) return false
    if (q.traceId !== undefined && e.traceId !== q.traceId) return false
    if (keyword !== undefined) {
      const haystack = (e.event + ' ' + (e.context ? JSON.stringify(e.context) : '')).toLowerCase()
      if (!haystack.includes(keyword)) return false
    }
    return true
  })

  // ts 倒序（最新在前）；相等时保持稳定顺序
  filtered.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))

  return filtered.slice(0, effectiveLimit(q.limit))
}
