import path from 'node:path'
import type { FileTransferResult, OsHint } from '../../shared/types'
import { logger } from '../logger'
import { spawnDetached } from './base'

/**
 * 文件传输通道：调起 Windows 资源管理器打开 \\IP\共享名。
 *
 * 设计红线：完全复用 Windows 自带的 SMB 客户端（资源管理器），
 * LanDesk 不实现任何文件传输协议、不捆绑任何第三方组件、不接触文件内容。
 * 被控端只需开启系统自带的文件共享（SMB）：
 *   - Windows：文件夹右键共享 / 启用网络发现
 *   - 飞牛OS：控制面板开启 SMB / 文件服务，用共享文件夹
 *   - macOS：系统设置 → 通用 → 共享 → 文件共享（SMB）
 *   - Linux：Samba 服务
 *
 * IP 与共享名在进入本函数前已经过 validators 严格校验（合法 IPv4 + 安全字符）。
 */
export function buildUncPath(ip: string, share: string): string {
  return share ? `\\\\${ip}\\${share}` : `\\\\${ip}`
}

function explorerPath(): string {
  const root = process.env.SystemRoot || 'C:\\Windows'
  return path.join(root, 'explorer.exe')
}

function hintGuide(hint: OsHint): string {
  switch (hint) {
    case 'windows':
      return 'Windows 端请确保已开启网络发现与文件共享，并记住共享名（如 \\\\IP\\共享名）。'
    case 'fnos':
      return '飞牛OS 请在控制面板开启 SMB/文件服务，并到“存储空间”查看共享文件夹名称。'
    case 'macos':
      return 'macOS 请在“系统设置 → 通用 → 共享”中开启“文件共享”，连接身份选 SMB。'
    case 'linux':
      return 'Linux 被控端需运行 Samba 服务并配置共享目录后，才能用 SMB 访问。'
    default:
      return '被控端需开启系统自带的 SMB/文件共享服务，并确认共享名。'
  }
}

/** 打开局域网设备的 SMB 共享文件夹（Windows 原生资源管理器） */
export async function openFileShare(target: {
  ip: string
  share: string
  hint: OsHint
}): Promise<FileTransferResult> {
  if (process.platform !== 'win32') {
    throw new Error('文件传输通道当前仅支持 Windows 主控端')
  }
  const unc = buildUncPath(target.ip, target.share)
  const executable = explorerPath()
  await spawnDetached(executable, [unc])
  logger.info('已调起资源管理器打开 SMB 共享', { ip: target.ip, share: target.share })
  const message = `已用资源管理器打开 ${unc}。若提示输入凭据，请填写被控端的系统账号密码。${hintGuide(target.hint)}`
  return { ok: true, message, path: unc }
}
