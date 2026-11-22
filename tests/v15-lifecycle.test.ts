import { describe, it, expect } from 'vitest'
import {
  computeDurationSec,
  isPidAlive,
  taskListCsvShowsPid
} from '../src/main/session/manager'

describe('会话生命周期纯逻辑 - taskListCsvShowsPid 边界', () => {
  it('LF 换行 + 字段含逗号 + 空白填充仍能命中目标 PID', () => {
    const csv = [
      '"Image Name","PID","Session Name","Session#","Mem Usage"',
      '"mstsc.exe"," 4242 ","Console","1","50,000 K"',
      ''
    ].join('\n')
    expect(taskListCsvShowsPid(csv, 4242)).toBe(true)
    expect(taskListCsvShowsPid(csv, 50000)).toBe(false)
  })

  it('PID 只认第二列，出现在其它列不算命中', () => {
    const csv = '"mstsc.exe","1234","Console","4242","50,000 K"'
    expect(taskListCsvShowsPid(csv, 4242)).toBe(false)
    expect(taskListCsvShowsPid(csv, 1234)).toBe(true)
  })

  it('字段不足两列 / 非数字 PID 单元格被跳过', () => {
    expect(taskListCsvShowsPid('"mstsc.exe"', 1)).toBe(false)
    expect(taskListCsvShowsPid('"mstsc.exe","N/A"\n"mstsc.exe","55"', 55)).toBe(true)
  })
})

describe('会话生命周期纯逻辑 - computeDurationSec 边界', () => {
  it('不足 1 秒向下取整为 0；跨时区同一绝对时刻为 0', () => {
    expect(
      computeDurationSec('2026-11-22T10:00:00.000Z', '2026-11-22T10:00:00.999Z')
    ).toBe(0)
    expect(
      computeDurationSec('2026-11-22T10:00:00+08:00', '2026-11-22T02:00:00Z')
    ).toBe(0)
  })

  it('59.9 秒取整为 59，不进位', () => {
    expect(
      computeDurationSec('2026-11-22T10:00:00.000Z', '2026-11-22T10:00:59.900Z')
    ).toBe(59)
  })
})

describe('会话生命周期纯逻辑 - isPidAlive 非法输入短路', () => {
  it.each([0, -1, 1.5, NaN])('非法 PID %s 直接返回 false（不触发进程查询）', async (pid) => {
    await expect(isPidAlive(pid)).resolves.toBe(false)
  })
})
