import { spawn } from 'node:child_process'

/**
 * RDP 免密所需凭据格式：ConvertFrom-SecureString 输出的裸 DPAPI blob 小写 hex，
 * 对应 mstsc 的 `password 51:b:` 字段。密文仅在同机同用户下可解密。
 * 注意：Electron safeStorage / OSCrypt v10 的 base64 输出与此不兼容，绝不可复用。
 */

// 脚本固定为常量；明文密码绝不拼接进脚本或 argv，只经 stdin 管道传入。
const PS_SCRIPT =
  '$ErrorActionPreference="Stop";$p=[Console]::In.ReadToEnd();$s=ConvertTo-SecureString $p -AsPlainText -Force;ConvertFrom-SecureString $s'

const PS_TIMEOUT_MS = 8000
const DPAPI_HEX_PREFIX = '01000000d08c9ddf'

/**
 * 把 DPAPI blob hex 归一化为小写（纯函数，便于单测，不触碰任何敏感数据）。
 * PowerShell 的 ConvertFrom-SecureString 在不同版本/区域设置下可能输出大写 hex，
 * 而 mstsc 对 `password 51:b:` 的取值大小写不敏感；统一小写可避免免密静默降级。
 */
export function normalizeRdpPasswordHex(value: string): string {
  return value.toLowerCase()
}

/**
 * 校验是否为合法的 DPAPI blob hex（纯函数，便于单测，不触碰任何敏感数据）。
 * 大小写不敏感：前缀用小写比对，字符集合法性允许 A-F，避免大写输出被误判为非法。
 */
export function isRdpPasswordHex(value: string): boolean {
  if (!value || value.length % 2 !== 0) return false
  if (!normalizeRdpPasswordHex(value).startsWith(DPAPI_HEX_PREFIX)) return false
  return /^[0-9a-fA-F]+$/.test(value)
}

/**
 * 将明文密码转换为 mstsc 可识别的 DPAPI blob hex。
 * 明文只经 stdin 传递，绝不进入 argv、磁盘文件或日志。
 */
export function generateRdpPasswordHex(password: string): Promise<string> {
  if (process.platform !== 'win32') {
    return Promise.reject(new Error('生成 RDP 凭据仅支持 Windows 系统'))
  }

  return new Promise<string>((resolve, reject) => {
    let settled = false
    let stdout = ''
    let stderr = ''

    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', PS_SCRIPT],
      { windowsHide: true, shell: false }
    )

    const timer = setTimeout(() => {
      fail(new Error('生成 RDP 凭据超时（PowerShell 8 秒内未返回）'))
      child.kill()
    }, PS_TIMEOUT_MS)

    function cleanup(): void {
      clearTimeout(timer)
    }

    function succeed(hex: string): void {
      if (settled) return
      settled = true
      cleanup()
      resolve(hex)
    }

    function fail(error: Error): void {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.stdin?.on('error', (error: Error) => {
      fail(new Error(`写入凭据失败：${error.message}`))
    })
    child.on('error', (error: Error) => {
      fail(new Error(`无法启动 PowerShell 生成 RDP 凭据：${error.message}`))
    })
    child.on('close', (code: number | null) => {
      if (settled) return
      if (code !== 0) {
        const detail = stderr.trim().slice(0, 300)
        fail(
          new Error(
            `PowerShell 生成 RDP 凭据失败（退出码 ${code ?? 'unknown'}）${detail ? `：${detail}` : ''}`
          )
        )
        return
      }
      const hex = stdout.replace(/[\r\n]/g, '').trim()
      if (!isRdpPasswordHex(hex)) {
        fail(new Error('PowerShell 返回的凭据格式不符合 DPAPI blob 规范，已放弃自动登录'))
        return
      }
      // 归一化为小写后再返回，保证写入 .rdp 的 blob hex 格式稳定（大小写不影响可用性）
      succeed(normalizeRdpPasswordHex(hex))
    })

    if (!child.stdin) {
      fail(new Error('无法写入凭据：PowerShell 标准输入不可用'))
      return
    }
    try {
      child.stdin.end(password, 'utf8')
    } catch (error) {
      fail(new Error(`写入凭据失败：${error instanceof Error ? error.message : String(error)}`))
    }
  })
}
