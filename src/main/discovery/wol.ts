import dgram from 'node:dgram'

/**
 * Wake-on-LAN 魔术包纯函数与底层 UDP 发送。
 * 仅依赖 Node 内置 node:dgram，不发起公网请求、不驻留后台句柄。
 * MAC 属设备标识，任何日志 / 返回信息都不应包含它。
 */

const MAC_COLON =
  /^([0-9a-fA-F]{2}):([0-9a-fA-F]{2}):([0-9a-fA-F]{2}):([0-9a-fA-F]{2}):([0-9a-fA-F]{2}):([0-9a-fA-F]{2})$/
const MAC_DASH =
  /^([0-9a-fA-F]{2})-([0-9a-fA-F]{2})-([0-9a-fA-F]{2})-([0-9a-fA-F]{2})-([0-9a-fA-F]{2})-([0-9a-fA-F]{2})$/
const MAC_DOT = /^([0-9a-fA-F]{4})\.([0-9a-fA-F]{4})\.([0-9a-fA-F]{4})$/
const MAC_PLAIN = /^[0-9a-fA-F]{12}$/

/** 解析 MAC 为 6 字节 Buffer；非法 / 全 0 / 全 F 广播 MAC 返回 null。 */
export function parseMac(mac: string): Buffer | null {
  if (typeof mac !== 'string') return null
  const value = mac.trim()

  let hex: string
  if (MAC_PLAIN.test(value)) {
    hex = value
  } else if (MAC_COLON.test(value)) {
    hex = value.replace(/:/g, '')
  } else if (MAC_DASH.test(value)) {
    hex = value.replace(/-/g, '')
  } else if (MAC_DOT.test(value)) {
    hex = value.replace(/\./g, '')
  } else {
    return null
  }

  const upper = hex.toUpperCase()
  if (upper === '000000000000' || upper === 'FFFFFFFFFFFF') return null

  const bytes = Buffer.from(hex, 'hex')
  return bytes.length === 6 ? bytes : null
}

/** 6 字节 0xFF + MAC 重复 16 次 = 102 字节魔术包；非法 MAC 返回 null。 */
export function buildMagicPacket(mac: string): Buffer | null {
  const bytes = parseMac(mac)
  if (bytes === null) return null

  const packet = Buffer.alloc(102)
  packet.fill(0xff, 0, 6)
  for (let i = 0; i < 16; i++) {
    bytes.copy(packet, 6 + i * 6)
  }
  return packet
}

/**
 * 由 CIDR 计算定向广播地址，仅支持 /24；非 /24 或非法返回 null，
 * 调用方应回落 '255.255.255.255'。
 */
export function broadcastForCidr(cidr: string): string | null {
  if (typeof cidr !== 'string') return null
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidr.trim())
  if (match === null) return null
  if (Number(match[5]) !== 24) return null

  const octets = [match[1], match[2], match[3], match[4]].map(Number)
  if (octets.some((n) => n < 0 || n > 255)) return null

  // /24 定向广播：网络前三段不变，主机位全 1
  return `${octets[0]}.${octets[1]}.${octets[2]}.255`
}

export interface WolSendOptions {
  mac: string
  broadcast?: string
  port?: number
}

const DEFAULT_BROADCAST = '255.255.255.255'
const DEFAULT_PORT = 9
const SEND_TIMEOUT_MS = 3000
const BEST_EFFORT_NOTE =
  '（UDP 无送达回执，请确认被控端 BIOS/网卡已开启 WoL 且使用有线连接，仅同网段有效）'

/** 广播地址必须是 IPv4 字面量且落在局域网，杜绝 hostname 解析与向公网发包。 */
function isLanBroadcastTarget(value: string): boolean {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return false
  const parts = value.split('.').map(Number)
  if (parts.some((n) => n < 0 || n > 255)) return false
  const [a, b] = parts
  if (value === DEFAULT_BROADCAST) return true
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

/**
 * 发送 WoL 魔术包（best-effort）。UDP 无送达回执，成功仅表示「已发出」，不代表设备已开机。
 * absolute timeout 3s + settled guard + close + removeAllListeners，绝不悬挂句柄或抛异常。
 */
export async function sendWakeOnLan(
  options: WolSendOptions
): Promise<{ ok: boolean; message: string; broadcast: string }> {
  const broadcast = options.broadcast ?? DEFAULT_BROADCAST
  const port = options.port ?? DEFAULT_PORT

  const packet = buildMagicPacket(options.mac)
  if (packet === null) {
    return {
      ok: false,
      message: 'MAC 地址格式非法，请提供 6 字节硬件地址（如 AA:BB:CC:DD:EE:FF）',
      broadcast
    }
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, message: '唤醒端口必须是 1..65535 的整数，已拒绝', broadcast }
  }
  if (!isLanBroadcastTarget(broadcast)) {
    return {
      ok: false,
      message: '广播地址必须是局域网 IPv4 或 255.255.255.255，已拒绝（不接受主机名或公网地址）',
      broadcast
    }
  }

  return new Promise((resolve) => {
    let settled = false
    let socket: dgram.Socket | null = null
    let timer: ReturnType<typeof setTimeout> | null = null

    const finish = (ok: boolean, message: string): void => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      if (socket !== null) {
        socket.removeAllListeners()
        try {
          socket.close()
        } catch {
          // 关闭阶段的二次异常忽略，settled guard 已保证只结算一次
        }
      }
      resolve({ ok, message, broadcast })
    }

    try {
      const sock = dgram.createSocket('udp4')
      socket = sock

      // absolute timeout：无论 bind / send 回调是否触发，3s 后必定结算并释放句柄
      timer = setTimeout(
        () => finish(false, '发送唤醒魔术包超时，请检查本机网络与广播地址'),
        SEND_TIMEOUT_MS
      )

      sock.once('error', (err) => {
        finish(false, `发送唤醒魔术包失败：${err.message}，请检查本机网络与广播地址`)
      })

      sock.bind(0, () => {
        if (settled) return
        try {
          sock.setBroadcast(true)
        } catch {
          finish(false, '当前网络不支持 UDP 广播，请检查本机网络适配器设置')
          return
        }
        sock.send(packet, 0, packet.length, port, broadcast, (err) => {
          if (err) {
            finish(false, `发送唤醒魔术包失败：${err.message}，请检查广播地址与网络`)
            return
          }
          finish(true, `已向 ${broadcast} 发送唤醒魔术包${BEST_EFFORT_NOTE}`)
        })
      })
    } catch (e) {
      const reason = e instanceof Error ? e.message : '未知错误'
      finish(false, `初始化 UDP 套接字失败：${reason}`)
    }
  })
}
