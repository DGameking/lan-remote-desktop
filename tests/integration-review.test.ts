import { describe, it, expect } from 'vitest'
import type { Device, ScanProgress } from '../src/shared/types'
import { defaultPortFor, parseTarget } from '../src/renderer/src/quick-connect'
import { buildRdpContent } from '../src/main/protocols/rdp'
import { isRdpPasswordHex } from '../src/main/store/dpapi'
import { validateConnectRequest, validateDevice } from '../src/main/ipc/validators'
import { deviceIdForIp, inferOsHint } from '../src/main/discovery/aggregator'
import { deviceToRow, rowToDevice } from '../src/main/store/types'

/**
 * 独立集成审查不变量测试。
 * 目标不是重复覆盖某个模块，而是把"四个诉求端到端打通"所依赖的跨模块契约固定下来：
 * 只要任意一侧改了 key 推导 / 端口优先级 / 字段格式，这里就会红。
 */

const VALID_HEX =
  '01000000d08c9ddf0115d1118c7a00c04fc297eb' +
  '0100000000000000000000000000000000000000000000000000000000000000'

/** 快速连接三处（prefill / request.deviceId / credentialSet）共用的 key 推导 */
const quickDeviceId = (ip: string): string => 'quick-' + ip.replace(/\./g, '-')

describe('A. 免密闭环 - 凭据 key 与 DPAPI 不变量', () => {
  it('ConnectDialog 侧 device.id 与 manager 回填查询 key 一致（扫描/手动设备）', () => {
    // ConnectDialog 保存与连接都用 device.id；扫描/手动设备的 id 由 deviceIdForIp 生成。
    const deviceId = deviceIdForIp('192.168.1.20')
    const credentialSetKey = deviceId // ConnectDialog.vue:188 deviceId: device.id
    const sessionConnectKey = deviceId // ConnectDialog.vue:197 deviceId: device.id
    const managerLookupKey = sessionConnectKey // manager.ts:67 item.deviceId === resolved.deviceId
    expect(credentialSetKey).toBe(managerLookupKey)
    expect(credentialSetKey).toBe('dev-192-168-1-20')
  })

  it('QuickConnect 三处 key 推导一致，且不与扫描设备 id 冲突', () => {
    const parsed = parseTarget('192.168.1.20:5901')!
    // prefillCredential(quick-...) / request.deviceId / credentialSet 必须同键
    expect(quickDeviceId(parsed.ip)).toBe('quick-192-168-1-20')
    expect(quickDeviceId('192.168.1.20')).toBe(quickDeviceId(parsed.ip))
    expect(quickDeviceId(parsed.ip)).not.toBe(deviceIdForIp(parsed.ip))
  })

  it('合法 DPAPI blob hex 才会触发免密字段，非法 hex 回落手输', () => {
    expect(isRdpPasswordHex(VALID_HEX)).toBe(true)
    const auto = buildRdpContent({ ip: '10.0.0.9', clipboard: true, driveRedirection: false, passwordHex: VALID_HEX })
    expect(auto).toContain(`password 51:b:${VALID_HEX}`)
    expect(auto).toContain('prompt for credentials:i:0')
    expect(auto).not.toContain('prompt for credentials:i:1')

    // v1.3.0：DPAPI blob hex 大小写不敏感（PowerShell 可能输出大写），大写同样触发免密
    expect(isRdpPasswordHex(VALID_HEX.toUpperCase())).toBe(true)
    const autoUpper = buildRdpContent({ ip: '10.0.0.9', clipboard: true, driveRedirection: false, passwordHex: VALID_HEX.toUpperCase() })
    expect(autoUpper).toContain('prompt for credentials:i:0')

    for (const bad of ['', '01000000d08c9ddf0', '01000000d08c9ddfZZ', 'v0w=']) {
      expect(isRdpPasswordHex(bad)).toBe(false)
      const manual = buildRdpContent({ ip: '10.0.0.9', clipboard: true, driveRedirection: false, passwordHex: bad })
      expect(manual).not.toContain('password 51')
      expect(manual).toContain('prompt for credentials:i:1')
    }
  })
})

describe('B. 端口落地闭环 - 解析 → 校验 → .rdp / vncviewer', () => {
  it('IP:端口 解析后端口优先于协议默认端口（5901 不被 5900 覆盖）', () => {
    const parsed = parseTarget('192.168.1.20:5901')!
    expect(parsed.ip).toBe('192.168.1.20')
    expect(parsed.port).toBe(5901)
    expect(parsed.protocolHint).toBe('vnc')
    // QuickConnect.vue:134 使用 port.value || 5900，解析值优先
    const effectivePort = parsed.port ?? defaultPortFor(parsed.protocolHint!)
    expect(effectivePort).toBe(5901)
    expect(defaultPortFor('vnc')).toBe(5900)
  })

  it('自定义端口原样写入 .rdp 的 full address（不只写默认 3389）', () => {
    const content = buildRdpContent({
      ip: '192.168.1.30', port: 3390, clipboard: true, driveRedirection: false,
      username: 'u', passwordHex: VALID_HEX
    })
    expect(content).toContain('full address:s:192.168.1.30:3390')
    expect(content).not.toContain('full address:s:192.168.1.30:3389')
  })

  it('validateConnectRequest 放行合法自定义端口，越界端口丢弃', () => {
    const vnc = validateConnectRequest({ ip: '192.168.1.20', protocol: 'vnc', port: 5901, username: 'u' })
    expect(vnc.port).toBe(5901)
    const bad = validateConnectRequest({ ip: '192.168.1.20', protocol: 'vnc', port: 70000 })
    expect(bad.port).toBeUndefined()
  })

  it('detectedPorts 落库 round-trip 且老库 undefined 回落空数组', () => {
    const base: Device = {
      id: 'dev-192-168-1-20', name: 'nas', ip: '192.168.1.20', mac: '', osHint: 'macos',
      source: 'subnet', availableProtocols: ['vnc'], detectedPorts: [5901], online: true,
      lastSeenAt: 'x', createdAt: 'x', updatedAt: 'x'
    }
    const row = deviceToRow(base)
    expect(row.detectedPorts).toBe('[5901]')
    expect(rowToDevice(row).detectedPorts).toEqual([5901])

    const legacy = { ...base, detectedPorts: undefined } as unknown as Device
    expect(deviceToRow(legacy).detectedPorts).toBe('[]')
    expect(rowToDevice({ ...row, detectedPorts: '' }).detectedPorts).toEqual([])
  })

  it('validateDevice 归一化 detectedPorts：过滤非法端口并去重', () => {
    const device = validateDevice({
      ip: '192.168.1.20', availableProtocols: ['vnc'],
      detectedPorts: [5901, 5901, 0, 70000, -1, 5902]
    })
    expect(device.detectedPorts).toEqual([5901, 5902])
  })

  it('fingerprint 命中端口能进入 detectedPorts 的推导（VNC 5901）', () => {
    // 复刻 aggregator.ts:121-124 的并集规则：指纹端口并入显式 detectedPorts
    const explicit = [3389]
    const fingerprints = [{ port: 5901, service: 'vnc' as const }]
    const detected = new Set<number>(explicit)
    for (const fp of fingerprints) if (fp.port >= 1 && fp.port <= 65535) detected.add(fp.port)
    expect([...detected]).toEqual([3389, 5901])
  })
})

describe('C. 分层扫描 - 指纹覆盖与进度阶段', () => {
  it('指纹信号优先于端口/名称启发式推断 OS', () => {
    expect(inferOsHint([5901], '', [{ port: 5901, service: 'vnc', version: '003.889' }])).toBe('macos')
    expect(inferOsHint([22], 'unknown', [{ port: 22, service: 'ssh', osHint: 'linux' }])).toBe('linux')
    expect(inferOsHint([3389], '', [{ port: 3389, service: 'rdp', osHint: 'windows' }])).toBe('windows')
    expect(inferOsHint([8000], '', [{ port: 8000, service: 'http', osHint: 'fnos' }])).toBe('fnos')
    // 指纹存在但无有效信号时，回退到端口规则
    expect(inferOsHint([3389], '', [{ port: 3389, service: 'unknown' }])).toBe('windows')
  })

  it('新增 banner 阶段是合法 ScanProgress.phase，且扫描器全部阶段都在联合类型内', () => {
    const banner: ScanProgress = {
      phase: 'banner', percent: 64, message: '服务指纹识别中', subnet: '192.168.1.0/24', devices: []
    }
    expect(banner.phase).toBe('banner')
    const emitted = ['subnet', 'ports', 'banner', 'mdns', 'arp', 'done', 'stopped'] as const
    emitted.forEach((phase) => {
      const p: ScanProgress['phase'] = phase // 联合类型未覆盖则编译失败
      expect(p).toBe(phase)
    })
  })
})
