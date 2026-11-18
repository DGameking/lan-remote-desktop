import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ConnectRequest } from '../../shared/types'
import { logger } from '../logger'
import { getSettings } from '../store'
import { generateRdpPasswordHex, isRdpPasswordHex } from '../store/dpapi'
import { availability, spawnDetached, type ProtocolAdapter } from './base'

const RDP_PORT = 3389

function mstscPath(): string {
  const root = process.env.SystemRoot || 'C:\\Windows'
  return path.join(root, 'System32', 'mstsc.exe')
}

/**
 * 生成 .rdp 文件内容。抽成纯函数便于单测验证凭据模式与剪贴板/磁盘重定向开关。
 *
 * 安全红线：明文密码绝不写入 .rdp，也绝不进入任何进程命令行（argv）。
 * Windows 进程命令行对同机其他进程可见（WMI/Process Explorer 可读），故已彻底移除 cmdkey /pass:<明文> 路径。
 * 免密模式仅写入 DPAPI 保护、同机同用户有效的 blob hex（password 51:b:），并关闭凭据提示；
 * 无法生成合法 hex 时维持手输路径，不写任何账号密码字段。
 */
export function buildRdpContent(options: {
  ip: string
  port?: number
  clipboard: boolean
  driveRedirection: boolean
  username?: string
  passwordHex?: string
  domain?: string
}): string {
  const port = options.port && options.port > 0 ? options.port : RDP_PORT
  const passwordHex = options.passwordHex
  const autoLogin = !!passwordHex && isRdpPasswordHex(passwordHex)
  const lines: string[] = [
    // 显示与连接优化：跟随会话自适应分辨率、32 位色、局域网带宽自动检测
    'screen mode id:i:2',
    'use multimon:i:0',
    'desktopwidth:i:1920',
    'desktopheight:i:1080',
    'session bpp:i:32',
    `full address:s:${options.ip}:${port}`,
    'compression:i:1',
    'bandwidthautodetect:i:1',
    'connection type:i:6', // LAN（局域网）连接类型提示，减少广域网优化开销
    'keyboardhook:i:2',
    'audiomode:i:0',
    // 共享能力：剪贴板重定向由全局/本次会话开关控制（原生 RDP 能力）
    `redirectclipboard:i:${options.clipboard ? 1 : 0}`,
    // 磁盘重定向：把本机磁盘映射进远程会话，用于会话内文件传输（默认关闭，需显式开启）
    ...(options.driveRedirection
      ? ['drivestoredirect:s:*', 'redirectdrives:i:1']
      : ['drivestoredirect:s:', 'redirectdrives:i:0']),
    'redirectprinters:i:0',
    'redirectcomports:i:0',
    'redirectsmartcards:i:0',
    // 重连与安全
    'autoreconnection enabled:i:1',
    'authentication level:i:2',
    // 免密：写入受保护的凭据并关闭凭据提示；手输：保持提示，不写任何账号密码字段
    ...(autoLogin
      ? [
          ...(options.username ? [`username:s:${options.username}`] : []),
          ...(options.domain ? [`domain:s:${options.domain}`] : []),
          `password 51:b:${passwordHex}`,
          'prompt for credentials:i:0',
          'promptcredentialonce:i:1'
        ]
      : ['prompt for credentials:i:1']),
    'negotiate security layer:i:1',
    // CredSSP / NLA 保持系统默认，绝不为了跳过弹窗而降级为 0（避免中间人风险）
    'enablecredsspsupport:i:1',
    'remoteapplicationmode:i:0',
    'gatewayusage method:i:0',
    ''
  ]
  return lines.join('\r\n')
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

    const settings = getSettings()
    const clipboard = request.clipboardSharing ?? settings.clipboardSharing
    const driveRedirection = request.driveRedirection ?? settings.driveRedirection

    // request 即 SessionManager 回填保存凭据后的 resolved，password 仅存在于内存。
    // 转为 DPAPI blob hex 供 mstsc 免密；任何异常都降级为手输，不阻断连接。
    let passwordHex: string | undefined
    let autoLoginUnavailable = false
    if (request.password) {
      try {
        passwordHex = await generateRdpPasswordHex(request.password)
      } catch (error) {
        autoLoginUnavailable = true
        logger.warn('RDP 凭据转换失败，降级为手输', {
          ip: request.ip,
          message: error instanceof Error ? error.message : String(error)
        })
      }
    }

    const content = buildRdpContent({
      ip: request.ip,
      port: request.port,
      clipboard,
      driveRedirection,
      username: request.username,
      passwordHex
    })

    const tempFile = path.join(
      os.tmpdir(),
      `landesk-${request.ip.replace(/\./g, '-')}-${Date.now()}.rdp`
    )
    // 仅当前用户可读写，降低临时凭据文件泄露风险
    fs.writeFileSync(tempFile, content, { encoding: 'utf8', mode: 0o600 })

    try {
      await spawnDetached(mstscPath(), [tempFile])
      logger.info('已调起 mstsc', {
        ip: request.ip,
        rdpFile: tempFile,
        clipboard,
        driveRedirection,
        autoLogin: !!passwordHex
      })
      // mstsc 启动后会读取该文件；延时清理，避免密文长期残留在 %TEMP%
      setTimeout(() => {
        try {
          fs.unlinkSync(tempFile)
        } catch {
          // 清理失败静默忽略
        }
      }, 8000)

      const capabilityNotes: string[] = [
        clipboard ? '剪贴板共享：已开启' : '剪贴板共享：已关闭',
        driveRedirection ? '磁盘重定向：已开启（本机磁盘映射进远程会话）' : '磁盘重定向：已关闭'
      ]
      const complianceNote =
        '若本机启用了 Credential Guard 或组策略禁止保存凭据而弹出凭据框，属系统安全策略限制，本项目不绕过，请在凭据管理器手动添加 TERMSRV/<IP> 条目。'
      if (passwordHex) {
        return `已调起 Windows 远程桌面，已使用保存的凭据直连。${capabilityNotes.join('；')}。${complianceNote}`
      }
      if (autoLoginUnavailable) {
        return `已调起 Windows 远程桌面，自动登录不可用，请在窗口中手动输入账号密码。${capabilityNotes.join('；')}。`
      }
      return `已调起 Windows 远程桌面，请在弹出的窗口中手动输入账号密码。${capabilityNotes.join('；')}。`
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
