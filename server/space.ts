import { loadState } from '../shared/state'
import { persistState, readDelta } from '../shared/storage'
import { clone, type Operation } from '../src/domain/types'
import { maintenance } from '../src/domain/commands'
import { mergeOperation, type OperationResult, type ServerState } from '../src/sync/protocol'
import type { Session } from '../workers/auth/session'
import { ServerDatabase } from './database'
export class PersonalSpace {
  onCommit: (seq: number) => void = () => undefined
  constructor(readonly database: ServerDatabase) {}
  validSession(session: Session, now = Date.now()) {
    if (this.database.readMeta('subject') !== session.sub) return false
    const record = this.database.sql
      .exec<{ expires_at: number }>(
        'SELECT expires_at FROM sessions WHERE sid=? AND sub=?',
        session.sid,
        session.sub,
      )
      .toArray()[0]
    return !!record && record.expires_at > now / 1000
  }
  register(session: Session) {
    this.database.transaction(() => {
      const bound = this.database.readMeta('subject')
      if (bound && bound !== session.sub) throw new Error('Google 身份与已绑定空间不一致')
      if (!bound) this.database.writeMeta('subject', session.sub)
      this.database.sql.exec(
        'INSERT INTO sessions(sid,sub,expires_at) VALUES(?,?,?)',
        session.sid,
        session.sub,
        session.exp,
      )
    })
  }
  revoke(session: Session) {
    this.database.sql.exec('DELETE FROM sessions WHERE sid=?', session.sid)
  }
  registerRefresh(token: {
    hash: string
    familyId: string
    sub: string
    expiresAt: number
    absoluteExpiresAt: number
  }) {
    this.database.sql.exec(
      'INSERT INTO refresh_sessions(token_hash,family_id,sub,expires_at,absolute_expires_at) VALUES(?,?,?,?,?)',
      token.hash,
      token.familyId,
      token.sub,
      token.expiresAt,
      token.absoluteExpiresAt,
    )
  }
  rotateRefresh(oldHash: string, nextHash: string, now: number) {
    return this.database.transaction(() => {
      const row = this.database.sql
        .exec<{
          family_id: string
          sub: string
          expires_at: number
          absolute_expires_at: number
          used_at: number | null
          revoked_at: number | null
        }>(
          'SELECT family_id,sub,expires_at,absolute_expires_at,used_at,revoked_at FROM refresh_sessions WHERE token_hash=?',
          oldHash,
        )
        .toArray()[0]
      if (!row) return null
      if (row.used_at !== null || row.revoked_at !== null || row.expires_at <= now / 1000) {
        this.database.sql.exec(
          'UPDATE refresh_sessions SET revoked_at=? WHERE family_id=? AND revoked_at IS NULL',
          Math.floor(now / 1000),
          row.family_id,
        )
        return null
      }
      const expiresAt = Math.min(Math.floor(now / 1000) + 30 * 24 * 3600, row.absolute_expires_at)
      this.database.sql.exec(
        'UPDATE refresh_sessions SET used_at=? WHERE token_hash=?',
        Math.floor(now / 1000),
        oldHash,
      )
      this.database.sql.exec(
        'INSERT INTO refresh_sessions(token_hash,family_id,sub,expires_at,absolute_expires_at) VALUES(?,?,?,?,?)',
        nextHash,
        row.family_id,
        row.sub,
        expiresAt,
        row.absolute_expires_at,
      )
      return { sub: row.sub, expiresAt, absoluteExpiresAt: row.absolute_expires_at }
    })
  }
  revokeRefresh(tokenHash: string, now = Date.now()) {
    this.database.sql.exec(
      'UPDATE refresh_sessions SET revoked_at=? WHERE family_id=(SELECT family_id FROM refresh_sessions WHERE token_hash=?) AND revoked_at IS NULL',
      Math.floor(now / 1000),
      tokenHash,
    )
  }
  revokeAllRefresh(sub: string, now = Date.now()) {
    this.database.sql.exec(
      'UPDATE refresh_sessions SET revoked_at=? WHERE sub=? AND revoked_at IS NULL',
      Math.floor(now / 1000),
      sub,
    )
  }
  sync(since: number, operations: Operation[], now: number) {
    const sql = this.database.sql,
      current = Number(this.database.readMeta('seq') ?? 0)
    if (!operations.length) {
      const changes = readDelta(sql, since, current)
      if (changes !== null)
        return {
          schemaVersion: 1,
          seq: current,
          space: null,
          baseSeq: since,
          changes,
          results: [],
          serverTime: now,
        }
    }
    const { state, results, changed } = this.database.transaction(() => {
      let state = loadState(sql)
      const before = clone(state),
        results: OperationResult[] = []
      for (const op of operations) {
        const previous =
          typeof op?.opId === 'string'
            ? sql
                .exec<{ result: string }>('SELECT result FROM operations WHERE op_id=?', op.opId)
                .toArray()[0]
            : undefined
        if (previous) {
          results.push(JSON.parse(previous.result))
          continue
        }
        const merged = mergeOperation(state, op, now)
        state = merged.state
        results.push(merged.result)
      }
      persistState(sql, before, state, now)
      return { state, results, changed: state.seq !== before.seq }
    })
    if (changed) this.onCommit(state.seq)
    const changes = readDelta(sql, since, state.seq)
    return {
      schemaVersion: 1,
      seq: state.seq,
      space: changes === null ? state.space : null,
      ...(changes === null ? {} : { baseSeq: since, changes }),
      results,
      serverTime: now,
    }
  }
  runJobs(now = Date.now()) {
    const sql = this.database.sql
    const due = sql
      .exec<{ due_at: number }>('SELECT due_at FROM scheduled_jobs WHERE due_at<=? LIMIT 1', now)
      .toArray()[0]
    let seq: number | null = null
    this.database.transaction(() => {
      if (due) {
        const state: ServerState = loadState(sql),
          before = clone(state)
        state.space = maintenance(state.space, { now, id: () => crypto.randomUUID() })
        if (JSON.stringify(before.space) !== JSON.stringify(state.space)) {
          state.seq++
          for (const id of Object.keys(before.space.maps))
            if (!state.space.maps[id])
              state.tombstones[id] = {
                seq: state.seq,
                stamp: { deviceId: 'server', deviceSeq: state.seq, at: now, uncertainty: 0 },
              }
          persistState(sql, before, state, now)
          seq = state.seq
        }
      }
      sql.exec('DELETE FROM sessions WHERE expires_at<=?', Math.floor(now / 1000))
      sql.exec(
        'DELETE FROM refresh_sessions WHERE expires_at<=? OR (revoked_at IS NOT NULL AND revoked_at<?)',
        Math.floor(now / 1000),
        Math.floor(now / 1000) - 86400,
      )
    })
    if (seq !== null) this.onCommit(seq)
  }
}
