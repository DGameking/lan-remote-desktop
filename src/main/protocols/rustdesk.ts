import fs from 'node:fs'
import { shell } from 'electron'
import type { ConnectRequest } from '../../shared/types'
import { logger } from '../logger'
import { getSettings } from '../store'
import { availability, findOnPath, spawnDetached, type ProtocolAdapter } from './base'

/** RustDesk 为 P2 可选能力：仅调起官方独立客户端，不内嵌/捆绑任何 AGPL 代码 */
export class RustDeskAdapter implements ProtocolAdapter {
  readonly id = 'rustdesk' as const
  readonly label = 'RustDesk（可选）'

  private async resolveExecutable(): Promise<string> {
    const candidates = [
      getSettings().rustdeskPath.trim(),
      'C:\\Program Files\\RustDesk\\rustdesk.exe',
      'C:\\Program Files (x86)\\RustDesk\\rustdesk.exe',
      await findOnPath('rustdesk.exe'),
      await findOnPath('rustdesk')
    ].filter((item) => item.length > 0)
    return candidates.find((candidate) => fs.existsSync(candidate)) ?? ''
  }

  async isAvailable() {
    const executable = await this.resolveExecutable()
    return availability(
      this.id,
      this.label,
      !!executable,
      executable
        ? `已找到 RustDesk 客户端：${executable}`
        : '未找到本机 RustDesk 客户端（可选能力，不影响 RDP/VNC 使用）'
    )
  }

  async connect(request: ConnectRequest): Promise<string> {
    const id = (request.rustdeskId || request.ip).trim()
    if (!id) throw new Error('缺少 RustDesk 设备 ID')
    const executable = await this.resolveExecutable()
    if (executable) {
      try {
        await spawnDetached(executable, ['--connect', id])
        logger.info('已调起 RustDesk 客户端', { id })
        return `已调起本机 RustDesk 客户端连接 ${id}。`
      } catch (error) {
        logger.warn('RustDesk 命令行调起失败，尝试协议链接', error)
      }
    }
    try {
      await shell.openExternal(`rustdesk://${id}`)
      logger.info('已通过 rustdesk:// 协议链接调起客户端', { id })
      return `已通过 rustdesk:// 协议链接调起客户端连接 ${id}。`
    } catch (error) {
      throw new Error(
        `调起 RustDesk 失败：${error instanceof Error ? error.message : String(error)}。请先安装 RustDesk 官方客户端。`
      )
    }
  }
}
