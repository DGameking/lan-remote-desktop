import { describe, it, expect } from 'vitest'
import initSqlJs from 'sql.js'

/**
 * v1.6 老库迁移冒烟：用真实 sql.js 构造 v1.5 老表（无收藏/别名等列），
 * 跑与 sql-store.ts 相同的 ALTER 迁移，验证老数据零丢失、默认值正确、重复迁移幂等。
 * 这里不 import SqlStore（它依赖 electron app.getAppPath），直接验证迁移 SQL 本身。
 */
const DEVICE_MIGRATIONS = [
  'ALTER TABLE devices ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE devices ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0',
  "ALTER TABLE devices ADD COLUMN alias TEXT NOT NULL DEFAULT ''",
  'ALTER TABLE devices ADD COLUMN "group" TEXT NOT NULL DEFAULT \'\''
]
const SESSION_MIGRATIONS = ["ALTER TABLE sessions ADD COLUMN note TEXT NOT NULL DEFAULT ''"]

function runMigrationList(db: { run(sql: string): void }, list: string[]): void {
  for (const sql of list) {
    try {
      db.run(sql)
    } catch (error) {
      if (!/duplicate column/i.test(String(error))) throw error
    }
  }
}

describe('v1.6 存储迁移 - 真实 sql.js 老库升级', () => {
  it('v1.5 老设备行升级后补齐新列且原字段零丢失', async () => {
    const SQL = await initSqlJs()
    const db = new SQL.Database()
    db.run(`CREATE TABLE devices (
      id TEXT PRIMARY KEY, name TEXT, ip TEXT, mac TEXT, osHint TEXT,
      osConfidence TEXT, osEvidence TEXT, osManual INTEGER, source TEXT,
      availableProtocols TEXT, detectedPorts TEXT, online INTEGER,
      lastSeenAt TEXT, createdAt TEXT, updatedAt TEXT)`)
    db.run(`INSERT INTO devices VALUES
      ('d1','老设备','192.168.1.5','','macos','high','[]',0,'subnet','["vnc"]','[5900]',1,'2026-01-01','2026-01-01','2026-01-01')`)

    runMigrationList(db, DEVICE_MIGRATIONS)
    const result = db.exec('SELECT id, name, ip, osHint, favorite, pinned, alias, "group" FROM devices')
    expect(result[0].columns).toContain('favorite')
    expect(result[0].values[0]).toEqual([
      'd1', '老设备', '192.168.1.5', 'macos', 0, 0, '', ''
    ])
    db.close()
  })

  it('重复执行迁移幂等，不抛错、不丢数据', async () => {
    const SQL = await initSqlJs()
    const db = new SQL.Database()
    db.run('CREATE TABLE devices (id TEXT PRIMARY KEY)')
    db.run("INSERT INTO devices VALUES ('d1')")
    runMigrationList(db, DEVICE_MIGRATIONS)
    runMigrationList(db, DEVICE_MIGRATIONS)
    const result = db.exec('SELECT id, favorite, alias FROM devices')
    expect(result[0].values[0]).toEqual(['d1', 0, ''])
    db.close()
  })

  it('新字段可正常写入读回，group 保留字用双引号可用', async () => {
    const SQL = await initSqlJs()
    const db = new SQL.Database()
    db.run('CREATE TABLE devices (id TEXT PRIMARY KEY)')
    runMigrationList(db, DEVICE_MIGRATIONS)
    db.run("INSERT INTO devices (id, favorite, pinned, alias, \"group\") VALUES ('d1', 1, 1, '书房', '办公')")
    const result = db.exec('SELECT favorite, pinned, alias, "group" FROM devices')
    expect(result[0].values[0]).toEqual([1, 1, '书房', '办公'])
    db.close()
  })

  it('v1.5 老会话表升级后补 note 列，原会话字段零丢失', async () => {
    const SQL = await initSqlJs()
    const db = new SQL.Database()
    db.run(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY, deviceId TEXT, deviceName TEXT, protocol TEXT, status TEXT,
      startedAt TEXT, endedAt TEXT, errorMessage TEXT, externalPid INTEGER,
      durationSec INTEGER, durationUnavailable INTEGER, ip TEXT)`)
    db.run(`INSERT INTO sessions VALUES
      ('s1','d1','老设备','vnc','ended','2026-01-01T00:00:00Z','2026-01-01T00:01:00Z','',12345,60,0,'192.168.1.5')`)
    runMigrationList(db, SESSION_MIGRATIONS)
    runMigrationList(db, SESSION_MIGRATIONS)
    const result = db.exec('SELECT id, ip, durationSec, note FROM sessions')
    expect(result[0].values[0]).toEqual(['s1', '192.168.1.5', 60, ''])
    db.close()
  })
})
