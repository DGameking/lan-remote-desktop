import { describe, it, expect } from 'vitest'
import type {
  LogEntry,
  LogQuery,
  DiagnosticsBundle,
  ElectronAPI
} from '../src/shared/types'
import { IPC_CHANNELS } from '../src/shared/types'
import {
  SENSITIVE_KEYS,
  redactContext,
  redactText,
  redactIpv4
} from '../src/main/observability/redact'
import {
  serializeLogLine,
  parseLogLine,
  parseLegacyLogLine
} from '../src/main/observability/serialize'
import { filterLogEntries } from '../src/main/observability/query'
import { planRotation } from '../src/main/observability/rotation'
import {
  buildDiagnosticsSnapshot,
  formatDiagnosticsBundle,
  type DiagnosticsInput
} from '../src/main/observability/diagnostics'

const DPAPI_HEX =
  '01000000d08c9ddf0115d1118c7a00c04fc297eb' +
  '0100000000000000000000000000000000000000000000000000000000000000'

/* ======================================================================
 * 脱敏
 * ====================================================================== */
describe('redact - 脱敏口径', () => {
  it('SENSITIVE_KEYS 为约定的敏感键只读数组', () => {
    expect([...SENSITIVE_KEYS]).toEqual([
      'password', 'passwd', 'pwd', 'encryptedPassword', 'passwordHex',
      'token', 'secret', 'credential', 'privateKey', 'authorization',
      'cookie', 'dpapi', 'hex', 'username', 'user', 'mac'
    ])
  })

  it('嵌套对象 / 数组递归脱敏，敏感键不区分大小写且子串匹配', () => {
    const out = redactContext({
      outer: {
        Password: 'p1',
        my_TOKEN_value: 't1',
        arr: [{ secret: 's1', ip: '192.168.1.20' }, 'plain']
      },
      normal: 42
    })
    const o = out.outer as Record<string, unknown>
    expect(o.Password).toBe('[REDACTED]')
    expect(o.my_TOKEN_value).toBe('[REDACTED]')
    const arr = o.arr as unknown[]
    expect((arr[0] as Record<string, unknown>).secret).toBe('[REDACTED]')
    expect((arr[0] as Record<string, unknown>).ip).toBe('192.168.1.20')
    expect(out.normal).toBe(42)
  })

  it('长 hex（>=32 连续）与 RDP password 51:b / Bearer / user:pass@ 清洗', () => {
    expect(redactText(`password 51:b:${DPAPI_HEX}`)).toBe('[REDACTED]')
    expect(redactText(`blob=${DPAPI_HEX}`)).toContain('[REDACTED]')
    expect(redactText('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9')).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    expect(redactText('ftp://admin:hunter2@192.168.1.20')).not.toContain('hunter2')
  })

  it('IP 类例外：ip / rustdeskId / id / subnet / cidr 保留完整 IPv4', () => {
    const out = redactContext({
      ip: '192.168.1.20',
      rustdeskId: '10.0.0.7',
      id: '172.16.5.9',
      subnet: '192.168.1.0/24',
      cidr: '10.2.3.0/24'
    })
    expect(out.ip).toBe('192.168.1.20')
    expect(out.rustdeskId).toBe('10.0.0.7')
    expect(out.id).toBe('172.16.5.9')
    expect(out.subnet).toBe('192.168.1.0/24')
    expect(out.cidr).toBe('10.2.3.0/24')
  })

  it('dev- / quick- deviceId 归一化为普通 IPv4', () => {
    expect(redactContext({ deviceId: 'dev-192-168-1-20' }).deviceId).toBe('192.168.1.20')
    expect(redactContext({ deviceId: 'quick-192-168-1-20' }).deviceId).toBe('192.168.1.20')
  })

  it('布尔型存在性信号（hasPassword/reused 等）保留 true/false，不被脱敏成字符串', () => {
    const out = redactContext({
      hasPassword: true,
      reused: false,
      hasSavedPassword: true
    })
    expect(out.hasPassword).toBe(true)
    expect(out.reused).toBe(false)
    expect(out.hasSavedPassword).toBe(true)
    // 字符串型敏感值仍必须脱敏，不放行
    const strings = redactContext({ password: 'secret123', username: 'mac' })
    expect(strings.password).toBe('[REDACTED]')
    expect(strings.username).toBe('[REDACTED]')
  })

  it('路径类 key 取 basename 且去掉 C:\\Users\\<用户名> / UNC 用户名段', () => {
    const out = redactContext({
      path: 'C:\\Users\\mukui\\AppData\\Roaming\\LanDesk\\conn.rdp',
      file: '\\\\NAS\\Users\\bob\\share\\file.txt',
      executable: 'D:\\tools\\vncviewer.exe'
    })
    expect(out.path).toBe('conn.rdp')
    expect(out.file).toBe('file.txt')
    expect(out.executable).toBe('vncviewer.exe')
    const json = JSON.stringify(out)
    expect(json).not.toContain('mukui')
    expect(json).not.toContain('bob')
    expect(json).not.toContain('C:\\Users')
    expect(json).not.toContain('AppData')
  })

  it('用户自定义别名省略 / REDACTED', () => {
    const out = redactContext({
      share: 'MyShare', defaultShareName: 'NAS', deviceName: 'Office-PC', name: 'Alice'
    })
    for (const v of Object.values(out)) expect(v).toBe('[REDACTED]')
  })

  it('Error 取 message 后走自由文本清洗', () => {
    const out = redactContext({ err: new Error(`解密失败 password 51:b:${DPAPI_HEX}`) })
    const e = out.err as Record<string, unknown>
    expect(e.message).toContain('[REDACTED]')
    expect(JSON.stringify(e)).not.toContain(DPAPI_HEX)
    expect(e.stack).toBeUndefined()
  })

  it('循环引用 / undefined / BigInt / Symbol 均不抛错', () => {
    const node: Record<string, unknown> = { a: 1 }
    node.self = node
    expect(() => redactContext(node)).not.toThrow()
    expect(() => redactContext(undefined)).not.toThrow()
    expect(() => redactContext({ big: 10n, sym: Symbol('x'), fn: () => 1 })).not.toThrow()
    const out = redactContext(node)
    expect((out.self as string)).toBe('[CIRCULAR]')
  })

  it('redactIpv4 掩码最后一段并保留 CIDR 后缀', () => {
    expect(redactIpv4('192.168.1.20')).toBe('192.168.1.*')
    expect(redactIpv4('192.168.1.0/24')).toBe('192.168.1.*/24')
    expect(redactIpv4('主机 10.0.0.7 与 10.0.0.9')).toBe('主机 10.0.0.* 与 10.0.0.*')
  })
})

/* ======================================================================
 * 序列化 / 解析
 * ====================================================================== */
describe('serialize - JSON Lines 往返与旧格式兼容', () => {
  const entry: LogEntry = {
    ts: '2026-11-19T10:00:00.000Z',
    level: 'WARN',
    module: 'session',
    event: 'RDP 端口不通',
    context: { ip: '192.168.1.20', port: 3389 },
    traceId: '2b0f4b1e-1111-2222-3333-444444444444' // 随机 sessionId，绝不使用 deviceId
  }

  it('serialize -> parse 完整往返', () => {
    const line = serializeLogLine(entry)
    expect(line).not.toContain('\n')
    expect(parseLogLine(line)).toEqual(entry)
  })

  it('非法 JSON / 字段不全 / 字段类型不符返回 null', () => {
    expect(parseLogLine('not json')).toBeNull()
    expect(parseLogLine('')).toBeNull()
    expect(parseLogLine('{}')).toBeNull()
    expect(parseLogLine('{"ts":"x","level":"INFO","module":"m"}')).toBeNull() // 缺 event
    expect(parseLogLine('{"ts":"x","level":"TRACE","module":"m","event":"e"}')).toBeNull()
    expect(parseLogLine('{"ts":"x","level":"INFO","module":"m","event":"e","context":[1]}')).toBeNull()
    expect(parseLogLine('[]')).toBeNull()
  })

  it('旧格式 [ISO] [LEVEL] msg {json} 解析，并对 context 脱敏', () => {
    const legacy = `[2026-11-19T10:00:00.000Z] [WARN] 扫描失败 {"ip":"192.168.1.20","password":"secret"}`
    const parsed = parseLegacyLogLine(legacy)
    expect(parsed).not.toBeNull()
    expect(parsed!.level).toBe('WARN')
    expect(parsed!.module).toBe('legacy')
    expect(parsed!.event).toBe('扫描失败')
    expect(parsed!.context!.ip).toBe('192.168.1.20')
    expect(parsed!.context!.password).toBe('[REDACTED]')
    expect(parsed!.ts).toBe('2026-11-19T10:00:00.000Z')
  })

  it('旧格式无 json 尾巴 / 坏行不抛并返回 null 或纯消息', () => {
    expect(parseLegacyLogLine('随便一行文本')).toBeNull()
    expect(parseLegacyLogLine('')).toBeNull()
    expect(() => parseLegacyLogLine('[bad] [INFO] x {oops')).not.toThrow()
    const noJson = parseLegacyLogLine('[2026-11-19T10:00:00.000Z] [INFO] 扫描已由用户停止')
    expect(noJson!.event).toBe('扫描已由用户停止')
    expect(noJson!.context).toBeUndefined()
  })
})

/* ======================================================================
 * 查询
 * ====================================================================== */
describe('filterLogEntries - 查询条件 / 倒序 / limit', () => {
  const entries: LogEntry[] = [
    { ts: '2026-11-17T09:00:00.000Z', level: 'INFO', module: 'discovery', event: '扫描开始', context: { note: 'subnet 192.168.1.0/24' } },
    { ts: '2026-11-18T10:00:00.000Z', level: 'WARN', module: 'session', event: 'RDP 端口不通', context: { ip: '192.168.1.20', port: 3389 }, traceId: 'trace-A' },
    { ts: '2026-11-19T11:00:00.000Z', level: 'ERROR', module: 'session', event: '凭据解密失败', context: { ip: '192.168.1.21' }, traceId: 'trace-B' },
    { ts: '2026-11-19T12:00:00.000Z', level: 'INFO', module: 'ipc', event: '查询日志', context: {}, traceId: 'trace-A' },
    { ts: '2026-11-20T08:00:00.000Z', level: 'ERROR', module: 'session', event: '连接超时' }
  ]

  it('levels 过滤', () => {
    expect(filterLogEntries(entries, { levels: ['ERROR'] })).toHaveLength(2)
    expect(filterLogEntries(entries, { levels: ['INFO', 'WARN'] })).toHaveLength(3)
  })

  it('module / traceId 过滤', () => {
    expect(filterLogEntries(entries, { module: 'session' })).toHaveLength(3)
    expect(filterLogEntries(entries, { traceId: 'trace-A' })).toHaveLength(2)
  })

  it('from / to 为纯日期时含当天（含当天所有时刻）', () => {
    const r = filterLogEntries(entries, { from: '2026-11-19', to: '2026-11-19' })
    expect(r.map((e) => e.ts)).toEqual([
      '2026-11-19T12:00:00.000Z',
      '2026-11-19T11:00:00.000Z'
    ])
  })

  it('keyword 在 event 与 context 文本里匹配', () => {
    expect(filterLogEntries(entries, { keyword: '端口' })).toHaveLength(1)
    expect(filterLogEntries(entries, { keyword: '192.168.1.20' })).toHaveLength(1)
  })

  it('多条件组合（levels + module + from + keyword）', () => {
    const q: LogQuery = { levels: ['ERROR'], module: 'session', from: '2026-11-19', keyword: '超时' }
    expect(filterLogEntries(entries, q)).toHaveLength(1)
  })

  it('结果按 ts 倒序（最新在前）', () => {
    const r = filterLogEntries(entries, {})
    expect(r[0].ts).toBe('2026-11-20T08:00:00.000Z')
    expect(r[r.length - 1].ts).toBe('2026-11-17T09:00:00.000Z')
    for (let i = 1; i < r.length; i++) expect(r[i - 1].ts >= r[i].ts).toBe(true)
  })

  it('limit 钳制：默认 200、硬上限 1000、0 / 负数回退默认、超大截断到 1000', () => {
    const big: LogEntry[] = Array.from({ length: 1200 }, (_, i) => ({
      ts: new Date(Date.parse('2026-01-01T00:00:00.000Z') + i * 1000).toISOString(),
      level: 'INFO' as const,
      module: 'm',
      event: 'e'
    }))
    expect(filterLogEntries(big, {})).toHaveLength(200)
    expect(filterLogEntries(big, { limit: 99999 })).toHaveLength(1000)
    expect(filterLogEntries(big, { limit: 0 })).toHaveLength(200)
    expect(filterLogEntries(big, { limit: -9 })).toHaveLength(200)
    expect(filterLogEntries(big, { limit: 50 })).toHaveLength(50)
  })

  it('空输入返回空数组', () => {
    expect(filterLogEntries([], { keyword: 'x' })).toEqual([])
  })
})

/* ======================================================================
 * 诊断快照 / 诊断包
 * ====================================================================== */
function makeInput(): DiagnosticsInput {
  const recentSessions = Array.from({ length: 12 }, (_, i) => ({
    protocol: 'rdp' as const,
    status: 'failed' as const,
    startedAt: `2026-11-19T07:${String(i).padStart(2, '0')}:00.000Z`,
    errorMessage:
      `连接 192.168.1.20 端口不通 password=SuperSecret123! username=mukui ` +
      `encryptedPassword=${DPAPI_HEX} C:\\Users\\mukui\\AppData\\Local\\conn.rdp Bearer eyJhbGciOiJIUzI1NiJ9`
  }))
  const recentErrors: LogEntry[] = Array.from({ length: 25 }, (_, i) => ({
    ts: `2026-11-19T06:${String(i).padStart(2, '0')}:00.000Z`,
    level: 'ERROR' as const,
    module: 'session',
    event: `连接失败 192.168.1.20 password=SuperSecret123!`,
    context: {
      ip: '192.168.1.20',
      password: 'SuperSecret123!',
      encryptedPassword: DPAPI_HEX,
      username: 'mukui',
      path: 'C:\\Users\\mukui\\AppData\\Local\\conn.rdp'
    }
  }))
  return {
    generatedAt: '2026-11-19T08:00:00.000Z',
    app: {
      version: '1.3.0', platform: 'win32', arch: 'x64', electronVersion: '33.2.0',
      uptimeSeconds: 120, storeMode: 'sqlite', subnet: '192.168.1.0/24',
      safeStorageAvailable: true
    },
    settings: {
      complianceAccepted: true, telemetryConsent: true,
      clipboardSharing: true, driveRedirection: false,
      vncViewerPath: 'C:\\Users\\mukui\\AppData\\Local\\Programs\\TightVNC\\vncviewer.exe',
      rustdeskPath: '',
      defaultShareName: 'PrivateShare'
    },
    protocols: [{ id: 'rdp', available: true }, { id: 'vnc', available: false }],
    counts: { devices: 3, credentials: 2, sessions: 5, logFiles: 4 },
    sessionState: 'connected',
    recentSessions,
    recentErrors,
    lastScan: { subnet: '192.168.1.0/24', deviceCount: 3, finishedAt: '2026-11-19T07:30:00.000Z', durationMs: 1200 }
  }
}

describe('buildDiagnosticsSnapshot - 纯数据进、脱敏快照出', () => {
  it('输出不含真实密码串 / encryptedPassword / username / 完整路径，但保留完整局域网 IP', () => {
    const snap = buildDiagnosticsSnapshot(makeInput())
    const json = JSON.stringify(snap)
    expect(json).not.toContain('SuperSecret123!')
    expect(json).not.toContain('encryptedPassword')
    expect(json).not.toContain('username')
    expect(json).not.toContain('mukui')
    expect(json).not.toContain('C:\\Users')
    expect(json).not.toContain('AppData')
    expect(json).not.toContain(DPAPI_HEX)
    expect(json).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    // 锁住 IP 例外：完整 IPv4 仍在（context.ip / 事件文本），不会被误掩码
    expect(json).toContain('192.168.1.20')
  })

  it('subnetRedacted / lastScan.subnetRedacted 经掩码（末段为 *）', () => {
    const snap = buildDiagnosticsSnapshot(makeInput())
    expect(snap.app.subnetRedacted).toBe('192.168.1.*/24')
    expect(snap.lastScan!.subnetRedacted).toBe('192.168.1.*/24')
  })

  it('recentSessions 截断最近 10 条，recentErrors 取最近 20 条 WARN/ERROR', () => {
    const snap = buildDiagnosticsSnapshot(makeInput())
    expect(snap.recentSessions).toHaveLength(10)
    expect(snap.recentSessions[0].startedAt).toBe('2026-11-19T07:11:00.000Z')
    expect(snap.recentErrors).toHaveLength(20)
    expect(snap.recentErrors.every((e) => e.level === 'WARN' || e.level === 'ERROR')).toBe(true)
  })

  it('telemetryConsent 恒 false，settings 只暴露布尔位不暴露路径', () => {
    const snap = buildDiagnosticsSnapshot(makeInput())
    expect(snap.settings.telemetryConsent).toBe(false)
    expect(snap.settings.hasVncViewerPath).toBe(true)
    expect(snap.settings.hasRustdeskPath).toBe(false)
    expect(snap.settings.hasDefaultShareName).toBe(true)
    expect(JSON.stringify(snap.settings)).not.toContain('PrivateShare')
  })

  it('errorMessageRedacted 经清洗，敏感度字段被抹除', () => {
    const snap = buildDiagnosticsSnapshot(makeInput())
    expect(snap.recentSessions[0].errorMessageRedacted).toContain('[REDACTED]')
    expect(snap.recentSessions[0].errorMessageRedacted).toContain('192.168.1.20')
  })
})

describe('formatDiagnosticsBundle - 自包含 / 可 JSON.parse / 脱敏', () => {
  it('输出可被 JSON.parse，含 schemaVersion 与中文说明', () => {
    const snap = buildDiagnosticsSnapshot(makeInput())
    const bundle: DiagnosticsBundle = { schemaVersion: 1, snapshot: snap, logs: snap.recentErrors.slice(0, 3) }
    const text = formatDiagnosticsBundle(bundle)
    const parsed = JSON.parse(text)
    expect(parsed.schemaVersion).toBe(1)
    expect(parsed._说明).toContain('零遥测')
    expect(parsed.snapshot).toBeTruthy()
    expect(Array.isArray(parsed.logs)).toBe(true)
  })

  it('脱敏后无敏感串，但仍含完整局域网 IP', () => {
    const snap = buildDiagnosticsSnapshot(makeInput())
    const dirtyLog: LogEntry = {
      ts: '2026-11-19T09:00:00.000Z', level: 'ERROR', module: 'auth',
      event: `解密 password=SuperSecret123! 于 C:\\Users\\mukui\\x.rdp`,
      context: { ip: '192.168.1.20', encryptedPassword: DPAPI_HEX, username: 'mukui' }
    }
    const bundle: DiagnosticsBundle = { schemaVersion: 1, snapshot: snap, logs: [dirtyLog] }
    const text = formatDiagnosticsBundle(bundle)
    expect(text).not.toContain('SuperSecret123!')
    expect(text).not.toContain('encryptedPassword')
    expect(text).not.toContain('username')
    expect(text).not.toContain('mukui')
    expect(text).not.toContain('C:\\Users')
    expect(text).not.toContain(DPAPI_HEX)
    expect(text).toContain('192.168.1.20')
  })
})

/* ======================================================================
 * 分片 / 清理规划
 * ====================================================================== */
describe('planRotation - 分片与过期清理', () => {
  const now = Date.parse('2026-11-19T12:00:00.000Z')
  const maxBytes = 1000

  it('无当天文件 / 未超限时写当天主文件 lanDesk-YYYY-MM-DD.jsonl', () => {
    expect(planRotation([], maxBytes, 30, now)).toEqual({
      targetFile: 'lanDesk-2026-11-19.jsonl',
      deleteNames: []
    })
    const under = [{ name: 'lanDesk-2026-11-19.jsonl', mtimeMs: now, size: 500 }]
    expect(planRotation(under, maxBytes, 30, now).targetFile).toBe('lanDesk-2026-11-19.jsonl')
  })

  it('当天主文件超限切 .2 分片', () => {
    const files = [{ name: 'lanDesk-2026-11-19.jsonl', mtimeMs: now, size: 1000 }]
    expect(planRotation(files, maxBytes, 30, now).targetFile).toBe('lanDesk-2026-11-19.2.jsonl')
  })

  it('.2 未超限时继续写 .2，.2 也超限切 .3', () => {
    const two = [
      { name: 'lanDesk-2026-11-19.jsonl', mtimeMs: now, size: 1000 },
      { name: 'lanDesk-2026-11-19.2.jsonl', mtimeMs: now, size: 300 }
    ]
    expect(planRotation(two, maxBytes, 30, now).targetFile).toBe('lanDesk-2026-11-19.2.jsonl')
    const twoFull = [
      { name: 'lanDesk-2026-11-19.jsonl', mtimeMs: now, size: 1000 },
      { name: 'lanDesk-2026-11-19.2.jsonl', mtimeMs: now, size: 1000 }
    ]
    expect(planRotation(twoFull, maxBytes, 30, now).targetFile).toBe('lanDesk-2026-11-19.3.jsonl')
  })

  it('过期文件进 deleteNames，.log / .jsonl 双后缀都识别', () => {
    const old = now - 31 * 24 * 60 * 60 * 1000
    const files = [
      { name: 'lanDesk-2026-10-01.log', mtimeMs: old, size: 10 },
      { name: 'lanDesk-2026-10-02.jsonl', mtimeMs: old, size: 10 },
      { name: 'lanDesk-2026-11-18.jsonl', mtimeMs: now - 2 * 24 * 60 * 60 * 1000, size: 10 },
      { name: 'notes.txt', mtimeMs: old, size: 10 }
    ]
    const r = planRotation(files, maxBytes, 30, now)
    expect(r.deleteNames).toContain('lanDesk-2026-10-01.log')
    expect(r.deleteNames).toContain('lanDesk-2026-10-02.jsonl')
    expect(r.deleteNames).not.toContain('lanDesk-2026-11-18.jsonl')
    expect(r.deleteNames).not.toContain('notes.txt')
  })
})

/* ======================================================================
 * 契约不变量（防四处漂移）
 * ====================================================================== */
describe('契约不变量 - IPC 通道与 ElectronAPI 方法名', () => {
  it('三个诊断通道常量值固定', () => {
    expect(IPC_CHANNELS.APP_GET_DIAGNOSTICS).toBe('app:getDiagnostics')
    expect(IPC_CHANNELS.APP_EXPORT_DIAGNOSTICS).toBe('app:exportDiagnostics')
    expect(IPC_CHANNELS.LOG_QUERY).toBe('log:query')
  })

  it('ElectronAPI 暴露 appGetDiagnostics / appExportDiagnostics / logQuery', () => {
    // 类型层面：任一方法名从 ElectronAPI 移除，下面数组在 typecheck 时即报错
    const required: Array<keyof ElectronAPI> = [
      'appGetDiagnostics', 'appExportDiagnostics', 'logQuery'
    ]
    expect(required).toEqual(['appGetDiagnostics', 'appExportDiagnostics', 'logQuery'])
  })
})
