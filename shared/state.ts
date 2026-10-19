import { validateSpace } from '../src/domain/model'
import { assert, safeId } from '../src/domain/types'
import { newServerState, type ServerState } from '../src/sync/protocol'
import type { StorageSql } from './storage'
export function loadState(sql: StorageSql): ServerState {
  const state = newServerState()
  state.seq = Number(
    sql.exec<{ value: string }>('SELECT value FROM metadata WHERE key=?', 'seq').toArray()[0]
      ?.value ?? 0,
  )
  for (const row of sql.exec<{ data: string }>('SELECT data FROM maps')) {
    const map = JSON.parse(row.data)
    state.space.maps[map.id] = { ...map, nodes: {}, history: [] }
  }
  for (const row of sql.exec<{ map_id: string; data: string }>('SELECT map_id,data FROM nodes')) {
    const node = JSON.parse(row.data)
    if (state.space.maps[row.map_id]) state.space.maps[row.map_id].nodes[node.id] = node
  }
  for (const row of sql.exec<{ map_id: string; data: string }>('SELECT map_id,data FROM versions'))
    if (state.space.maps[row.map_id])
      state.space.maps[row.map_id].history.push(JSON.parse(row.data))
  for (const map of Object.values(state.space.maps)) map.history.sort((a, b) => a.at - b.at)
  for (const row of sql.exec<{ data: string }>('SELECT data FROM tabs')) {
    const tab = JSON.parse(row.data)
    state.space.tabs[tab.mapId] = tab
  }
  for (const row of sql.exec<{ field_key: string; data: string }>(
    'SELECT field_key,data FROM field_versions',
  ))
    state.versions[row.field_key] = JSON.parse(row.data)
  for (const row of sql.exec<{ entity_key: string; data: string }>(
    'SELECT entity_key,data FROM deletion_records',
  ))
    state.tombstones[row.entity_key] = JSON.parse(row.data)
  return state
}
export interface MigrationSnapshot {
  format: 'mindme-server'
  schemaVersion: 1
  exportedAt: number
  subject: string | null
  state: ServerState
  sessions: { sid: string; sub: string; expiresAt: number }[]
  events: { seq: number; at: number; changes: unknown[] }[]
}
export function exportMigration(sql: StorageSql, now: number): MigrationSnapshot {
  const state = loadState(sql)
  for (const row of sql.exec<{ op_id: string; result: string }>(
    'SELECT op_id,result FROM operations',
  ))
    state.results[row.op_id] = JSON.parse(row.result)
  const result: MigrationSnapshot = {
    format: 'mindme-server',
    schemaVersion: 1,
    exportedAt: now,
    subject:
      sql.exec<{ value: string }>('SELECT value FROM metadata WHERE key=?', 'subject').toArray()[0]
        ?.value ?? null,
    state,
    sessions: sql
      .exec<{ sid: string; sub: string; expires_at: number }>(
        'SELECT sid,sub,expires_at FROM sessions',
      )
      .toArray()
      .map((row) => ({ sid: row.sid, sub: row.sub, expiresAt: row.expires_at })),
    events: sql
      .exec<{ seq: number; at: number; data: string }>(
        'SELECT seq,at,data FROM events ORDER BY seq',
      )
      .toArray()
      .map((row) => ({ seq: row.seq, at: row.at, changes: JSON.parse(row.data) })),
  }
  validateMigration(result)
  return result
}
export function validateMigration(value: MigrationSnapshot) {
  assert(
    value &&
      value.format === 'mindme-server' &&
      value.schemaVersion === 1 &&
      Number.isFinite(value.exportedAt),
    '不支持的完整空间迁移格式',
  )
  const state = value.state
  assert(
    state && state.schemaVersion === 1 && Number.isSafeInteger(state.seq) && state.seq >= 0,
    '迁移修订号不合法',
  )
  validateSpace(state.space)
  assert(
    value.subject === null ||
      (typeof value.subject === 'string' && value.subject.length > 0 && value.subject.length < 256),
    '迁移身份不合法',
  )
  assert(
    value.subject !== null || !Object.keys(state.space.maps).length,
    '已有空间必须绑定原始 Google 身份',
  )
  for (const field of ['versions', 'tombstones', 'results'] as const)
    assert(
      state[field] && typeof state[field] === 'object' && !Array.isArray(state[field]),
      '迁移操作记录不合法',
    )
  for (const version of Object.values(state.versions))
    assert(
      version &&
        Number.isSafeInteger(version.seq) &&
        version.seq <= state.seq &&
        version.stamp &&
        safeId(version.stamp.deviceId) &&
        Number.isSafeInteger(version.stamp.deviceSeq) &&
        Number.isFinite(version.stamp.at) &&
        Number.isFinite(version.stamp.uncertainty),
      '字段版本不合法',
    )
  for (const result of Object.values(state.results))
    assert(
      result &&
        safeId(result.opId) &&
        Number.isSafeInteger(result.seq) &&
        result.seq <= state.seq &&
        ['accepted', 'stale', 'conflict', 'rejected'].includes(result.status),
      '操作去重记录不合法',
    )
  assert(
    Array.isArray(value.sessions) &&
      value.sessions.every(
        (session) =>
          session &&
          safeId(session.sid) &&
          session.sub === value.subject &&
          Number.isFinite(session.expiresAt),
      ),
    '迁移会话不合法',
  )
  assert(Array.isArray(value.events) && value.events.length <= 1001, '迁移事件数量不合法')
  const seen = new Set<number>()
  for (const event of value.events) {
    assert(
      event &&
        Number.isSafeInteger(event.seq) &&
        event.seq > 0 &&
        event.seq <= state.seq &&
        !seen.has(event.seq) &&
        Number.isFinite(event.at) &&
        Array.isArray(event.changes),
      '迁移事件不合法',
    )
    seen.add(event.seq)
  }
}
