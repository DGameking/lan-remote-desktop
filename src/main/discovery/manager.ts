import type { ScanProgress } from '../../shared/types'
import { logger } from '../logger'
import { aggregateAndPersist, resetOnlineFlags, type DeviceCandidate } from './aggregator'
import { readArpTable } from './arp'
import { browseMdns } from './mdns'
import { scanPorts } from './port-scan'
import { detectSubnets, type SubnetInfo } from './subnet'

export const SCAN_PORTS = [3389, 5900, 21116] as const

/** 扫描编排：网段计算 → 端口探测 → mDNS → ARP → 聚合落库，并持续推送进度 */
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

      const portMap = await scanPorts(
        target.hosts,
        [...SCAN_PORTS],
        {
          concurrency: 50,
          timeout: 400,
          shouldStop: () => this.stopRequested
        },
        (done, total) => {
          if (!this.stopRequested) {
            this.emit('ports', 5 + (60 * done) / total, `端口探测中 ${done}/${total}`)
          }
        }
      )
      if (this.stopRequested) return { subnet: this.currentSubnet }

      const candidates: DeviceCandidate[] = []
      for (const [ip, ports] of portMap) {
        candidates.push({ ip, ports, source: 'subnet' })
      }
      this.emit('mdns', 68, `端口探测完成，发现 ${candidates.length} 台开放设备，正在查询 mDNS`)

      try {
        const mdnsRecords = await browseMdns(2500, (record) => {
          if (!this.stopRequested) {
            candidates.push({
              ip: record.ip,
              name: record.name,
              ports: [record.port],
              protocols: record.protocols,
              source: 'mdns'
            })
          }
        })
        for (const record of mdnsRecords) {
          if (!candidates.some((item) => item.ip === record.ip)) {
            candidates.push({
              ip: record.ip,
              name: record.name,
              ports: [record.port],
              protocols: record.protocols,
              source: 'mdns'
            })
          }
        }
      } catch (error) {
        logger.warn('mDNS 发现失败，已跳过', error)
      }
      if (this.stopRequested) return { subnet: this.currentSubnet }

      this.emit('arp', 88, '正在读取系统 ARP 表补充候选设备')
      try {
        const arpEntries = await readArpTable()
        const inSubnet = new Set(target.hosts)
        for (const entry of arpEntries) {
          if (inSubnet.has(entry.ip)) {
            candidates.push({ ip: entry.ip, mac: entry.mac, source: 'arp' })
          }
        }
      } catch (error) {
        logger.warn('ARP 表读取失败，已跳过', error)
      }

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
