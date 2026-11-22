/**
 * LanDesk 本地可观测性 —— 日志分片 / 清理规划纯函数。
 * 不直接操作 fs，只根据传入的文件元信息算出"该写哪个文件 / 该删哪些文件"。
 */

/** 识别当天分片：lanDesk-YYYY-MM-DD.jsonl（序号 1）或 lanDesk-YYYY-MM-DD.2.jsonl */
const SHARD_RE = /^lanDesk-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.jsonl$/
const LOG_FILE_RE = /\.(log|jsonl)$/i
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * @param files        logs 目录下已有文件的 { name, mtimeMs, size }
 * @param maxBytes     单个分片的大小上限，达到即切下一片
 * @param retentionDays 保留天数，mtime 早于阈值的日志文件进 deleteNames
 * @param nowMs        当前时间（可注入，便于测试）
 */
export function planRotation(
  files: { name: string; mtimeMs: number; size: number }[],
  maxBytes: number,
  retentionDays: number,
  nowMs: number
): { targetFile: string; deleteNames: string[] } {
  const date = new Date(nowMs).toISOString().slice(0, 10)
  const base = `lanDesk-${date}`

  // 收集当天已有的 .jsonl 分片及其序号
  const shards: { idx: number; size: number }[] = []
  for (const f of files) {
    const m = SHARD_RE.exec(f.name)
    if (!m || m[1] !== date) continue
    shards.push({ idx: m[2] ? Number(m[2]) : 1, size: f.size })
  }

  // 默认写当天主文件；若序号最大的分片已达上限，切到下一序号分片
  let targetFile = `${base}.jsonl`
  if (shards.length > 0) {
    const top = shards.reduce((a, b) => (b.idx > a.idx ? b : a))
    if (top.size >= maxBytes) {
      targetFile = `${base}.${top.idx + 1}.jsonl`
    } else if (top.idx > 1) {
      targetFile = `${base}.${top.idx}.jsonl`
    }
  }

  // 过期清理：.log 与 .jsonl 双后缀都识别，非日志文件不动
  const cutoff = nowMs - retentionDays * DAY_MS
  const deleteNames = files
    .filter((f) => LOG_FILE_RE.test(f.name) && f.mtimeMs < cutoff)
    .map((f) => f.name)

  return { targetFile, deleteNames }
}
