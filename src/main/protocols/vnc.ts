import fs from 'node:fs'
import path from 'node:path'
import type { ConnectRequest } from '../../shared/types'
import { logger } from '../logger'
import { getSettings } from '../store'
import { availability, findOnPath, spawnDetached, type ProtocolAdapter } from './base'

const DEFAULT_VNC_PORT = 5900

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
        : '未找到 VNC Viewer，请在“设置”中指定 vncviewer.exe / tvnviewer.exe 路径'
    )
  }

  async connect(request: ConnectRequest): Promise<string> {
    const executable = await this.resolveViewer(getSettings().vncViewerPath)
    if (!executable) {
      throw new Error('未找到本机 VNC Viewer。请在“设置 → VNC Viewer 路径”中指定可执行文件后重试。')
    }
    const port = request.port && request.port > 0 ? request.port : DEFAULT_VNC_PORT
    // VNC Viewer 标准语法是单个参数 host::port。
    // 密码不通过命令行传递（会暴露在进程列表），由用户在 Viewer 窗口手动输入。
    await spawnDetached(executable, [`${request.ip}::${port}`])
    logger.info('已调起 VNC Viewer', { ip: request.ip, port, executable })
    return '已调起 VNC Viewer，请在窗口中手动输入 VNC 密码（VNC 明文风险，请仅在可信局域网使用）。'
  }
}
