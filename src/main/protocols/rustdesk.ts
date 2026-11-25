import fs from 'node:fs'
import { shell } from 'electron'
import { normalizeRustdeskId } from '../../shared/rustdesk-id'
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
    // v1.9: 会话码走白名单规范化；兼容历史上用 IPv4 承载目标的调用方。
    const id =
      normalizeRustdeskId(request.rustdeskId) ??
      normalizeRustdeskId(request.ip) ??
      (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(request.ip?.trim() ?? '') ? request.ip.trim() : '')
    if (!id) {
      throw new Error('缺少合法的 RustDesk 会话码（仅支持字母、数字、下划线、连字符，1-64 位）')
    }
    const executable = await this.resolveExecutable()
    if (executable) {
      try {
        await spawnDetached(executable, ['--connect', id])
        logger.info('已调起 RustDesk 客户端', { id })
        return this.successMessage(id)
      } catch (error) {
        logger.warn('RustDesk 命令行调起失败，尝试协议链接', error)
      }
    }
    try {
      // 会话码已过白名单（仅字母数字/下划线/连字符），encodeURIComponent 仅作纵深防御
      await shell.openExternal(`rustdesk://${encodeURIComponent(id)}`)
      logger.info('已通过 rustdesk:// 协议链接调起客户端', { id })
      return this.successMessage(id)
    } catch (error) {
      throw new Error(
        `调起 RustDesk 失败：${error instanceof Error ? error.message : String(error)}。请先安装 RustDesk 官方客户端。`
      )
    }
  }

  /** 统一返回口径：如实披露会话码/P2P/中继是外部 RustDesk 能力，非 LanDesk 自研 */
  private successMessage(id: string): string {
    return (
      `已调起本机 RustDesk 官方客户端连接 ${id}。` +
      '会话码、P2P 打洞与中继由 RustDesk 客户端及其服务端提供（非 LanDesk 自研）；' +
      '如需跨网连接，请先在两端 RustDesk 客户端配置同一个自托管 ID 服务器，详见 README「跨网与自托管 RustDesk」。'
    )
  }
}
