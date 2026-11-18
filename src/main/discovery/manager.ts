import type { ScanProgress } from '../../shared/types'
import { logger } from '../logger'
import { aggregateAndPersist, resetOnlineFlags, type DeviceCandidate } from './aggregator'
import { readArpTable, type ArpEntry } from './arp'
import { probeFingerprints } from './fingerprint'
import { browseMdns } from './mdns'
import { scanPorts } from './port-scan'
import { detectSubnets, type SubnetInfo } from './subnet'

/** L1 存活快扫端口：覆盖常见原生远程管理 / 文件共享能力 */
export const L1_PORTS = [22, 445, 3389, 5900, 5666] as const
/** L2 长尾端口：VNC 显示号段、WinRM、AFP、Web 管理、RustDesk */
export const L2_PORTS = [
  5901, 5902, 5903, 5904, 5905, 5906, 5907, 5908, 5909, 5910,
  5985, 5986, 548, 8000, 8001, 21116
] as const

/** 扫描编排：网段计算 → ARP/mDNS 并行启动 → L1 快扫 → L2 深扫 → banner 指纹 → 汇总落库 */
export class ScanManager {
  private scanning = false
  private stopRequested = false
  private currentSubnet = ''
  private subnets: SubnetInfo[] = []

  private progressHandler: (progress: ScanProgress) => void

  constructor(onProgress: (progress: ScanProgress) => void) {
    this.progressHandler = onProgress
  }

  /** 窗口创建后重新绑定进度推送目标 */
  setOnProgress(handler: (progress: ScanProgress) => void): void {
    this.progressHandler = handler
  }

  get isScanning(): boolean {
    return this.scanning
  }

  get subnet(): string {
    return this.currentSubnet
  }

  getSubnets(): SubnetInfo[] {
    return this.subnets
  }

  private emit(phase: ScanProgress['phase'], percent: number, message: string, devices = [] as ScanProgress['devices']): void {
    this.progressHandler({
      phase,
      percent: Math.max(0, Math.min(100, Math.round(percent))),
      message,
      subnet: this.currentSubnet,
      devices
    })
  }

  stop(): void {
    if (!this.scanning) return
    this.stopRequested = true
    this.scanning = false
    this.emit('stopped', 100, '扫描已停止')
    logger.info('扫描已由用户停止')
  }

  /** L2 主机列表：L1 存活 IP + ARP 种子（受 ARP 条目数限制），ARP 命中的优先派发 */
  private buildL2Hosts(aliveIps: string[], arpEntries: ArpEntry[]): string[] {
    const arpIps = arpEntries.map((entry) => entry.ip)
    const arpSet = new Set(arpIps)
    const hosts = [...new Set([...aliveIps, ...arpIps])]
    hosts.sort((a, b) => Number(arpSet.has(b)) - Number(arpSet.has(a)))
    return hosts
  }

  async start(): Promise<{ subnet: string }> {
    if (this.scanning) throw new Error('扫描正在进行中')
    this.subnets = detectSubnets()
    const target = this.subnets[0]
    if (!target) throw new Error('未检测到可用的局域网 IPv4 网卡，请检查网络连接')

    this.currentSubnet = target.cidr
    this.scanning = true
    this.stopRequested = false
    this.emit('subnet', 3, `已识别网段 ${target.cidr}，共 ${target.hosts.length} 个候选地址`)

    try {
      resetOnlineFlags()

      // mDNS 提前发起，与端口扫描并行；末尾统一 await 汇总，避免串行等待。
      const mdnsPromise = browseMdns(2500).catch((error) => {
        logger.warn('mDNS 发现失败，已跳过', error)
        return []
      })

      // ARP 提前读取，作为 L2 存活种子（仅保留本网段条目，数量天然受限）。
      let arpEntries: ArpEntry[] = []
      try {
        const inSubnet = new Set(target.hosts)
        arpEntries = (await readArpTable()).filter((entry) => inSubnet.has(entry.ip))
      } catch (error) {
        logger.warn('ARP 表读取失败，已跳过', error)
      }

      // L1：对所有候选地址做少量端口快扫，找出存活主机（5% → 45%）。
      const l1Map = await scanPorts(
        target.hosts,
        [...L1_PORTS],
        {
          concurrency: 128,
          timeout: 300,
          shouldStop: () => this.stopRequested
        },
        (done, total) => {
          if (!this.stopRequested) {
            this.emit('ports', 5 + (40 * done) / total, `存活快扫中 ${done}/${total}`)
          }
        }
      )
      if (this.stopRequested) return { subnet: this.currentSubnet }
      this.emit('ports', 45, `存活快扫完成，发现 ${l1Map.size} 个存活地址`)

      // L2：仅对存活 IP 与 ARP 种子做长尾端口深扫（45% → 58%）。
      const l2Hosts = this.buildL2Hosts([...l1Map.keys()], arpEntries)
      const l2Map = l2Hosts.length
        ? await scanPorts(
            l2Hosts,
            [...L2_PORTS],
            {
              concurrency: 64,
              timeout: 300,
              shouldStop: () => this.stopRequested
            },
            (done, total) => {
              if (!this.stopRequested) {
                this.emit('ports', 45 + (13 * done) / total, `端口深扫中 ${done}/${total}`)
              }
            }
          )
        : new Map<string, number[]>()
      if (this.stopRequested) return { subnet: this.currentSubnet }
      this.emit('ports', 58, '端口深扫完成，正在识别服务指纹')

      const portMap = new Map<string, number[]>()
      for (const [ip, ports] of l1Map) portMap.set(ip, [...ports])
      for (const [ip, ports] of l2Map) {
        const merged = new Set([...(portMap.get(ip) ?? []), ...ports])
        portMap.set(ip, [...merged])
      }

      // L3：对 L1+L2 的全部 (ip, port) 读服务横幅（58% → 70%）。
      const fingerprintMap = await probeFingerprints(portMap, {
        concurrency: 32,
        shouldStop: () => this.stopRequested,
        onProgress: (done, total) => {
          if (!this.stopRequested) {
            this.emit('banner', 58 + (12 * done) / total, `服务指纹识别中 ${done}/${total}`)
          }
        }
      })
      if (this.stopRequested) return { subnet: this.currentSubnet }
      this.emit('banner', 70, '服务指纹识别完成')

      const candidates: DeviceCandidate[] = []
      for (const [ip, ports] of portMap) {
        candidates.push({ ip, ports, fingerprint: fingerprintMap.get(ip) ?? [], source: 'subnet' })
      }

      // mDNS 汇总（70% → 88%）。
      this.emit('mdns', 70, '正在汇总 mDNS 发现结果')
      const mdnsRecords = await mdnsPromise
      for (const record of mdnsRecords) {
        if (this.stopRequested) break
        const existing = candidates.find((candidate) => candidate.ip === record.ip)
        if (existing) {
          existing.name = existing.name || record.name
          existing.ports = [...new Set([...(existing.ports ?? []), record.port])]
          existing.protocols = [...new Set([...(existing.protocols ?? []), ...record.protocols])]
        } else {
          candidates.push({
            ip: record.ip,
            name: record.name,
            ports: [record.port],
            protocols: record.protocols,
            source: 'mdns'
          })
        }
      }
      if (this.stopRequested) return { subnet: this.currentSubnet }
      this.emit('mdns', 88, `mDNS 汇总完成，累计 ${candidates.length} 台候选设备`)

      // ARP 汇总（88% → 95%）：补充 MAC 信息与纯 ARP 命中的在线设备。
      this.emit('arp', 88, '正在合并 ARP 表补充的设备')
      let arpAdded = 0
      for (const entry of arpEntries) {
        if (this.stopRequested) break
        const existing = candidates.find((candidate) => candidate.ip === entry.ip)
        if (existing) {
          existing.mac = existing.mac || entry.mac
        } else {
          candidates.push({ ip: entry.ip, mac: entry.mac, source: 'arp' })
          arpAdded += 1
        }
      }
      if (this.stopRequested) return { subnet: this.currentSubnet }
      this.emit('arp', 95, `ARP 汇总完成，补充 ${arpAdded} 台设备`)

      const devices = aggregateAndPersist(candidates)
      this.emit('done', 100, `扫描完成，共发现 ${devices.length} 台设备`, devices)
      logger.info('扫描完成', { subnet: this.currentSubnet, count: devices.length })
      return { subnet: this.currentSubnet }
    } catch (error) {
      this.scanning = false
      this.emit('stopped', 100, `扫描失败：${error instanceof Error ? error.message : String(error)}`)
      throw error
    } finally {
      this.scanning = false
    }
  }
}
