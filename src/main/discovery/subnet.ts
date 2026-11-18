import os from 'node:os'

export interface SubnetInfo {
  ip: string
  netmask: string
  cidr: string
  hosts: string[]
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

/**
 * 从系统网卡读取非 internal 的 IPv4 地址并计算待扫描主机列表。
 * 为避免 /16 等大网段导致扫描失控，掩码小于 /24 时收敛到本机所在 /24。
 */
export function detectSubnets(): SubnetInfo[] {
  const interfaces = os.networkInterfaces()
  const result: SubnetInfo[] = []
  const seen = new Set<string>()

  for (const addresses of Object.values(interfaces)) {
    if (!addresses) continue
    for (const address of addresses) {
      if (address.family !== 'IPv4' || address.internal) continue
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(address.address)) continue
      if (seen.has(address.address)) continue
      seen.add(address.address)

      const ipInt = ipToInt(address.address)
      const maskInt = ipToInt(address.netmask || '255.255.255.0')
      let prefix = netmaskToPrefix(address.netmask || '255.255.255.0')
      if (prefix < 8 || prefix > 32) prefix = 24
      if (prefix < 24) {
        // 收敛到 /24，只扫本机附近地址
        const narrowed = ipInt & 0xffffff00
        result.push(buildSubnet(address.address, '255.255.255.0', narrowed, 24))
        continue
      }
      const networkInt = (ipInt & maskInt) >>> 0
      result.push(buildSubnet(address.address, address.netmask, networkInt, prefix))
    }
  }

  // 优先返回私有网段，便于选中家庭/办公局域网
  return result.sort((a, b) => Number(isPrivateIp(b.ip)) - Number(isPrivateIp(a.ip)))
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
