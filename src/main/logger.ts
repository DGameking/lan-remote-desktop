import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

/**
 * 本地文件日志：写入 userData/logs，仅保留最近 30 天。
 * 不采集任何被控画面、键盘记录或明文凭据。
 */
let logDir = ''
let initialized = false

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

function cleanup(): void {
  try {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
    for (const name of fs.readdirSync(logDir)) {
      if (!name.endsWith('.log')) continue
      const file = path.join(logDir, name)
      if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file)
    }
  } catch {
    // 清理失败不影响主流程
  }
}

function write(level: 'INFO' | 'WARN' | 'ERROR', message: string, extra?: unknown): void {
  ensureDir()
  const line = `[${new Date().toISOString()}] [${level}] ${message}${extra === undefined ? '' : ' ' + safeStringify(extra)}\n`
  if (!logDir) return
  try {
    fs.appendFileSync(path.join(logDir, `lanDesk-${new Date().toISOString().slice(0, 10)}.log`), line, 'utf8')
  } catch {
    // 日志失败不影响主流程
  }
}

function safeStringify(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export const logger = {
  info(message: string, extra?: unknown): void {
    write('INFO', message, extra)
  },
  warn(message: string, extra?: unknown): void {
    write('WARN', message, extra)
  },
  error(message: string, extra?: unknown): void {
    write('ERROR', message, extra)
  }
}
