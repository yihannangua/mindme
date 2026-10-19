import { DatabaseSync, backup } from 'node:sqlite'
import { mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { initializeStorage, persistState, type SqlValue, type StorageSql } from '../shared/storage'
import { exportMigration, validateMigration, type MigrationSnapshot } from '../shared/state'
import { assert } from '../src/domain/types'
import { newServerState } from '../src/sync/protocol'
export class ServerDatabase {
  readonly db: DatabaseSync
  readonly sql: StorageSql
  private closed = false
  constructor(readonly path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    if (path !== ':memory:') chmodSync(path, 0o600)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;')
    this.sql = {
      exec: <T extends Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]) => {
        if (query.trim().split(';').filter(Boolean).length > 1) {
          this.db.exec(query)
          return { toArray: () => [] as T[], *[Symbol.iterator]() {} }
        }
        const statement = this.db.prepare(query)
        const rows = statement.columns().length
          ? (statement.all(...bindings) as T[])
          : (statement.run(...bindings), [] as T[])
        return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() }
      },
    }
    this.transaction(() => initializeStorage(this.sql))
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS passkeys (
        credential_id TEXT PRIMARY KEY,
        public_key TEXT NOT NULL,
        counter INTEGER NOT NULL,
        transports TEXT NOT NULL,
        device_type TEXT NOT NULL,
        backed_up INTEGER NOT NULL,
        sub TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_challenges (
        flow_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        challenge TEXT NOT NULL,
        sub TEXT NOT NULL,
        setup_token_hash TEXT,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS recovery_codes (
        code_hash TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS recovery_attempts (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        attempts INTEGER NOT NULL,
        window_started INTEGER NOT NULL,
        blocked_until INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS refresh_sessions (
        token_hash TEXT PRIMARY KEY,
        family_id TEXT NOT NULL,
        sub TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        absolute_expires_at INTEGER NOT NULL,
        used_at INTEGER,
        revoked_at INTEGER
      );
    `)
  }
  transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = action()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  readMeta(key: string) {
    return this.sql
      .exec<{ value: string }>('SELECT value FROM metadata WHERE key=?', key)
      .toArray()[0]?.value
  }
  writeMeta(key: string, value: string) {
    this.sql.exec(
      'INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      key,
      value,
    )
  }
  export(now = Date.now()) {
    return this.transaction(() => exportMigration(this.sql, now))
  }
  import(snapshot: MigrationSnapshot) {
    validateMigration(snapshot)
    this.transaction(() => {
      assert(
        Number(this.readMeta('seq') ?? 0) === 0 &&
          !this.readMeta('subject') &&
          this.sql.exec('SELECT id FROM maps LIMIT 1').toArray().length === 0 &&
          this.sql.exec('SELECT op_id FROM operations LIMIT 1').toArray().length === 0,
        '目标数据库已有空间数据，拒绝覆盖；请使用新的数据库文件',
      )
      persistState(this.sql, newServerState(), snapshot.state, snapshot.exportedAt)
      if (snapshot.subject) this.writeMeta('subject', snapshot.subject)
      this.writeMeta('seq', String(snapshot.state.seq))
      // 精确保留源事件和操作结果，已有设备的基线与 outbox 不需要重置。
      this.sql.exec('DELETE FROM events')
      for (const event of snapshot.events)
        this.sql.exec(
          'INSERT INTO events(seq,at,data) VALUES(?,?,?)',
          event.seq,
          event.at,
          JSON.stringify(event.changes),
        )
      for (const session of snapshot.sessions)
        this.sql.exec(
          'INSERT INTO sessions(sid,sub,expires_at) VALUES(?,?,?)',
          session.sid,
          session.sub,
          session.expiresAt,
        )
      this.writeMeta('migrationExportedAt', String(snapshot.exportedAt))
    })
  }
  async backup(destination: string) {
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
    await backup(this.db, destination)
    chmodSync(destination, 0o600)
  }
  close() {
    if (!this.closed) {
      this.db.close()
      this.closed = true
    }
  }
}
