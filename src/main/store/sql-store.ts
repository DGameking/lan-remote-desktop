import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import initSqlJs from 'sql.js'
import { logger } from '../logger'
import { normalizeSessionRow, type CredentialRow, type DeviceRow, type SessionRow, type Store } from './types'

/** 只声明本模块用到的 sql.js 能力，避免类型版本差异带来的编译噪音 */
interface SqlExecResult {
  columns: string[]
  values: unknown[][]
}

interface SqlDatabase {
  run(sql: string, params?: unknown[]): void
  exec(sql: string): SqlExecResult[]
  export(): Uint8Array
  close(): void
}

const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    ip TEXT NOT NULL,
    mac TEXT NOT NULL DEFAULT '',
    osHint TEXT NOT NULL DEFAULT 'unknown',
    osConfidence TEXT NOT NULL DEFAULT 'none',
    osEvidence TEXT NOT NULL DEFAULT '[]',
    osManual INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'subnet',
    availableProtocols TEXT NOT NULL DEFAULT '[]',
    detectedPorts TEXT NOT NULL DEFAULT '[]',
    online INTEGER NOT NULL DEFAULT 0,
    lastSeenAt TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS credentials (
    id TEXT PRIMARY KEY,
    deviceId TEXT NOT NULL,
    protocol TEXT NOT NULL,
    username TEXT NOT NULL DEFAULT '',
    encryptedPassword TEXT NOT NULL DEFAULT '',
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    UNIQUE(deviceId, protocol)
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    deviceId TEXT NOT NULL,
    deviceName TEXT NOT NULL DEFAULT '',
    protocol TEXT NOT NULL,
    status TEXT NOT NULL,
    startedAt TEXT NOT NULL,
    endedAt TEXT NOT NULL DEFAULT '',
    errorMessage TEXT NOT NULL DEFAULT '',
    externalPid INTEGER NOT NULL DEFAULT 0,
    durationSec INTEGER NOT NULL DEFAULT 0,
    durationUnavailable INTEGER NOT NULL DEFAULT 0,
    ip TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    setting_key TEXT PRIMARY KEY,
    setting_value TEXT NOT NULL
  )`
]

/** sql.js（WASM）持久化实现，数据库文件位于 userData/landesk.sqlite */
export class SqlStore implements Store {
  private constructor(private readonly db: SqlDatabase, private readonly file: string) {}

  static async create(userData: string): Promise<SqlStore> {
    const SQL = await initSqlJs({
      locateFile: (file: string) => path.join(app.getAppPath(), 'node_modules/sql.js/dist', file)
    })
    const file = path.join(userData, 'landesk.sqlite')
    let database: SqlDatabase
    if (fs.existsSync(file)) {
      const bytes = new Uint8Array(fs.readFileSync(file))
      database = new SQL.Database(bytes) as unknown as SqlDatabase
    } else {
      database = new SQL.Database() as unknown as SqlDatabase
    }
    const store = new SqlStore(database, file)
    for (const statement of SCHEMA) database.run(statement)
    // 老库升级：CREATE TABLE IF NOT EXISTS 不会为已存在的表补列，这里显式补齐新增列。
    // 已含该列时 ALTER 会抛 duplicate column，按预期忽略，保证已有用户数据零丢失。
    const migrations = [
      `ALTER TABLE devices ADD COLUMN detectedPorts TEXT NOT NULL DEFAULT '[]'`,
      `ALTER TABLE devices ADD COLUMN osConfidence TEXT NOT NULL DEFAULT 'none'`,
      `ALTER TABLE devices ADD COLUMN osEvidence TEXT NOT NULL DEFAULT '[]'`,
      `ALTER TABLE devices ADD COLUMN osManual INTEGER NOT NULL DEFAULT 0`,
      // v1.5-P0-2: 会话运行期字段（老库缺列时补齐，duplicate column 按预期忽略）
      `ALTER TABLE sessions ADD COLUMN externalPid INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE sessions ADD COLUMN durationSec INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE sessions ADD COLUMN durationUnavailable INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE sessions ADD COLUMN ip TEXT NOT NULL DEFAULT ''`
    ]
    for (const sql of migrations) {
      try {
        database.run(sql)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!/duplicate column/i.test(message)) throw error
      }
    }
    store.persist()
    logger.info('SQLite 存储初始化成功', { file })
    return store
  }

  mode(): 'sqlite' | 'json' {
    return 'sqlite'
  }

  private all<T>(sql: string): T[] {
    const results = this.db.exec(sql)
    if (results.length === 0) return []
    const { columns, values } = results[0]
    return values.map((row) => {
      const obj: Record<string, unknown> = {}
      columns.forEach((column, index) => {
        obj[column] = row[index]
      })
      return obj as unknown as T
    })
  }

  private persist(): void {
    fs.writeFileSync(this.file, Buffer.from(this.db.export()))
  }

  listDevices(): DeviceRow[] {
    return this.all<DeviceRow>('SELECT * FROM devices ORDER BY lastSeenAt DESC')
  }

  upsertDevice(row: DeviceRow): void {
    this.db.run(
      `INSERT OR REPLACE INTO devices
       (id, name, ip, mac, osHint, osConfidence, osEvidence, osManual, source, availableProtocols, detectedPorts, online, lastSeenAt, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id, row.name, row.ip, row.mac, row.osHint,
        row.osConfidence ?? 'none', row.osEvidence ?? '[]', row.osManual ?? 0,
        row.source, row.availableProtocols, row.detectedPorts, row.online,
        row.lastSeenAt, row.createdAt, row.updatedAt
      ]
    )
    this.persist()
  }

  deleteDevice(id: string): void {
    this.db.run('DELETE FROM devices WHERE id = ?', [id])
    this.db.run('DELETE FROM credentials WHERE deviceId = ?', [id])
    this.persist()
  }

  listCredentials(): CredentialRow[] {
    return this.all<CredentialRow>('SELECT * FROM credentials ORDER BY updatedAt DESC')
  }

  setCredential(row: CredentialRow): void {
    this.db.run(
      `INSERT OR REPLACE INTO credentials
       (id, deviceId, protocol, username, encryptedPassword, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.deviceId, row.protocol, row.username, row.encryptedPassword, row.createdAt, row.updatedAt]
    )
    this.persist()
  }

  deleteCredential(id: string): void {
    this.db.run('DELETE FROM credentials WHERE id = ?', [id])
    this.persist()
  }

  listSessions(): SessionRow[] {
    return this.all<SessionRow>('SELECT * FROM sessions ORDER BY startedAt DESC LIMIT 200').map(
      normalizeSessionRow
    )
  }

  addSession(row: SessionRow): void {
    this.db.run(
      `INSERT INTO sessions
       (id, deviceId, deviceName, protocol, status, startedAt, endedAt, errorMessage,
        externalPid, durationSec, durationUnavailable, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id, row.deviceId, row.deviceName, row.protocol, row.status, row.startedAt, row.endedAt,
        row.errorMessage,
        row.externalPid ?? 0, row.durationSec ?? 0, row.durationUnavailable ? 1 : 0,
        row.ip ?? ''
      ]
    )
    this.persist()
  }

  updateSession(row: SessionRow): void {
    this.db.run(
      `UPDATE sessions SET status = ?, endedAt = ?, errorMessage = ?,
        externalPid = ?, durationSec = ?, durationUnavailable = ?, ip = ? WHERE id = ?`,
      [
        row.status, row.endedAt, row.errorMessage,
        row.externalPid ?? 0, row.durationSec ?? 0, row.durationUnavailable ? 1 : 0,
        row.ip ?? '', row.id
      ]
    )
    this.persist()
  }

  clearSessions(): void {
    this.db.run('DELETE FROM sessions')
    this.persist()
  }

  getSetting(key: string): string | undefined {
    const rows = this.all<{ setting_key: string; setting_value: string }>(
      'SELECT setting_key, setting_value FROM settings'
    )
    return rows.find((row) => row.setting_key === key)?.setting_value
  }

  setSetting(key: string, value: string): void {
    this.db.run('INSERT OR REPLACE INTO settings (setting_key, setting_value) VALUES (?, ?)', [key, value])
    this.persist()
  }
}
