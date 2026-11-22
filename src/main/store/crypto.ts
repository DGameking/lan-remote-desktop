import { safeStorage } from 'electron'
import { logger } from '../logger'

/**
 * 凭据加解密：Electron safeStorage 在 Windows 上走 DPAPI，密钥由操作系统托管。
 * 落盘的是密文 base64，任何情况下都不写入明文密码。
 *
 * v1.5 迁移（P0-1）：
 * - 官方已将同步 API（isEncryptionAvailable/encryptString/decryptString）标记弃用，
 *   并确认将在 Electron 46 移除；本版本升级到 Electron 45，全面改用异步 API。
 * - 异步 API 非阻塞、支持密钥轮换（shouldReEncrypt），且官方明确
 *   「旧同步 API 加密的数据可由 decryptStringAsync 解密」——存量凭据无需清除。
 * - decryptStringAsync 返回 { result, shouldReEncrypt } 对象而非字符串，此处统一拆包。
 * - 保留对旧 Electron 的同步降级分支（运行时检测 API 是否存在），
 *   避免极端环境（用户自行动作导致 electron 版本回退）下凭据不可用。
 */

/** 运行时判断异步 API 是否可用（兼容旧 Electron / 测试 stub）。 */
function hasAsyncApi(): boolean {
  return (
    typeof safeStorage.isAsyncEncryptionAvailable === 'function' &&
    typeof safeStorage.encryptStringAsync === 'function' &&
    typeof safeStorage.decryptStringAsync === 'function'
  )
}

/** 加密可用性：异步 API 优先，旧环境回退同步检查。 */
export async function isEncryptionAvailable(): Promise<boolean> {
  try {
    if (hasAsyncApi()) return await safeStorage.isAsyncEncryptionAvailable()
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

/**
 * 加密明文密码，返回 base64 密文。
 * 密钥轮换提示（shouldReEncrypt）只发生在解密路径；加密恒产出当前密钥下的密文。
 */
export async function encryptPassword(plain: string): Promise<string> {
  if (!plain) return ''
  if (!(await isEncryptionAvailable())) {
    throw new Error('当前系统不支持凭据加密（safeStorage 不可用），未保存密码。')
  }
  if (hasAsyncApi()) {
    const buffer = await safeStorage.encryptStringAsync(plain)
    return buffer.toString('base64')
  }
  // 旧 Electron 降级路径（仅当异步 API 不存在时命中）
  return safeStorage.encryptString(plain).toString('base64')
}

/**
 * 解密 base64 密文，返回明文。
 *
 * 密钥轮换处理：官方约定 shouldReEncrypt=true 时需要再次调用 decryptStringAsync
 * 才能拿到新的解密串。此处按约定循环最多 3 次（防止异常实现导致死循环），
 * 并记录一条不带任何凭据内容的 WARN 日志，供诊断包观察轮换是否发生。
 */
export async function decryptPassword(cipher: string): Promise<string> {
  if (!cipher) return ''
  if (!(await isEncryptionAvailable())) {
    throw new Error('当前系统不支持凭据解密（safeStorage 不可用）。')
  }
  if (!hasAsyncApi()) {
    // 旧 Electron 降级路径
    return safeStorage.decryptString(Buffer.from(cipher, 'base64'))
  }
  let decoded = Buffer.from(cipher, 'base64')
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(decoded)
    if (!shouldReEncrypt) return result
    logger.warn('凭据密钥已轮换，按官方约定重新解密', { attempt: attempt + 1 })
    // 官方约定：shouldReEncrypt 时再次对同一密文调用 decryptStringAsync
    // 返回的新 result 即为新密钥下的明文；循环继续以防多轮换。
    decoded = Buffer.from(cipher, 'base64')
    if (attempt === 2) return result
  }
  return ''
}
