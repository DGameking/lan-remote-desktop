import { describe, it, expect } from 'vitest'
import { taskListCsvHasAnyProcess } from '../src/main/session/process-liveness'
import { imageNameOf } from '../src/main/protocols/base'

describe('v1.7.1 进程名兜底判定', () => {
  it('tasklist CSV 有多个进程时判定为存活', () => {
    const csv = [
      '"Image Name","PID","Session Name","Session#","Mem Usage"',
      '"vncviewer.exe","4242","Console","1","50,000 K"',
      '"vncviewer.exe","5312","Console","1","48,000 K"',
      ''
    ].join('\r\n')
    expect(taskListCsvHasAnyProcess(csv)).toBe(true)
  })

  it('只有表头或 INFO 提示时判定为无进程', () => {
    expect(taskListCsvHasAnyProcess('"Image Name","PID"\r\n')).toBe(false)
    expect(taskListCsvHasAnyProcess('INFO: No tasks are running which match the specified criteria.')).toBe(false)
    expect(taskListCsvHasAnyProcess('')).toBe(false)
  })

  it('PID 出现在非第二列不算进程', () => {
    expect(taskListCsvHasAnyProcess('"vncviewer.exe","N/A","Console","4242"')).toBe(false)
  })

  it('imageNameOf 从完整路径提取纯 exe 文件名', () => {
    expect(imageNameOf('C://Program Files\\TigerVNC\\vncviewer.exe')).toBe('vncviewer.exe')
    expect(imageNameOf('"C://Program Files//RealVNC//VNC Viewer//vncviewer.exe"')).toBe('vncviewer.exe')
    expect(imageNameOf('')).toBe('')
    expect(imageNameOf('C://tools//some-app.dll')).toBe('')
  })
})
