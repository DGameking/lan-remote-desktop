import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface ArpEntry {
  ip: string
  mac: string
}

/**
 * 只读解析系统 ARP 表补充在线候选 IP。
 * 仅调用 `arp -a` 读取，不执行任何 ARP 写入或网络欺骗操作。
 * 非 Windows 平台或权限不足时返回空列表，由上层降级处理。
 */
export async function readArpTable(): Promise<ArpEntry[]> {
  if (process.platform !== 'win32') return []
  try {
    const { stdout } = await execFileAsync('arp', ['-a'], {
      timeout: 3000,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024
    })
    const entries: ArpEntry[] = []
    const seen = new Set<string>()
    // Windows 典型行：`192.168.1.1   aa-bb-cc-dd-ee-ff   dynamic`
    const pattern = /^\s*(\d{1,3}(?:\.\d{1,3}){3})\s+([0-9a-fA-F]{2}(?:-[0-9a-fA-F]{2}){5})\s+(dynamic|static)/gm
    let match: RegExpExecArray | null
    while ((match = pattern.exec(stdout)) !== null) {
      const ip = match[1]
      if (seen.has(ip)) continue
      seen.add(ip)
      entries.push({ ip, mac: match[2].replace(/-/g, ':').toUpperCase() })
    }
    return entries
  } catch {
    return []
  }
}
