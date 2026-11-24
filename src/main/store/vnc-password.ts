import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * VNC (RFB VncAuth) 密码混淆。
 *
 * 算法（与 TigerVNC/RealVNC 的 vncpasswd 一致）：
 *   1. 取密码前 8 字节，不足补 0x00；
 *   2. 对每个字节做位反转（0x01 -> 0x80）；
 *   3. 以反转后的 8 字节作 DES key，ECB 模式加密一个全 0x00 的 8 字节块；
 *   4. 得到 8 字节二进制密文（此处以 16 位小写 hex 表示）。
 *
 * 安全说明：该算法只是「混淆」而非强加密，VNC 密码本身在协议层即弱保护。
 * 本模块只输出混淆后的字节，明文密码不写盘、不进 argv、不进日志。
 *
 * 不依赖 Node crypto 的 des-ecb —— OpenSSL 3 的 DES 在 legacy provider，默认被禁用，
 * 故这里以纯 JS 实现单块 DES（已用 NIST 标准向量与 openssl legacy 交叉验证）。
 */

// ---------- DES 置换表（标准 FIPS 46-3，1-indexed） ----------
const IP: readonly number[] = [
  58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4,
  59, 51, 43, 35, 27, 19, 11, 3, 61, 53, 45, 37, 29, 21, 13, 5,
  63, 55, 47, 39, 31, 23, 15, 7, 57, 49, 41, 33, 25, 17, 9, 1,
  62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8
]
const FP: readonly number[] = [
  40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31,
  38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29,
  36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27,
  34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25
]
const E: readonly number[] = [
  32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9,
  8, 9, 10, 11, 12, 13, 12, 13, 14, 15, 16, 17,
  16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25,
  24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1
]
const P: readonly number[] = [
  16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10,
  2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25
]
const PC1: readonly number[] = [
  57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18,
  10, 2, 59, 51, 43, 35, 27, 19, 11, 3, 60, 52, 44, 36,
  63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22,
  14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 28, 20, 12, 4
]
const PC2: readonly number[] = [
  14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10,
  23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2,
  41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48,
  44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32
]
const SHIFTS: readonly number[] = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1]
const S_BOXES: readonly (readonly number[])[] = [
  [14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7,
    0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8,
    4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0,
    15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13],
  [15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10,
    3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10, 6, 9, 11, 5,
    0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15,
    13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9],
  [10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8,
    13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1,
    13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7,
    1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12],
  [7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15,
    13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9,
    10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4,
    3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14],
  [2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9,
    14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6,
    4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14,
    11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3],
  [12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11,
    10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8,
    9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6,
    4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13],
  [4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1,
    13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6,
    1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2,
    6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12],
  [13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7,
    1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2,
    7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8,
    2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11]
]

/** 按表重排 input 的位；table 为 1-indexed，从输入最高位 counted。 */
function permute(input: bigint, inputBits: number, table: readonly number[]): bigint {
  let out = 0n
  for (let i = 0; i < table.length; i++) {
    out = (out << 1n) | ((input >> BigInt(inputBits - table[i])) & 1n)
  }
  return out
}

/** 由 64 位 key 生成 16 个 48 位子密钥；PC1 天然丢弃每字节最低位（DES 奇偶校验位）。 */
function buildSubKeys(key64: bigint): bigint[] {
  const pc1 = permute(key64, 64, PC1) // 56 bits
  let c = pc1 >> 28n
  let d = pc1 & 0x0fffffffn
  const keys: bigint[] = []
  for (let round = 0; round < 16; round++) {
    const shift = BigInt(SHIFTS[round])
    c = ((c << shift) | (c >> (28n - shift))) & 0x0fffffffn
    d = ((d << shift) | (d >> (28n - shift))) & 0x0fffffffn
    keys.push(permute((c << 28n) | d, 56, PC2))
  }
  return keys
}

/** Feistel f 函数：E 扩展 -> 异或子密钥 -> 8 个 S-box -> P 置换。 */
function feistel(r: bigint, subKey: bigint): bigint {
  const expanded = permute(r, 32, E) ^ subKey // 48 bits
  let sOut = 0n
  for (let i = 0; i < 8; i++) {
    const six = Number((expanded >> BigInt(42 - i * 6)) & 0x3fn)
    const row = ((six & 0x20) >> 4) | (six & 0x01)
    const col = (six >> 1) & 0x0f
    sOut = (sOut << 4n) | BigInt(S_BOXES[i][row * 16 + col])
  }
  return permute(sOut, 32, P)
}

/** 单块 DES 加密（ECB 的一个块）。 */
function desEncryptBlock(block: bigint, subKeys: bigint[]): bigint {
  const ip = permute(block, 64, IP)
  let l = ip >> 32n
  let r = ip & 0xffffffffn
  for (let round = 0; round < 16; round++) {
    const nextL = r
    const nextR = l ^ feistel(r, subKeys[round])
    l = nextL
    r = nextR
  }
  // 16 轮后交换 R16||L16，再做最终置换
  return permute((r << 32n) | l, 64, FP)
}

/** 单字节位反转：最低位变最高位，依此类推。 */
export function reverseBits(byte: number): number {
  let out = 0
  for (let i = 0; i < 8; i++) {
    if (byte & (1 << i)) out |= 1 << (7 - i)
  }
  return out
}

/**
 * 把密码混淆为 16 位小写 hex（8 字节二进制的十六进制表示）。纯函数。
 */
export function obfuscateVncPassword(password: string): string {
  const passwordBytes = Buffer.from(password, 'utf8')
  let key = 0n
  for (let i = 0; i < 8; i++) {
    const byte = i < passwordBytes.length ? reverseBits(passwordBytes[i]) : 0
    key = (key << 8n) | BigInt(byte)
  }
  const cipher = desEncryptBlock(0n, buildSubKeys(key))
  return cipher.toString(16).padStart(16, '0')
}

export interface VncPasswordFile {
  /** 临时文件路径（仅混淆后的 8 字节，绝不含明文）。 */
  file: string
  /** 幂等删除临时文件；不记日志（避免把路径写进日志）。 */
  cleanup: () => void
}

/**
 * 把混淆后的 8 字节二进制写入临时文件（VNC password 文件是二进制，不是 hex 文本）。
 * 文件仅当前用户可读写（mode 0o600，Windows 上 Node 会模拟为仅 owner 可写）。
 *
 * @param password 明文密码（仅存在于内存，不写盘、不进 argv、不进日志）
 * @param filePath 可选路径，测试可指定；默认在 os.tmpdir() 下生成唯一文件名
 */
export function writeVncPasswordFile(password: string, filePath?: string): VncPasswordFile {
  const file =
    filePath ??
    path.join(
      os.tmpdir(),
      `landesk-vnc-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}.passwd`
    )
  const obfuscated = Buffer.from(obfuscateVncPassword(password), 'hex') // 8 字节二进制
  fs.writeFileSync(file, obfuscated, { mode: 0o600 })

  let cleaned = false
  return {
    file,
    cleanup: () => {
      if (cleaned) return
      cleaned = true
      try {
        fs.unlinkSync(file)
      } catch {
        // ENOENT（已清理）或删除失败：幂等，静默；不把路径写进日志
      }
    }
  }
}
