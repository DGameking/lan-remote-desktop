import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ConnectRequest } from '../../shared/types'
import { logger } from '../logger'
import { availability, spawnDetached, type ProtocolAdapter } from './base'

const RDP_PORT = 3389

function mstscPath(): string {
  const root = process.env.SystemRoot || 'C:\\Windows'
  return path.join(root, 'System32', 'mstsc.exe')
}

/** RDP 适配器：生成临时 .rdp 文件并调起系统自带的 mstsc.exe */
export class RdpAdapter implements ProtocolAdapter {
  readonly id = 'rdp' as const
  readonly label = 'RDP 远程桌面'

  async isAvailable() {
    const executable = mstscPath()
    const available = process.platform === 'win32' && fs.existsSync(executable)
    return availability(
      this.id,
      this.label,
      available,
      available ? `已找到系统组件：${executable}` : '未找到 mstsc.exe（仅 Windows 专业版及以上内置）'
    )
  }

  async connect(request: ConnectRequest): Promise<string> {
    if (process.platform !== 'win32') {
      throw new Error('RDP 主控仅支持 Windows 系统')
    }
    if (!fs.existsSync(mstscPath())) {
      throw new Error('未找到 mstsc.exe，无法发起 RDP 连接')
    }

    // 安全红线（团长终裁）：密码绝不写入 .rdp，也绝不进入任何进程命令行（argv）。
    // Windows 进程命令行对同机其他进程可见（WMI/Process Explorer 可读），
    // cmdkey /pass:<明文> 等同明文泄露，故彻底移除 cmdkey 密码预置路径。
    // 凭据只由 mstsc 自身的凭据输入框承载（由用户在弹窗中手动输入）。
    const rdpLines = [
      'screen mode id:i:2',
      'use multimon:i:0',
      'desktopwidth:i:1920',
      'desktopheight:i:1080',
      'session bpp:i:32',
      `full address:s:${request.ip}:${RDP_PORT}`,
      'compression:i:1',
      'keyboardhook:i:2',
      'audiomode:i:0',
      'redirectdrives:i:0',
      'redirectprinters:i:0',
      'redirectcomports:i:0',
      'redirectsmartcards:i:0',
      'redirectclipboard:i:1',
      'autoreconnection enabled:i:1',
      'authentication level:i:2',
      'prompt for credentials:i:1',
      'negotiate security layer:i:1',
      'remoteapplicationmode:i:0',
      'gatewayusage method:i:0',
      ''
    ]
    // 安全红线：密码绝不写入 .rdp 文件，只能由用户在 mstsc 弹窗中手输，
    // 或在用户显式开启时用 cmdkey 预置到 Windows 凭据管理器。
    const tempFile = path.join(
      os.tmpdir(),
      `landesk-${request.ip.replace(/\./g, '-')}-${Date.now()}.rdp`
    )
    fs.writeFileSync(tempFile, rdpLines.join('\r\n'), 'utf8')

    try {
      await spawnDetached(mstscPath(), [tempFile])
      logger.info('已调起 mstsc', { ip: request.ip, rdpFile: tempFile })
      return '已调起 Windows 远程桌面，请在弹出的窗口中手动输入账号密码。'
    } catch (error) {
      try {
        fs.unlinkSync(tempFile)
      } catch {
        // 忽略清理失败
      }
      throw new Error(`调起 mstsc 失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
