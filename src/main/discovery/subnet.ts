import os from 'node:os'
import { execFileSync } from 'node:child_process'

export interface SubnetInfo {
  ip: string
  netmask: string
  cidr: string
  hosts: string[]
  /** v1.4: 网卡分类，供 UI 标记「主网段 / 虚拟网卡」 */
  kind?: 'physical' | 'virtual'
  /** v1.4: 是否为系统默认路由所在网卡（真正的上网网卡） */
  isPrimary?: boolean
  /** v1.4: 网卡可读名称 */
  iface?: string
}

function ipToInt(ip: string): number {
  return (
    ip
      .split('.')
      .reduce((acc, part) => ((acc << 8) | (Number(part) & 0xff)) >>> 0, 0) >>> 0
  )
}

function intToIp(value: number): string {
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff
  ].join('.')
}

function netmaskToPrefix(mask: string): number {
  let bits = 0
  for (const part of mask.split('.')) {
    let value = Number(part) & 0xff
    while (value !== 0) {
      bits += value & 1
      value >>>= 1
    }
  }
  return bits
}

function isPrivateIp(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4) return false
  if (parts[0] === 10) return true
  if (parts[0] === 192 && parts[1] === 168) return true
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true
  return false
}

/** 虚拟网卡名称特征：VPN / 容器 / 虚拟机 / 系统保留适配器 */
const VIRTUAL_IFACE_RE =
  /(vethernet|hyper-v|wsl|docker|vmware|virtualbox|vbox|tap|tun|vpn|wireguard|openvpn|zerotier|tailscale|bluetooth|ndis|miniport|virtual|hyperv)/i

/** v1.4: 按网卡名与地址段特征判定是否虚拟网卡。 */
export function classifyInterface(ifaceName: string, ip: string): 'physical' | 'virtual' {
  if (VIRTUAL_IFACE_RE.test(ifaceName)) return 'virtual'
  // 172.17~172.31 是 Docker/容器与虚拟交换机常见占用段；真实路由器极少用
  const parts = ip.split('.').map(Number)
  if (parts[0] === 172 && parts[1] >= 17 && parts[1] <= 31) return 'virtual'
  return 'physical'
}

/**
 * v1.4: 读取系统默认路由指向的网卡 IP（真正的上网网卡）。
 * Windows 用 `route print 0.0.0.0`，解析 "0.0.0.0 ... 网关IP 接口IP 度量" 行。
 * 失败时返回 null，由调用方回退到启发式排序。
 */
export function detectPrimaryInterfaceIp(): string | null {
  // Windows：route print 0.0.0.0。QA P2：PATH 中不一定有 route.exe，
  // 优先用 SystemRoot\System32 绝对路径，失败再退回 PATH。
  if (process.platform === 'win32') {
    const candidates = ['route']
    const systemRoot = process.env.SystemRoot || 'C:\\Windows'
    candidates.unshift(`${systemRoot}\\System32\\route.exe`)
    for (const cmd of candidates) {
      try {
        const out = execFileSync(cmd, ['print', '0.0.0.0'], {
          encoding: 'utf8',
          timeout: 2000,
          windowsHide: true
        })
        // 目标行形如：  0.0.0.0   0.0.0.0   192.168.10.1   192.168.10.68   25
        // m[1]=网关，m[2]=本机接口地址。多条默认路由取第一条私有地址的（度量最小者在最前）。
        for (const line of out.split('\n')) {
          const m = line.match(
            /^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+\.\d+\.\d+\.\d+)\s+/
          )
          if (m && isPrivateIp(m[2])) return m[2]
        }
      } catch {
        // 该命令不可用，尝试下一个候选
      }
    }
    return null
  }

  // 非 Windows（macOS/Linux 主控端兼容）：用 `route -n get default` / `ip route` 取源地址。
  const probes: Array<[string, string[]]> = [
    ['route', ['-n', 'get', 'default']], // macOS
    ['ip', ['route', 'show', 'default']] // Linux
  ]
  for (const [cmd, args] of probes) {
    try {
      const out = execFileSync(cmd, args, { encoding: 'utf8', timeout: 2000 })
      // macOS: "interface: en0" + "gateway: x"; Linux: "default via X dev eth0 src Y"
      const src = /\bsrc\s+(\d+\.\d+\.\d+\.\d+)/.exec(out)?.[1]
      if (src && isPrivateIp(src)) return src
      // macOS 只给 interface 名，交由调用方按网卡名匹配（这里无法直接得 IP），跳过
    } catch {
      // 命令不可用，尝试下一个
    }
  }
  return null
}

/**
 * 从系统网卡读取非 internal 的 IPv4 地址并计算待扫描主机列表。
 * v1.4 修正排序：虚拟网卡整体垫底 → 默认路由网卡优先 → 物理网卡优先 → 私有网段优先。
 * 为避免 /16 等大网段导致扫描失控，掩码小于 /24 时收敛到本机所在 /24。
 */
export function detectSubnets(): SubnetInfo[] {
  const interfaces = os.networkInterfaces()
  const result: SubnetInfo[] = []
  const seen = new Set<string>()
  const primaryIp = detectPrimaryInterfaceIp()

  for (const [ifaceName, addresses] of Object.entries(interfaces)) {
    if (!addresses) continue
    for (const address of addresses) {
      if (address.family !== 'IPv4' || address.internal) continue
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(address.address)) continue
      if (seen.has(address.address)) continue
      seen.add(address.address)

      const kind = classifyInterface(ifaceName, address.address)
      const ipInt = ipToInt(address.address)
      const maskInt = ipToInt(address.netmask || '255.255.255.0')
      let prefix = netmaskToPrefix(address.netmask || '255.255.255.0')
      if (prefix < 8 || prefix > 32) prefix = 24
      let subnet: SubnetInfo
      if (prefix < 24) {
        const narrowed = ipInt & 0xffffff00
        subnet = buildSubnet(address.address, '255.255.255.0', narrowed, 24)
      } else {
        const networkInt = (ipInt & maskInt) >>> 0
        subnet = buildSubnet(address.address, address.netmask, networkInt, prefix)
      }
      subnet.kind = kind
      subnet.iface = ifaceName
      subnet.isPrimary = address.address === primaryIp
      result.push(subnet)
    }
  }

  return sortSubnets(result)
}

/**
 * v1.4 排序权重（QA P1-1 修正）：
 *   默认路由主网卡 > 物理网卡 > 私有网段 > 虚拟网卡垫底
 * 关键：isPrimary 必须优先于 virtual 惩罚。否则当用户真实路由器网段是
 * 172.20.x（被 classifyInterface 启发式标成 virtual）时，反会被非主物理网卡挤掉，
 * 与「优先选中真正上网网卡」的目标相悖。
 */
export function sortSubnets(list: SubnetInfo[]): SubnetInfo[] {
  return [...list].sort((a, b) => {
    const primaryDiff = Number(b.isPrimary === true) - Number(a.isPrimary === true)
    if (primaryDiff !== 0) return primaryDiff
    const virtualDiff = Number(a.kind === 'virtual') - Number(b.kind === 'virtual')
    if (virtualDiff !== 0) return virtualDiff
    return Number(isPrivateIp(b.ip)) - Number(isPrivateIp(a.ip))
  })
}

function buildSubnet(
  ip: string,
  netmask: string,
  networkInt: number,
  prefix: number
): SubnetInfo {
  const maskInt = ipToInt(netmask)
  const broadcastInt = (networkInt | (~maskInt >>> 0)) >>> 0
  const hosts: string[] = []
  // 跳过网络号与广播地址；/32 等极小网段包含自身
  const start = prefix >= 31 ? networkInt : (networkInt + 1) >>> 0
  const end = prefix >= 31 ? broadcastInt : (broadcastInt - 1) >>> 0
  for (let value = start; value <= end && hosts.length < 254; value = (value + 1) >>> 0) {
    if (value === 0 || value === 0xffffffff) continue
    hosts.push(intToIp(value))
  }
  return { ip, netmask, cidr: `${intToIp(networkInt)}/${prefix}`, hosts }
}

/** 供手动添加 / 输入校验使用：判断 IP 是否属于某个网段的主机列表 */
export function isIpInSubnet(ip: string, subnet: SubnetInfo): boolean {
  return subnet.hosts.includes(ip)
}

/** v1.4: 用 CIDR 判断 IP 归属（O(1)，不依赖 hosts 数组，供 mDNS/ARP 过滤用） */
export function subnetContainsIp(ip: string, subnet: SubnetInfo): boolean {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const prefix = Number(subnet.cidr.split('/')[1] ?? 24)
  // QA P2：非法 prefix 一律判否，避免 << 移位溢出导致误判整个网段
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return ((ipToInt(ip) & mask) >>> 0) === ((ipToInt(subnet.ip) & mask) >>> 0)
}

/** v1.4: 解析用户手动输入的网段，支持 192.168.10.0/24 与 192.168.10.68 两种写法 */
export function parseManualSubnet(input: string): SubnetInfo | null {
  const trimmed = input.trim()
  let network: string
  let prefix = 24
  const cidrMatch = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(trimmed)
  if (cidrMatch) {
    network = cidrMatch[1]
    prefix = Number(cidrMatch[2])
    if (prefix < 8 || prefix > 32) return null
    // QA P2：buildSubnet 上限 254 主机；对 /8~/23 宽网段收敛到本机所处 /24，
    // 避免声称扫 /8 实际只扫前 254 个地址的误导。与 detectSubnets 的收敛策略一致。
    if (prefix < 24) prefix = 24
  } else {
    const ipMatch = /^(\d{1,3}(?:\.\d{1,3}){3})$/.exec(trimmed)
    if (!ipMatch) return null
    network = ipMatch[1]
  }
  const parts = network.split('.').map(Number)
  if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
  const maskBits = (0xffffffff << (32 - prefix)) >>> 0
  const networkInt = (ipToInt(network) & maskBits) >>> 0
  const subnet = buildSubnet(network, intToIp(maskBits), networkInt, prefix)
  subnet.kind = 'physical'
  subnet.isPrimary = true
  subnet.iface = '手动指定'
  return subnet
}
