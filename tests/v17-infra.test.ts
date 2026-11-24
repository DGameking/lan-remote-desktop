import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import initSqlJs from 'sql.js'
import {
  chunkTargets,
  resolveRefreshIntervalSec,
  isRefreshEnabled,
  diffOnlineStatus,
  OnlineMonitor
} from '../src/main/scheduler/online-monitor'
import { JsonStore } from '../src/main/store/json-store'
import type { DeviceRow } from '../src/main/store/types'
import { probePort } from '../src/main/discovery/precheck'

// 用可控 TCP 探测替换真实网络：让巡检必然产生「离线→在线」翻转，
// 才能真实验证「落盘失败是否抑制推送」，而不是靠端口不可达蒙混过关。
vi.mock('../src/main/discovery/precheck', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/discovery/precheck')>()
  return { ...actual, probePort: vi.fn() }
})
const mockProbePort = vi.mocked(probePort)

function makeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'v17-infra-'))
}

function deviceRow(id: string, ip: string, online: number): DeviceRow {
  return {
    id,
    name: id,
    ip,
    mac: '',
    osHint: 'windows',
    osConfidence: 'medium',
    osEvidence: '[]',
    osManual: 0,
    source: 'subnet',
    availableProtocols: '["rdp"]',
    detectedPorts: '[3389]',
    online,
    lastSeenAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    favorite: 0,
    pinned: 0,
    alias: '',
    group: ''
  }
}

/* ===================== 在线巡检纯函数 ===================== */

describe('v1.7 OnlineMonitor 纯函数', () => {
  it('chunkTargets 按批次切分，末批不足保留', () => {
    expect(chunkTargets([1, 2, 3, 4, 5, 6, 7], 3)).toEqual([[1, 2, 3], [4, 5, 6], [7]])
  })

  it('chunkTargets 对非法 size 收敛到 1，避免死循环', () => {
    expect(chunkTargets([1, 2], 0)).toEqual([[1], [2]])
    expect(chunkTargets([1, 2], -5)).toEqual([[1], [2]])
    expect(chunkTargets([1, 2, 3], 2.8)).toEqual([[1, 2], [3]])
  })

  it('resolveRefreshIntervalSec 收敛到 15..3600 并容忍字符串', () => {
    expect(resolveRefreshIntervalSec(60)).toBe(60)
    expect(resolveRefreshIntervalSec(5)).toBe(15)
    expect(resolveRefreshIntervalSec(5000)).toBe(3600)
    expect(resolveRefreshIntervalSec('30')).toBe(30)
    expect(resolveRefreshIntervalSec(30.9)).toBe(30)
    expect(resolveRefreshIntervalSec('abc')).toBe(60)
    expect(resolveRefreshIntervalSec(Number.NaN)).toBe(60)
  })

  it('isRefreshEnabled 只认 true / "true"', () => {
    expect(isRefreshEnabled(true)).toBe(true)
    expect(isRefreshEnabled('true')).toBe(true)
    expect(isRefreshEnabled(false)).toBe(false)
    expect(isRefreshEnabled('false')).toBe(false)
    expect(isRefreshEnabled(1)).toBe(false)
    expect(isRefreshEnabled(undefined)).toBe(false)
  })

  it('diffOnlineStatus 只上报已存在设备的翻转，新设备首轮不上报', () => {
    const before = new Map([
      ['192.168.1.2', true],
      ['192.168.1.3', false]
    ])
    const after = new Map([
      ['192.168.1.2', false],
      ['192.168.1.3', false],
      ['192.168.1.9', true]
    ])
    expect(diffOnlineStatus(before, after)).toEqual(['192.168.1.2'])
  })

  it('diffOnlineStatus 无翻转返回空数组', () => {
    const state = new Map([['192.168.1.2', true]])
    expect(diffOnlineStatus(state, new Map(state))).toEqual([])
  })
})

/* ===================== JsonStore 批量在线状态 ===================== */

describe('v1.7 JsonStore 批量在线更新（写放大治理）', () => {
  it('状态无变化时不落盘', () => {
    const store = JsonStore.create(makeDir())
    store.upsertDevice(deviceRow('d1', '192.168.1.2', 1))
    const persist = vi.spyOn(store as unknown as { persist: () => void }, 'persist')

    expect(store.setDeviceOnlineBatch([{ ip: '192.168.1.2', online: true }])).toBe(0)
    expect(persist).not.toHaveBeenCalled()
  })

  it('多条翻转整批只落盘一次', () => {
    const store = JsonStore.create(makeDir())
    store.upsertDevice(deviceRow('d1', '192.168.1.2', 1))
    store.upsertDevice(deviceRow('d2', '192.168.1.3', 0))
    const persist = vi.spyOn(store as unknown as { persist: () => void }, 'persist')

    const changed = store.setDeviceOnlineBatch([
      { ip: '192.168.1.2', online: false },
      { ip: '192.168.1.3', online: true }
    ])
    expect(changed).toBe(2)
    expect(persist).toHaveBeenCalledTimes(1)
    const byIp = new Map(store.listDevices().map((row) => [row.ip, row.online]))
    expect(byIp.get('192.168.1.2')).toBe(0)
    expect(byIp.get('192.168.1.3')).toBe(1)
  })

  it('重复 ip 去重，未知 ip 被忽略', () => {
    const store = JsonStore.create(makeDir())
    store.upsertDevice(deviceRow('d1', '192.168.1.2', 1))
    const persist = vi.spyOn(store as unknown as { persist: () => void }, 'persist')

    expect(
      store.setDeviceOnlineBatch([
        { ip: '192.168.1.2', online: false },
        { ip: '192.168.1.2', online: true },
        { ip: '192.168.9.9', online: true }
      ])
    ).toBe(0)
    expect(persist).not.toHaveBeenCalled()
    expect(store.listDevices()[0].online).toBe(1)
  })
})

/* ===================== 在线巡检推送一致性 ===================== */

describe('v1.7 在线巡检推送一致性', () => {
  const target = { ip: '192.168.1.2', port: 3389 }
  const reachableProbe = { ip: target.ip, port: target.port, reachable: true, latencyMs: 5 }

  function makeMonitor(setDeviceOnlineBatch: () => number, onStatusChange: () => void) {
    const store = {
      listDevices: () => [{ ip: target.ip, online: 0 }],
      setDeviceOnlineBatch: vi.fn(setDeviceOnlineBatch)
    }
    const settings = { onlineRefreshEnabled: true, onlineRefreshIntervalSec: 60 }
    const monitor = new OnlineMonitor({
      getTargets: () => [target],
      onStatusChange: vi.fn(onStatusChange),
      getSettings: () => settings as never,
      getStore: () => store as never
    })
    return { monitor, store, onStatusChange: monitor['onStatusChange'] as unknown as ReturnType<typeof vi.fn> }
  }

  it('落盘失败时抑制翻转推送：探测到在线但写入失败，UI 不收到事件', async () => {
    mockProbePort.mockResolvedValueOnce(reachableProbe)
    const { monitor, store, onStatusChange } = makeMonitor(
      () => {
        throw new Error('disk full')
      },
      () => undefined
    )

    await (monitor as unknown as { runRound(): Promise<void> }).runRound()

    // 前置：探测确实认为设备在线，before(offline)→after(online) 构成真实翻转。
    expect(mockProbePort).toHaveBeenCalledWith(target.ip, target.port)
    expect(store.setDeviceOnlineBatch).toHaveBeenCalledWith([{ ip: target.ip, online: true }])
    // 核心断言：落盘失败 → 不推送，避免 UI 显示在线但重启后跳回离线。
    expect(onStatusChange).not.toHaveBeenCalled()
  })

  it('落盘成功时翻转推送与 diff 一一对应，新设备首轮不上报', async () => {
    mockProbePort.mockResolvedValueOnce(reachableProbe)
    const pushed: unknown[] = []
    const { monitor, store } = makeMonitor(() => 1, (event) => pushed.push(event))

    await (monitor as unknown as { runRound(): Promise<void> }).runRound()

    expect(store.setDeviceOnlineBatch).toHaveBeenCalledTimes(1)
    expect(pushed).toEqual([
      { ip: target.ip, online: true, checkedAt: expect.any(String) }
    ])
  })

  it('diffOnlineStatus 只上报已存在设备的翻转', () => {
    const before = new Map([['192.168.1.2', false]])
    const after = new Map([
      ['192.168.1.2', true],
      ['192.168.1.3', true]
    ])
    expect(diffOnlineStatus(before, after)).toEqual(['192.168.1.2'])
  })
})

/* ===================== 延迟测速历史 ===================== */

describe('v1.7 延迟测速历史', () => {
  it('JsonStore 延迟记录按时间倒序、按 ip 过滤、limit 收敛', () => {
    const store = JsonStore.create(makeDir())
    store.addLatency({
      id: 'l1', ip: '192.168.1.2', port: 5900, latencyMs: 12, reachable: 1,
      measuredAt: '2026-01-02T00:00:00.000Z'
    })
    store.addLatency({
      id: 'l2', ip: '192.168.1.3', port: 3389, latencyMs: 30, reachable: 0,
      measuredAt: '2026-01-01T00:00:00.000Z'
    })
    store.addLatency({
      id: 'l3', ip: '192.168.1.2', port: 5900, latencyMs: 9, reachable: 1,
      measuredAt: '2026-01-03T00:00:00.000Z'
    })

    expect(store.listLatency().map((row) => row.id)).toEqual(['l3', 'l1', 'l2'])
    expect(store.listLatency('192.168.1.2').map((row) => row.id)).toEqual(['l3', 'l1'])
    expect(store.listLatency(undefined, 1).map((row) => row.id)).toEqual(['l3'])
    expect(store.listLatency(undefined, 99999).length).toBe(3)
  })

  it('老 JSON 文件缺 latency 字段时补空数组，不污染原有设备', async () => {
    const dir = makeDir()
    fs.writeFileSync(
      path.join(dir, 'landesk-data.json'),
      JSON.stringify({ devices: [deviceRow('d1', '192.168.1.2', 1)], credentials: [], sessions: [], settings: {} })
    )
    const store = JsonStore.create(dir)
    expect(store.listLatency()).toEqual([])
    expect(store.listDevices()[0].ip).toBe('192.168.1.2')
  })

  it('真实 sql.js：老库升级补出 latency 表与索引，重复执行幂等', async () => {
    const SQL = await initSqlJs()
    const db = new SQL.Database()
    db.run('CREATE TABLE devices (id TEXT PRIMARY KEY)')
    db.run("INSERT INTO devices VALUES ('d1')")

    const latencySchema = `CREATE TABLE IF NOT EXISTS latency (
      id TEXT PRIMARY KEY, ip TEXT NOT NULL, port INTEGER NOT NULL,
      latencyMs INTEGER NOT NULL, reachable INTEGER NOT NULL DEFAULT 0,
      measuredAt TEXT NOT NULL)`
    const indexSql = 'CREATE INDEX IF NOT EXISTS idx_latency_ip_time ON latency(ip, measuredAt DESC)'
    const apply = (): void => {
      db.run(latencySchema)
      try {
        db.run(indexSql)
      } catch (error) {
        if (!/already exists/i.test(String(error))) throw error
      }
    }
    apply()
    apply()

    const indexes = db.exec("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='latency'")
    expect(indexes[0].values.flat()).toContain('idx_latency_ip_time')
    db.run("INSERT INTO latency VALUES ('l1','192.168.1.2',5900,12,1,'2026-01-01')")
    const result = db.exec("SELECT ip, latencyMs FROM latency WHERE ip = '192.168.1.2' ORDER BY measuredAt DESC LIMIT 10")
    expect(result[0].values).toEqual([['192.168.1.2', 12]])
    expect(db.exec('SELECT id FROM devices')[0].values).toEqual([['d1']])
    db.close()
  })
})
