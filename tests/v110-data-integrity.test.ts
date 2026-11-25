import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Device, DeviceRow } from '../src/shared/types'
import { aggregateAndPersist, upsertManualDevice, applyScanOnlineState, type DeviceCandidate } from '../src/main/discovery/aggregator'
import { validateExportData } from '../src/main/ipc/validators'
import { deviceToRow, rowToDevice } from '../src/main/store/types'

/**
 * v1.10 P0: 用户数据完整性回归。
 * 审校发现三个数据丢失 bug：扫描清空元数据、手动添加抹掉识别结果、备份导入覆盖扫描数据。
 */
const h = vi.hoisted(() => {
  let rows: DeviceRow[] = []
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), event: vi.fn() }
  return {
    get rows() { return rows },
    set rows(v: DeviceRow[]) { rows = v },
    logger
  }
})

vi.mock('../src/main/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/store')>()),
  getStore: () => ({
    listDevices: () => h.rows,
    upsertDevice: (row: DeviceRow) => {
      const idx = h.rows.findIndex((r) => r.id === row.id)
      if (idx >= 0) h.rows[idx] = row
      else h.rows.push(row)
    }
  }),
  now: () => '2026-11-25T12:00:00.000Z'
}))
vi.mock('../src/main/logger', () => ({ scopedLogger: () => h.logger, logger: h.logger }))

function makeRow(overrides: Partial<DeviceRow> = {}): DeviceRow {
  const base: Device = {
    id: 'dev-192-168-10-15',
    name: 'MacBook',
    ip: '192.168.10.15',
    mac: 'AA:BB:CC:DD:EE:FF',
    osHint: 'macos',
    osConfidence: 'high',
    osEvidence: [{ source: 'mdns', osHint: 'macos', detail: 'mDNS 名称匹配' }],
    osManual: true,
    favorite: true,
    pinned: true,
    alias: '我的Mac',
    group: '办公设备',
    source: 'mdns',
    availableProtocols: ['vnc'],
    detectedPorts: [5900],
    online: true,
    lastSeenAt: '2026-11-25T11:00:00.000Z',
    createdAt: '2026-11-20T10:00:00.000Z',
    updatedAt: '2026-11-25T11:00:00.000Z'
  }
  return { ...deviceToRow(base), ...overrides }
}

const candidate: DeviceCandidate = {
  ip: '192.168.10.15',
  name: 'MacBook-Air',
  ports: [5900],
  protocols: ['vnc'],
  fingerprint: [],
  source: 'subnet'
}

beforeEach(() => {
  h.rows = [makeRow()]
})

describe('v1.10 P0 - 扫描不得清空用户设备元数据', () => {
  it('重发现设备后 favorite/pinned/alias/group 全部保留', () => {
    aggregateAndPersist([candidate])
    const saved = rowToDevice(h.rows[0])
    expect(saved.favorite).toBe(true)
    expect(saved.pinned).toBe(true)
    expect(saved.alias).toBe('我的Mac')
    expect(saved.group).toBe('办公设备')
  })

  it('手动指定的系统（osManual）与识别证据扫描后仍保留', () => {
    aggregateAndPersist([candidate])
    const saved = rowToDevice(h.rows[0])
    expect(saved.osManual).toBe(true)
    expect(saved.osHint).toBe('macos')
    expect(saved.osEvidence?.some((e) => e.source === 'manual')).toBe(true)
  })

  it('创建时间不被扫描重置', () => {
    aggregateAndPersist([candidate])
    expect(h.rows[0].createdAt).toBe('2026-11-20T10:00:00.000Z')
  })
})

describe('v1.10 P0 - 手动添加已存在设备不得抹掉识别结果', () => {
  it('识别证据/端口/协议/用户元数据全部保留，仅更新名称与时间', () => {
    const saved = upsertManualDevice('192.168.10.15', '新名字')
    expect(saved.name).toBe('新名字')
    expect(saved.osHint).toBe('macos')
    expect(saved.osManual).toBe(true)
    expect(saved.osEvidence?.length).toBeGreaterThan(0)
    expect(saved.detectedPorts).toEqual([5900])
    expect(saved.availableProtocols).toEqual(['vnc'])
    expect(saved.favorite).toBe(true)
    expect(saved.alias).toBe('我的Mac')
    expect(saved.createdAt).toBe('2026-11-20T10:00:00.000Z')
  })

  it('新增设备（不存在）仍走 manual 默认，不影响老逻辑', () => {
    const saved = upsertManualDevice('10.0.0.9')
    expect(saved.name).toBe('10.0.0.9')
    expect(saved.source).toBe('manual')
    expect(saved.osHint).toBe('unknown')
  })
})

describe('v1.10 P0 - 扫描在线状态不得假离线', () => {
  it('只把本轮未发现的旧设备标离线，发现的设备保持在线', () => {
    h.rows = [makeRow(), makeRow({ id: 'dev-10-0-0-9', ip: '10.0.0.9', name: 'Other', online: 1 })]
    const count = applyScanOnlineState(new Set(['192.168.10.15']))
    expect(count).toBe(1)
    expect(h.rows.find((r) => r.ip === '192.168.10.15')?.online).toBe(1)
    expect(h.rows.find((r) => r.ip === '10.0.0.9')?.online).toBe(0)
  })

  it('本轮发现全部设备时不产生任何离线翻转', () => {
    expect(applyScanOnlineState(new Set(['192.168.10.15']))).toBe(0)
    expect(h.rows[0].online).toBe(1)
  })
})

describe('v1.10 P0 - 备份导入设置必须白名单校验（阻断路径注入 RCE）', () => {
  const payload = (settings: Record<string, unknown>) => ({
    format: 'landesk-backup',
    version: 1,
    exportedAt: '2026-11-25T12:00:00.000Z',
    devices: [],
    settings
  })

  it('拒绝注入带 shell 元字符的可执行路径', () => {
    expect(() => validateExportData(payload({ vncViewerPath: 'C:\\evil.exe & calc.exe' }))).toThrow()
    expect(() => validateExportData(payload({ rustdeskPath: 'evil;cmd.exe' }))).toThrow()
  })

  it('合法设置项被保留，未知字段被丢弃', () => {
    const result = validateExportData(
      payload({ clipboardSharing: true, rdpWidth: 1920, evilField: 'ignored' })
    )
    expect(result.settings.clipboardSharing).toBe(true)
    expect(result.settings.rdpWidth).toBe(1920)
    expect((result.settings as unknown as Record<string, unknown>).evilField).toBeUndefined()
  })

  it('非法设备 IP 仍被拒绝', () => {
    expect(() =>
      validateExportData({
        ...payload({}),
        devices: [{ ip: 'not-an-ip', availableProtocols: [] }]
      })
    ).toThrow()
  })
})
