import fs from 'node:fs'
import path from 'node:path'
import type { ConnectRequest, DisplayMode } from '../../shared/types'
import { logger } from '../logger'
import { isPidAlive } from '../session/process-liveness'
import { getSettings } from '../store'
import { writeVncPasswordFile, type VncPasswordFile } from '../store/vnc-password'
import { availability, findOnPath, spawnDetached, type ProtocolAdapter } from './base'
import { removeTempFile, scheduleTempFileCleanup, tempFileHash } from './tempfile'

const DEFAULT_VNC_PORT = 5900

/**
 * v1.8: 生成 TigerVNC Viewer 的显示参数。全部来自官方手册 tigervnc.org/doc/vncviewer.html：
 * - fit:        -Maximize（窗口最大化自适应当前屏幕，保留标题栏便于切换）
 * - native:     不传尺寸参数（保持远程桌面原生分辨率，Viewer 默认窗口行为）
 * - fixed:      -DesktopSize=WxH 让服务端切到指定分辨率（需服务端支持 SetDesktopSize）
 * - fullscreen: -FullScreen -FullScreenMode=current（真全屏，铺满当前显示器）
 *
 * 说明：VNC 的"远程分辨率"由被控端 VNC 服务端决定，Viewer 只能通过
 * -DesktopSize 请求切换，且依赖服务端支持；这与 RDP 由客户端指定会话分辨率不同。
 * 非 TigerVNC（RealVNC/TightVNC）参数语法不同，返回空数组保守降级为 Viewer 默认行为。
 */
export function buildVncDisplayArgs(
  mode: DisplayMode,
  width: number | undefined,
  height: number | undefined,
  isTigerVnc: boolean
): string[] {
  if (!isTigerVnc) return []
  if (mode === 'native') return []
  if (mode === 'fit') return ['-Maximize']
  if (mode === 'fullscreen') return ['-FullScreen', '-FullScreenMode=current']
  // fixed：宽高校验后拼 WxH，防止异常值写出畸形参数
  const w = typeof width === 'number' && width >= 640 && width <= 7680 ? Math.floor(width) : 1920
  const h = typeof height === 'number' && height >= 480 && height <= 4320 ? Math.floor(height) : 1080
  return [`-DesktopSize=${w}x${h}`]
}

/** 常见 VNC Viewer 安装路径（仅探测，不随包分发任何 GPL 软件） */
const CANDIDATES = [
  'C:\\Program Files\\TigerVNC\\vncviewer.exe',
  'C:\\Program Files (x86)\\TigerVNC\\vncviewer.exe',
  'C:\\Program Files\\RealVNC\\VNC Viewer\\vncviewer.exe',
  'C:\\Program Files (x86)\\RealVNC\\VNC Viewer\\vncviewer.exe',
  'C:\\Program Files\\TightVNC\\tvnviewer.exe',
  'C:\\Program Files (x86)\\TightVNC\\tvnviewer.exe'
]

export class VncAdapter implements ProtocolAdapter {
  readonly id = 'vnc' as const
  readonly label = 'VNC 远程桌面'

  private async resolveViewer(configured: string): Promise<string> {
    const candidates = [
      configured.trim(),
      ...CANDIDATES,
      path.join(process.env.LOCALAPPDATA || '', 'TigerVNC', 'vncviewer.exe'),
      await findOnPath('vncviewer.exe'),
      await findOnPath('tvnviewer.exe')
    ].filter((item) => item.length > 0)
    return candidates.find((candidate) => fs.existsSync(candidate)) ?? ''
  }

  async isAvailable() {
    const executable = await this.resolveViewer(getSettings().vncViewerPath)
    return availability(
      this.id,
      this.label,
      !!executable,
      executable
        ? `已找到 VNC Viewer：${executable}`
        : '未找到 VNC Viewer，请在“设置 → VNC Viewer 路径”中指定，或安装 TigerVNC/RealVNC'
    )
  }

  async connect(request: ConnectRequest): Promise<string> {
    const executable = await this.resolveViewer(getSettings().vncViewerPath)
    if (!executable) {
      throw new Error(
        '未找到本机 VNC Viewer，请在设置→VNC Viewer 路径中指定，或安装 TigerVNC/RealVNC 后重试。'
      )
    }
    const port = request.port && request.port > 0 ? request.port : DEFAULT_VNC_PORT
    // v1.8: 会话级显示模式优先；未指定时沿用全局设置（默认 fit）
    const displayMode = request.displayMode ?? getSettings().displayMode ?? 'fit'

    // 仅 TigerVNC 的 vncviewer 支持 -PasswordFile=<路径> 免密；
    // RealVNC / TightVNC 的参数语法不同，此时不传密码文件，降级为手输，避免参数不识别导致启动失败。
    const isTigerVnc = executable.toLowerCase().includes('tigervnc')
    let passwordFile: VncPasswordFile | undefined
    let autoLoginUnavailable = false
    if (request.password && isTigerVnc) {
      try {
        passwordFile = writeVncPasswordFile(request.password)
      } catch (error) {
        autoLoginUnavailable = true
        logger.warn('VNC 密码文件生成失败，降级为手输', {
          ip: request.ip,
          message: error instanceof Error ? error.message : String(error)
        })
      }
    }

    // VNC Viewer 标准语法是单个参数 host::port；密码只通过临时文件传递，绝不进 argv。
    const args = [`${request.ip}::${port}`, ...buildVncDisplayArgs(displayMode, request.width, request.height, isTigerVnc)]
    if (passwordFile) args.push(`-PasswordFile=${passwordFile.file}`)

    try {
      const launched = await spawnDetached(executable, args)
      logger.info('已调起 VNC Viewer', {
        ip: request.ip,
        port,
        executable,
        displayMode,
        autoLogin: !!passwordFile,
        pid: launched.pid,
        ...(passwordFile ? { passwordFileHash: tempFileHash(passwordFile.file) } : {})
      })
      // 进程退出后清理 + 兜底定时器，参数与 rdp.ts 一致；失败记 WARN（哈希脱敏，不写路径）。
      if (passwordFile) {
        scheduleTempFileCleanup({
          filePath: passwordFile.file,
          pid: launched.pid,
          isAlive: isPidAlive
        })
      }

      const displayNote =
        displayMode === 'fixed'
          ? isTigerVnc
            ? '显示：已请求服务端切到指定分辨率（需服务端支持 SetDesktopSize，否则维持原分辨率）。'
            : '显示：当前 Viewer 不支持固定分辨率参数，沿用其默认窗口行为。'
          : displayMode === 'fullscreen'
            ? isTigerVnc
              ? '显示：已按当前显示器全屏启动。'
              : '显示：当前 Viewer 不支持自动全屏参数，请在 Viewer 内手动全屏。'
            : displayMode === 'fit'
              ? isTigerVnc
                ? '显示：窗口已最大化以贴合当前屏幕。'
                : '显示：沿用 Viewer 默认窗口行为。'
              : '显示：以远程桌面原生分辨率打开。'
      const riskNote = 'VNC 为明文协议，请仅在可信局域网使用。'
      if (passwordFile) {
        return `已调起 VNC Viewer，已使用保存的密码尝试自动登录。注意：密码文件只对「独立 VNC 密码（VncAuth）」生效；若被控端用 macOS 登录账号（Apple DH）认证，仍需在 Viewer 中手输账号密码。${displayNote}${riskNote}`
      }
      if (request.password && !isTigerVnc) {
        return `已调起 VNC Viewer，当前 Viewer 非 TigerVNC，不支持密码文件自动登录，请在窗口中手动输入 VNC 密码。${displayNote}${riskNote}`
      }
      if (autoLoginUnavailable) {
        return `已调起 VNC Viewer，自动登录不可用，请在窗口中手动输入 VNC 密码。${displayNote}${riskNote}`
      }
      return `已调起 VNC Viewer，请在窗口中手动输入 VNC 密码（若被控端用的是 macOS 登录账号而非独立 VNC 密码，需手输账号+密码）。${displayNote}${riskNote}`
    } catch (error) {
      // 调起失败立即清理（幂等），失败由 removeTempFile 内部记 WARN
      if (passwordFile) removeTempFile(passwordFile.file)
      throw new Error(
        `调起 VNC Viewer 失败：${error instanceof Error ? error.message : String(error)}。若目标无法连接，请确认被控端已开启屏幕共享/VNC 服务、${port} 端口可达，且本机 VNC Viewer 路径设置正确。`
      )
    }
  }
}
