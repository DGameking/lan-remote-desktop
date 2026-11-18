import { safeStorage } from 'electron'

/**
 * 凭据加解密：Electron safeStorage 在 Windows 上走 DPAPI，密钥由操作系统托管。
 * 落盘的是密文 base64，任何情况下都不写入明文密码。
 */
export function encryptPassword(plain: string): string {
  if (!plain) return ''
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('当前系统不支持凭据加密（safeStorage 不可用），未保存密码。')
  }
  return safeStorage.encryptString(plain).toString('base64')
}

export function decryptPassword(cipher: string): string {
  if (!cipher) return ''
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('当前系统不支持凭据解密（safeStorage 不可用）。')
  }
  return safeStorage.decryptString(Buffer.from(cipher, 'base64'))
}

export function isEncryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}
