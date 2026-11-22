import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * 解析 `tasklist /PID <pid> /FO CSV` 的输出，判断其中是否含目标 PID。
 * 典型输出：
 *   "Image Name","PID","Session Name","Session#","Mem Usage"
 *   "mstsc.exe","12345","Console","1","50,000 K"
 * 抽成纯函数便于单测，不执行任何命令、不含任何 IP/凭据。
 *
 * 从 session/manager.ts 抽到本模块，供 rdp 临时文件清理复用，
 * 避免 protocols/rdp.ts 反向依赖 session/manager.ts 造成循环依赖。
 */
export function taskListCsvShowsPid(stdout: string, pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || !stdout) return false
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    const fields: string[] = []
    const re = /"([^"]*)"/g
    let match: RegExpExecArray | null
    while ((match = re.exec(line)) !== null) fields.push(match[1])
    if (fields.length < 2) continue
    // 跳过 CSV 表头行（第二列是 "PID" 文本）
    if (fields[1].trim().toUpperCase() === 'PID') continue
    const cell = fields[1].trim()
    if (!/^\d+$/.test(cell)) continue
    if (Number(cell) === pid) return true
  }
  return false
}

/**
 * 外部进程是否仍存活。Windows 用 tasklist 按 PID 精确查询；
 * 其它平台用 `kill(pid, 0)` 的 OS 存在性检查（不发送任何信号）。
 */
export async function isPidAlive(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync('tasklist', ['/PID', String(pid), '/FO', 'CSV'], {
        windowsHide: true,
        timeout: 5000
      })
      return taskListCsvShowsPid(String(stdout), pid)
    } catch {
      // tasklist 对不存在的 PID 返回非零退出码，视为已退出
      return false
    }
  }
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
