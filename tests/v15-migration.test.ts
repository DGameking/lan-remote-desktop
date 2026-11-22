import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import initSqlJs from 'sql.js'
import { JsonStore } from '../src/main/store/json-store'
import { SqlStore } from '../src/main/store/sql-store'
import { normalizeSessionRow, rowToDevice } from '../src/main/store/types'
import type { DeviceRow, SessionRow } from '../src/main/store/types'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'landesk-v15-mig-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

/** 迁移前的老设备行：缺 osConfidence/osEvidence/osManual/detectedPorts */
const oldDevice = {
  id: 'd-old',
  name: '老设备',
  ip: '192.168.1.9',
  mac: 'AA:BB:CC:DD:EE:FF',
  osHint: 'windows',
  source: 'subnet',
  availableProtocols: '["rdp"]',
  online: 1,
  lastSeenAt: '2026-01-01T00:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
}

/** 迁移前的老会话行：缺 externalPid/durationSec/durationUnavailable */
const oldSession = {
  id: 's-old',
  deviceId: 'd-old',
  deviceName: '老设备',
  protocol: 'rdp',
  status: 'ended',
  startedAt: '2026-01-01T00:00:00.000Z',
  endedAt: '2026-01-01T00:01:00.000Z',
  errorMessage: '历史错误'
}

const oldCredential = {
  id: 'c-old',
  deviceId: 'd-old',
  protocol: 'rdp',
  username: 'old-user',
  encryptedPassword: 'cipher-old',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
}

describe('JSON 老库迁移 - 补默认值且历史数据零丢失', () => {
  it('缺 v1.4/v1.5 字段的设备与会话：加载后补默认值，原字段原样保留', () => {
    const dir = makeTempDir()
    fs.writeFileSync(
      path.join(dir, 'landesk-data.json'),
      JSON.stringify({
        devices: [oldDevice],
        credentials: [oldCredential],
        sessions: [oldSession],
        settings: { defaultShareName: 'share-old' }
      }),
      'utf8'
    )

    const store = JsonStore.create(dir)

    const device = store.listDevices()[0]
    expect(device.id).toBe('d-old')
    expect(device.name).toBe('老设备')
    expect(device.ip).toBe('192.168.1.9')
    expect(device.availableProtocols).toBe('["rdp"]')
    expect(device.detectedPorts).toBe('[]')
    expect(device.osConfidence).toBe('none')
    expect(device.osEvidence).toBe('[]')
    expect(device.osManual).toBe(0)

    const session = store.listSessions()[0]
    expect(session.id).toBe('s-old')
    expect(session.errorMessage).toBe('历史错误')
    expect(session.externalPid).toBeUndefined()
    expect(session.durationSec).toBeUndefined()
    expect(session.durationUnavailable).toBeUndefined()

    expect(store.listCredentials()[0].encryptedPassword).toBe('cipher-old')
    expect(store.getSetting('defaultShareName')).toBe('share-old')

    // create() 会回写：确认补的默认值真的落盘，后续启动不再依赖迁移逻辑
    const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'landesk-data.json'), 'utf8'))
    expect(persisted.devices[0].detectedPorts).toBe('[]')
    expect(persisted.devices[0].osConfidence).toBe('none')
    expect(persisted.sessions[0].externalPid).toBeUndefined()
  })

  it('已有 v1.4/v1.5 值的行不被默认值覆盖（含 0/1 两种 durationUnavailable 形态）', () => {
    const dir = makeTempDir()
    fs.writeFileSync(
      path.join(dir, 'landesk-data.json'),
      JSON.stringify({
        devices: [
          {
            ...oldDevice,
            osHint: 'linux',
            osConfidence: 'high',
            osEvidence: '[{"source":"ttl","osHint":"linux","detail":"x"}]',
            osManual: 1,
            detectedPorts: '[3389,5900]'
          }
        ],
        credentials: [],
        sessions: [
          { ...oldSession, externalPid: 4321, durationSec: 75, durationUnavailable: 1 },
          { ...oldSession, id: 's-old-2', externalPid: 0, durationSec: 0 }
        ],
        settings: {}
      }),
      'utf8'
    )

    const store = JsonStore.create(dir)
    const rows = store.listSessions()

    const device = store.listDevices()[0]
    expect(device.osHint).toBe('linux')
    expect(device.osConfidence).toBe('high')
    expect(device.osEvidence).toBe('[{"source":"ttl","osHint":"linux","detail":"x"}]')
    expect(device.osManual).toBe(1)
    expect(device.detectedPorts).toBe('[3389,5900]')

    const first = rows.find((row) => row.id === 's-old')!
    expect(first.externalPid).toBe(4321)
    expect(first.durationSec).toBe(75)
    expect(first.durationUnavailable).toBe(true)

    const second = rows.find((row) => row.id === 's-old-2')!
    expect(second.externalPid).toBeUndefined()
    expect(second.durationSec).toBeUndefined()
    expect(second.durationUnavailable).toBeUndefined()
  })
})

describe('normalizeSessionRow / rowToDevice - 老 row 对象的真实转换', () => {
  it('normalizeSessionRow：非法 externalPid / 负数 durationSec / 字符串标记被归一', () => {
    const row = normalizeSessionRow({
      ...(oldSession as unknown as SessionRow),
      externalPid: 1.5,
      durationSec: -3,
      durationUnavailable: '1' as unknown as boolean
    })
    expect(row.externalPid).toBeUndefined()
    expect(row.durationSec).toBeUndefined()
    expect(row.durationUnavailable).toBeUndefined()
    expect(row.errorMessage).toBe('历史错误')
  })

  it('normalizeSessionRow：durationSec=0 视为 DB 缺省归一为 undefined，durationUnavailable=true 保留', () => {
    const row = normalizeSessionRow({
      ...(oldSession as unknown as SessionRow),
      externalPid: 0,
      durationSec: 0,
      durationUnavailable: true
    })
    expect(row.externalPid).toBeUndefined()
    expect(row.durationSec).toBeUndefined()
    expect(row.durationUnavailable).toBe(true)
  })

  it('rowToDevice：缺字段/脏 JSON 的老 row 安全归一，ID/IP/名称不丢失', () => {
    const device = rowToDevice({
      ...(oldDevice as unknown as DeviceRow),
      detectedPorts: '[3389,3389,0,70000,"x"]',
      osEvidence: 'not-json',
      osConfidence: 'weird',
      osManual: 1
    })
    expect(device.id).toBe('d-old')
    expect(device.ip).toBe('192.168.1.9')
    expect(device.name).toBe('老设备')
    expect(device.detectedPorts).toEqual([3389])
    expect(device.osEvidence).toEqual([])
    expect(device.osConfidence).toBe('none')
    expect(device.osManual).toBe(true)
  })
})

/** 用 sql.js 直接构造"迁移前"老库：表存在但缺新增列，且已写入历史数据 */
async function writeOldSqlite(userData: string): Promise<void> {
  const SQL = await initSqlJs({
    locateFile: (file: string) => path.join(process.cwd(), 'node_modules/sql.js/dist', file)
  })
  const db = new SQL.Database()
  db.run(`CREATE TABLE devices (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, ip TEXT NOT NULL,
    mac TEXT NOT NULL DEFAULT '', osHint TEXT NOT NULL DEFAULT 'unknown',
    source TEXT NOT NULL DEFAULT 'subnet', availableProtocols TEXT NOT NULL DEFAULT '[]',
    online INTEGER NOT NULL DEFAULT 0, lastSeenAt TEXT NOT NULL,
    createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)`)
  db.run(`CREATE TABLE credentials (
    id TEXT PRIMARY KEY, deviceId TEXT NOT NULL, protocol TEXT NOT NULL,
    username TEXT NOT NULL DEFAULT '', encryptedPassword TEXT NOT NULL DEFAULT '',
    createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, UNIQUE(deviceId, protocol))`)
  db.run(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY, deviceId TEXT NOT NULL, deviceName TEXT NOT NULL DEFAULT '',
    protocol TEXT NOT NULL, status TEXT NOT NULL, startedAt TEXT NOT NULL,
    endedAt TEXT NOT NULL DEFAULT '', errorMessage TEXT NOT NULL DEFAULT '')`)
  db.run('CREATE TABLE settings (setting_key TEXT PRIMARY KEY, setting_value TEXT NOT NULL)')

  db.run(
    `INSERT INTO devices (id,name,ip,mac,osHint,source,availableProtocols,online,lastSeenAt,createdAt,updatedAt)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      oldDevice.id, oldDevice.name, oldDevice.ip, oldDevice.mac, oldDevice.osHint,
      oldDevice.source, oldDevice.availableProtocols, oldDevice.online,
      oldDevice.lastSeenAt, oldDevice.createdAt, oldDevice.updatedAt
    ]
  )
  db.run(
    `INSERT INTO credentials (id,deviceId,protocol,username,encryptedPassword,createdAt,updatedAt)
     VALUES (?,?,?,?,?,?,?)`,
    [
      oldCredential.id, oldCredential.deviceId, oldCredential.protocol, oldCredential.username,
      oldCredential.encryptedPassword, oldCredential.createdAt, oldCredential.updatedAt
    ]
  )
  db.run(
    `INSERT INTO sessions (id,deviceId,deviceName,protocol,status,startedAt,endedAt,errorMessage)
     VALUES (?,?,?,?,?,?,?,?)`,
    [
      oldSession.id, oldSession.deviceId, oldSession.deviceName, oldSession.protocol,
      oldSession.status, oldSession.startedAt, oldSession.endedAt, oldSession.errorMessage
    ]
  )
  db.run('INSERT INTO settings (setting_key, setting_value) VALUES (?, ?)', [
    'defaultShareName',
    'share-old'
  ])
  fs.writeFileSync(path.join(userData, 'landesk.sqlite'), Buffer.from(db.export()))
  db.close()
}

async function readColumns(file: string, table: string): Promise<string[]> {
  const SQL = await initSqlJs({
    locateFile: (item: string) => path.join(process.cwd(), 'node_modules/sql.js/dist', item)
  })
  const db = new SQL.Database(new Uint8Array(fs.readFileSync(file)))
  const result = db.exec(`PRAGMA table_info(${table})`)
  const columns = result[0].values.map((row) => String(row[1]))
  db.close()
  return columns
}

describe('SQL 老库迁移 - ALTER 补列且历史数据零丢失', () => {
  it('旧表缺列时由 ALTER 补齐，设备/会话/凭据/设置全部保留', async () => {
    const dir = makeTempDir()
    await writeOldSqlite(dir)

    const store = await SqlStore.create(dir)

    const device = store.listDevices()[0]
    expect(device.id).toBe('d-old')
    expect(device.name).toBe('老设备')
    expect(device.ip).toBe('192.168.1.9')
    expect(device.availableProtocols).toBe('["rdp"]')
    expect(device.detectedPorts).toBe('[]')
    expect(device.osConfidence).toBe('none')
    expect(device.osEvidence).toBe('[]')
    expect(device.osManual).toBe(0)

    const session = store.listSessions()[0]
    expect(session.id).toBe('s-old')
    expect(session.errorMessage).toBe('历史错误')
    expect(session.externalPid).toBeUndefined()
    expect(session.durationSec).toBeUndefined()
    expect(session.durationUnavailable).toBeUndefined()

    expect(store.listCredentials()[0].encryptedPassword).toBe('cipher-old')
    expect(store.getSetting('defaultShareName')).toBe('share-old')

    // 真实断言列已被 ALTER 加到磁盘上的库文件，而不只是看内存返回值
    const file = path.join(dir, 'landesk.sqlite')
    expect(await readColumns(file, 'devices')).toEqual(
      expect.arrayContaining(['detectedPorts', 'osConfidence', 'osEvidence', 'osManual'])
    )
    expect(await readColumns(file, 'sessions')).toEqual(
      expect.arrayContaining(['externalPid', 'durationSec', 'durationUnavailable'])
    )
  })

  it('迁移可重复执行：duplicate column 被忽略，第二次打开不抛错且数据仍在', async () => {
    const dir = makeTempDir()
    await writeOldSqlite(dir)

    const first = await SqlStore.create(dir)
    const second = await SqlStore.create(dir)

    expect(first.mode()).toBe('sqlite')
    expect(second.listDevices()[0].name).toBe('老设备')
    expect(second.listSessions()[0].errorMessage).toBe('历史错误')
  })

  it('迁移后写入的运行期字段在重开数据库后保留', async () => {
    const dir = makeTempDir()
    await writeOldSqlite(dir)

    const first = await SqlStore.create(dir)
    const row = first.listSessions()[0]
    first.updateSession({ ...row, externalPid: 777, durationSec: 42 })

    const second = await SqlStore.create(dir)
    const reread = second.listSessions()[0]
    expect(reread.externalPid).toBe(777)
    expect(reread.durationSec).toBe(42)
    expect(reread.errorMessage).toBe('历史错误')
  })
})
