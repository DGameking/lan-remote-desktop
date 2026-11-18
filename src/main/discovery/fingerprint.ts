import net from 'node:net'

/** 可识别的服务类型（仅做类型识别，不涉及任何鉴权/TLS/NLA 层） */
export type ServiceId = 'vnc' | 'ssh' | 'rdp' | 'smb' | 'http' | 'winrm' | 'afp' | 'unknown'

/** 单次服务探测结果 */
export interface ServiceFingerprint {
  port: number
  service: ServiceId
  version?: string
  osHint?: 'windows' | 'macos' | 'linux' | 'fnos' | 'unknown'
  raw?: string
}

/** 端口 → 探测方式的唯一事实来源 */
export interface ServiceProbe {
  kind: 'rfb' | 'ssh' | 'rdp' | 'http' | 'smb' | 'afp' | 'plain'
  send?: Buffer
  read: 'rfb12' | 'sshline' | 'httpHeaders' | 'rdpCC' | 'smbSig' | 'afpDsi' | 'none'
  deadlineMs: number
}

/** 最小 SMB1 Negotiate Protocol Request：服务端响应固定以 FF 53 4D 42 开头 */
const SMB_NEGOTIATE = Buffer.from([
  0xff, 0x53, 0x4d, 0x42, 0x72, 0x00, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, // word count = 0
  0x0c, 0x00, // byte count = 12
  0x02, 0x4e, 0x54, 0x20, 0x4c, 0x4d, 0x20, 0x30, 0x2e, 0x31, 0x32, 0x00 // \x02NT LM 0.12\x00
])

/**
 * TPKT + X.224 Connection Request。
 * 标准 RDP 服务端回 TPKT(03 00 ..) + X.224 Connection Confirm 首字节 0xD0。
 * 这里只取连接确认做类型判定，不进入 RDP 的 TLS/NLA 协商层。
 */
const RDP_CONNECTION_REQUEST = Buffer.from([
  0x03, 0x00, 0x00, 0x0b, // TPKT, length = 11
  0x06, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00 // X.224 CR
])

/** AFP/DSI FPGetSrvrInfo 请求，低优先级可选探测 */
const AFP_DSI_REQUEST = Buffer.from([0x00, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])

/** `<ip>` 占位符在 probeBanner 中按目标地址替换 */
const HTTP_HEAD = Buffer.from(
  'HEAD / HTTP/1.0\r\nHost: <ip>\r\nConnection: close\r\n\r\n',
  'latin1'
)

const RFB_PROBE: ServiceProbe = { kind: 'rfb', read: 'rfb12', deadlineMs: 800 }
const SSH_PROBE: ServiceProbe = { kind: 'ssh', read: 'sshline', deadlineMs: 800 }
const HTTP_PROBE: ServiceProbe = { kind: 'http', send: HTTP_HEAD, read: 'httpHeaders', deadlineMs: 800 }

export const SERVICE_PROBES: Record<number, ServiceProbe> = {
  22: SSH_PROBE,
  445: { kind: 'smb', send: SMB_NEGOTIATE, read: 'smbSig', deadlineMs: 800 },
  3389: { kind: 'rdp', send: RDP_CONNECTION_REQUEST, read: 'rdpCC', deadlineMs: 800 },
  548: { kind: 'afp', send: AFP_DSI_REQUEST, read: 'afpDsi', deadlineMs: 800 },
  5666: HTTP_PROBE,
  5985: HTTP_PROBE,
  5986: HTTP_PROBE,
  5900: RFB_PROBE,
  5901: RFB_PROBE,
  5902: RFB_PROBE,
  5903: RFB_PROBE,
  5904: RFB_PROBE,
  5905: RFB_PROBE,
  5906: RFB_PROBE,
  5907: RFB_PROBE,
  5908: RFB_PROBE,
  5909: RFB_PROBE,
  5910: RFB_PROBE
}

/** RFB 版本横幅：003.008 为标准 VNC，003.889 为 Apple 屏幕共享变体（强信号） */
export function parseRfbBanner(buf: Buffer, port = 0): ServiceFingerprint | null {
  if (!buf || buf.length < 12) return null
  const head = buf.subarray(0, 12).toString('latin1')
  const match = /^RFB (\d{3})\.(\d{3})\n$/.exec(head)
  if (!match) return null
  const version = `${match[1]}.${match[2]}`
  return {
    port,
    service: 'vnc',
    version,
    osHint: version === '003.889' ? 'macos' : undefined,
    raw: head
  }
}

/** SSH 版本横幅，软件串含 Linux 发行版字样时给出 linux 提示 */
export function parseSshBanner(buf: Buffer, port = 0): ServiceFingerprint | null {
  if (!buf || buf.length < 4) return null
  const text = buf.toString('latin1')
  const lineEnd = text.indexOf('\n')
  const line = (lineEnd >= 0 ? text.slice(0, lineEnd) : text).replace(/\r$/, '')
  const match = /^SSH-(\d+\.\d+)-(.+)$/.exec(line)
  if (!match) return null
  const osHint = /(linux|ubuntu|debian|centos|fedora|arch|redhat|suse)/i.test(match[2])
    ? 'linux'
    : undefined
  return { port, service: 'ssh', version: match[1], osHint, raw: line }
}

/** HTTP/1.x 响应头；Server 含 fnOS/飞牛 → fnos，5985/5986 视为 WinRM */
export function parseHttpHeaders(buf: Buffer, port = 0): ServiceFingerprint | null {
  if (!buf) return null
  const text = buf.toString('latin1')
  const end = text.indexOf('\r\n\r\n')
  if (end < 0) return null
  const headerText = text.slice(0, end)
  if (!/^HTTP\/\d\.\d\s+\d{3}/.test(headerText)) return null
  const server = /^Server:\s*(.+)$/im.exec(headerText)?.[1]?.trim()
  const osHint = server && /(fnos|飞牛)/i.test(server) ? 'fnos' : undefined
  const service: ServiceId = port === 5985 || port === 5986 ? 'winrm' : 'http'
  return { port, service, version: server, osHint, raw: headerText }
}

function parseForProbe(probe: ServiceProbe, buf: Buffer, port: number): ServiceFingerprint | null {
  switch (probe.read) {
    case 'rfb12':
      return parseRfbBanner(buf, port)
    case 'sshline':
      return parseSshBanner(buf, port)
    case 'httpHeaders':
      return parseHttpHeaders(buf, port)
    case 'smbSig':
      // SMB1/SMB2 响应均以 FF 53 4D 42 开头
      if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0x53 && buf[2] === 0x4d && buf[3] === 0x42) {
        return { port, service: 'smb', raw: buf.subarray(0, Math.min(buf.length, 64)).toString('hex') }
      }
      return null
    case 'rdpCC':
      // TPKT 版本字节 0x03 + 偏移 4 处 X.224 Connection Confirm 0xD0
      if (buf.length >= 5 && buf[0] === 0x03 && buf[4] === 0xd0) {
        return { port, service: 'rdp', osHint: 'windows', raw: buf.subarray(0, 5).toString('hex') }
      }
      return null
    case 'afpDsi':
      if (buf.length >= 8 && buf[0] === 0x00 && buf[1] === 0x04) {
        return { port, service: 'afp', raw: buf.subarray(0, 8).toString('hex') }
      }
      return null
    case 'none':
    default:
      return { port, service: 'unknown' }
  }
}

/**
 * 对单个 (ip, port) 做一次服务横幅探测。
 * 保证 socket 不泄漏：settled 守卫 + 绝对 setTimeout 兜底 + socket.setTimeout +
 * 累积多次 data + finish 里 destroy()/removeAllListeners()/clearTimeout()。
 */
export async function probeBanner(
  ip: string,
  port: number,
  probe: ServiceProbe,
  deadlineMs: number
): Promise<ServiceFingerprint | null> {
  const timeout = Math.max(50, deadlineMs || probe.deadlineMs || 800)

  return new Promise((resolve) => {
    let settled = false
    let connected = false
    let socket: net.Socket | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    const chunks: Buffer[] = []

    const finish = (result: ServiceFingerprint | null): void => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      const s = socket
      if (s) {
        s.removeAllListeners()
        s.destroy()
      }
      resolve(result)
    }

    const settleFromChunks = (): void => {
      const buf = chunks.length > 0 ? Buffer.concat(chunks) : Buffer.alloc(0)
      const parsed = parseForProbe(probe, buf, port)
      if (parsed) {
        finish(parsed)
        return
      }
      // 3389 弱判定：连接建立但服务端未返回任何横幅时，仍按端口判定为 RDP。
      // 不给出 osHint，避免把非 Windows 的 3389 监听误报为 Windows。
      if (probe.read === 'rdpCC' && connected && buf.length === 0) {
        finish({ port, service: 'rdp' })
        return
      }
      finish(null)
    }

    timer = setTimeout(settleFromChunks, timeout)

    try {
      socket = net.createConnection({ host: ip, port, family: 4 })
      const s = socket
      s.setTimeout(timeout)

      s.on('connect', () => {
        connected = true
        if (!probe.send || probe.send.length === 0) return
        let payload = probe.send
        if (payload.includes(Buffer.from('<ip>', 'latin1'))) {
          payload = Buffer.from(payload.toString('latin1').replace('<ip>', ip), 'latin1')
        }
        try {
          s.write(payload)
        } catch {
          settleFromChunks()
        }
      })

      s.on('data', (chunk: Buffer) => {
        chunks.push(Buffer.from(chunk))
        const parsed = parseForProbe(probe, Buffer.concat(chunks), port)
        if (parsed) finish(parsed)
      })

      s.once('timeout', settleFromChunks)
      s.once('error', settleFromChunks)
      s.once('close', settleFromChunks)
    } catch {
      finish(null)
    }
  })
}

export interface ProbeFingerprintsOptions {
  concurrency?: number
  shouldStop?: () => boolean
  onProgress?: (done: number, total: number) => void
}

/**
 * 对已开放端口批量做服务指纹识别，worker 池模型与 port-scan.ts 保持一致。
 */
export async function probeFingerprints(
  openMap: Map<string, number[]>,
  opts: ProbeFingerprintsOptions = {}
): Promise<Map<string, ServiceFingerprint[]>> {
  const concurrency = Math.max(1, opts.concurrency ?? 32)
  const tasks: Array<{ ip: string; port: number; probe: ServiceProbe }> = []

  for (const [ip, ports] of openMap) {
    for (const port of ports) {
      const probe = SERVICE_PROBES[port]
      if (probe) tasks.push({ ip, port, probe })
    }
  }

  const fingerprints = new Map<string, ServiceFingerprint[]>()
  let cursor = 0
  let done = 0

  const worker = async (): Promise<void> => {
    while (cursor < tasks.length) {
      if (opts.shouldStop?.()) return
      const task = tasks[cursor++]
      const fp = await probeBanner(task.ip, task.port, task.probe, task.probe.deadlineMs)
      if (fp) {
        const list = fingerprints.get(task.ip) ?? []
        list.push(fp)
        fingerprints.set(task.ip, list)
      }
      done += 1
      opts.onProgress?.(done, tasks.length)
    }
  }

  const workerCount = Math.min(concurrency, tasks.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return fingerprints
}
