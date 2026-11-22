import { describe, it, expect } from 'vitest'
import { computeDurationSec, taskListCsvShowsPid } from '../src/main/session/manager'
import { normalizeSessionRow } from '../src/main/store/types'

describe('v15-P0-2 taskListCsvShowsPid - tasklist CSV 进程存活判定', () => {
  const csv = [
    '"Image Name","PID","Session Name","Session#","Mem Usage"',
    '"mstsc.exe","12345","Console","1","50,000 K"',
    '"vncviewer.exe","678","Console","1","20,000 K"',
    ''
  ].join('\r\n')

  it('目标 PID 在 CSV 中 → true', () => {
    expect(taskListCsvShowsPid(csv, 12345)).toBe(true)
    expect(taskListCsvShowsPid(csv, 678)).toBe(true)
  })

  it('不存在的 PID → false', () => {
    expect(taskListCsvShowsPid(csv, 99999)).toBe(false)
    expect(taskListCsvShowsPid(csv, 1234)).toBe(false)
  })

  it('表头行不会被误判', () => {
    // 表头第二列是字符串 "PID"，不应命中
    expect(taskListCsvShowsPid('"Image Name","PID"\r\n', 1)).toBe(false)
  })

  it('PID 非法或输出为空 → false', () => {
    expect(taskListCsvShowsPid(csv, 0)).toBe(false)
    expect(taskListCsvShowsPid(csv, -1)).toBe(false)
    expect(taskListCsvShowsPid(csv, 1.5)).toBe(false)
    expect(taskListCsvShowsPid('', 12345)).toBe(false)
  })
})

describe('v15-P0-2 computeDurationSec - 会话时长计算', () => {
  it('正常区间返回整秒数', () => {
    const start = '2026-11-22T10:00:00.000Z'
    const end = '2026-11-22T10:01:05.900Z'
    expect(computeDurationSec(start, end)).toBe(65)
  })

  it('同一时刻返回 0', () => {
    const t = '2026-11-22T10:00:00.000Z'
    expect(computeDurationSec(t, t)).toBe(0)
  })

  it('任一时间无效 → undefined（UI 显示"时长不可测"）', () => {
    expect(computeDurationSec('', '2026-11-22T10:00:00.000Z')).toBeUndefined()
    expect(computeDurationSec('not-a-date', '2026-11-22T10:00:00.000Z')).toBeUndefined()
    expect(computeDurationSec('2026-11-22T10:00:00.000Z', '')).toBeUndefined()
  })

  it('结束早于开始 → undefined，不返回负数', () => {
    expect(
      computeDurationSec('2026-11-22T10:01:00.000Z', '2026-11-22T10:00:00.000Z')
    ).toBeUndefined()
  })
})

describe('v15-P0-2 normalizeSessionRow - 老库字段规范化', () => {
  const base = {
    id: 's1',
    deviceId: 'd1',
    deviceName: 'PC',
    protocol: 'rdp' as const,
    status: 'ended' as const,
    startedAt: '2026-11-22T10:00:00.000Z',
    endedAt: '2026-11-22T10:01:00.000Z',
    errorMessage: ''
  }

  it('DB 的 0 值归一为 undefined，durationUnavailable=1 归一为 true', () => {
    const row = normalizeSessionRow({
      ...base,
      externalPid: 0,
      durationSec: 0,
      durationUnavailable: 1
    })
    expect(row.externalPid).toBeUndefined()
    expect(row.durationSec).toBeUndefined()
    expect(row.durationUnavailable).toBe(true)
  })

  it('有效值原样保留', () => {
    const row = normalizeSessionRow({
      ...base,
      externalPid: 12345,
      durationSec: 60,
      durationUnavailable: false
    })
    expect(row.externalPid).toBe(12345)
    expect(row.durationSec).toBe(60)
    expect(row.durationUnavailable).toBeUndefined()
  })

  it('缺失字段的老数据不被强行补 0', () => {
    const row = normalizeSessionRow({ ...base })
    expect('externalPid' in row).toBe(false)
    expect('durationSec' in row).toBe(false)
    expect('durationUnavailable' in row).toBe(false)
  })
})
