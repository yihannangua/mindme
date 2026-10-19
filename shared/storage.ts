export type SqlValue = string | number | null
export interface StorageSql {
  exec<T extends Record<string, SqlValue> = Record<string, SqlValue>>(
    query: string,
    ...bindings: SqlValue[]
  ): Iterable<T> & { toArray(): T[] }
}
import { diffSpace } from '../src/domain/operations'
import { nameKey } from '../src/domain/model'
import { equal, type MindMap } from '../src/domain/types'
import type { ServerState } from '../src/sync/protocol'

const schema = `CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS maps (id TEXT PRIMARY KEY, name_key TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS nodes (map_id TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(map_id,id));
CREATE TABLE IF NOT EXISTS markers (map_id TEXT NOT NULL, node_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(map_id,node_id));
CREATE TABLE IF NOT EXISTS tabs (map_id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS versions (map_id TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(map_id,id));
CREATE TABLE IF NOT EXISTS field_versions (field_key TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS deletion_records (entity_key TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS operations (op_id TEXT PRIMARY KEY, result TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, at INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS scheduled_jobs (id TEXT PRIMARY KEY, due_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, sub TEXT NOT NULL, expires_at INTEGER NOT NULL);`
export function initializeStorage(sql: StorageSql) {
  const exists =
    sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='metadata'").toArray()
      .length > 0
  if (exists) {
    const version = sql
      .exec<{ value: string }>('SELECT value FROM metadata WHERE key=?', 'schemaVersion')
      .toArray()[0]?.value
    if (version === '1') return
    if (version) throw new Error('数据库版本不兼容，请先执行迁移')
  }
  // 已有 v1 对象唤醒只读；额度耗尽也不因无意义 DDL 阻断会话查询。
  sql.exec(schema)
  sql.exec('INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)', 'schemaVersion', '1')
}
const meta = (map: MindMap) => {
  const { nodes: _nodes, history: _history, ...value } = map
  return value
}
function jobs(state: ServerState) {
  const result: Record<string, number> = {}
  for (const map of Object.values(state.space.maps)) {
    if (map.deletedAt !== null) result[`trash:${map.id}`] = map.deletedAt + 30 * 86400000
    else if (map.historyDirtySince !== null)
      result[`history:${map.id}`] = map.historyDirtySince + 300000
  }
  return result
}
export function persistState(
  sql: StorageSql,
  before: ServerState,
  after: ServerState,
  now: number,
) {
  const sync = <T>(
    previous: Record<string, T>,
    current: Record<string, T>,
    remove: (id: string) => void,
    put: (id: string, value: T) => void,
  ) => {
    for (const id of Object.keys(previous)) if (!Object.hasOwn(current, id)) remove(id)
    for (const [id, value] of Object.entries(current))
      if (!equal(previous[id], value)) put(id, value)
  }
  const ids = new Set([...Object.keys(before.space.maps), ...Object.keys(after.space.maps)])
  // 名称先统一释放，再写最终状态，保留批量删除/重命名的唯一性事务。
  const released = new Set<string>()
  for (const id of ids) {
    const old = before.space.maps[id],
      next = after.space.maps[id]
    if (old && (!next || nameKey(old.title) !== nameKey(next.title))) {
      sql.exec('DELETE FROM maps WHERE id=?', id)
      released.add(id)
    }
  }
  for (const id of ids) {
    const old = before.space.maps[id],
      next = after.space.maps[id]
    if (next && (!old || !equal(meta(old), meta(next)))) {
      if (!old || released.has(id))
        sql.exec(
          'INSERT INTO maps(id,name_key,data) VALUES(?,?,?)',
          id,
          nameKey(next.title),
          JSON.stringify(meta(next)),
        )
      else sql.exec('UPDATE maps SET data=? WHERE id=?', JSON.stringify(meta(next)), id)
    }
    sync(
      old?.nodes ?? {},
      next?.nodes ?? {},
      (nodeId) => sql.exec('DELETE FROM nodes WHERE map_id=? AND id=?', id, nodeId),
      (nodeId, node) =>
        sql.exec(
          'INSERT INTO nodes(map_id,id,data) VALUES(?,?,?) ON CONFLICT(map_id,id) DO UPDATE SET data=excluded.data',
          id,
          nodeId,
          JSON.stringify(node),
        ),
    )
    const markers = (map: MindMap | undefined) =>
      Object.fromEntries(Object.values(map?.nodes ?? {}).map((node) => [node.id, node.markers]))
    sync(
      markers(old),
      markers(next),
      (nodeId) => sql.exec('DELETE FROM markers WHERE map_id=? AND node_id=?', id, nodeId),
      (nodeId, value) =>
        sql.exec(
          'INSERT INTO markers(map_id,node_id,data) VALUES(?,?,?) ON CONFLICT(map_id,node_id) DO UPDATE SET data=excluded.data',
          id,
          nodeId,
          JSON.stringify(value),
        ),
    )
    sync(
      Object.fromEntries((old?.history ?? []).map((version) => [version.id, version])),
      Object.fromEntries((next?.history ?? []).map((version) => [version.id, version])),
      (versionId) => sql.exec('DELETE FROM versions WHERE map_id=? AND id=?', id, versionId),
      (versionId, version) =>
        sql.exec(
          'INSERT INTO versions(map_id,id,data) VALUES(?,?,?) ON CONFLICT(map_id,id) DO UPDATE SET data=excluded.data',
          id,
          versionId,
          JSON.stringify(version),
        ),
    )
  }
  sync(
    before.space.tabs,
    after.space.tabs,
    (id) => sql.exec('DELETE FROM tabs WHERE map_id=?', id),
    (id, value) =>
      sql.exec(
        'INSERT INTO tabs(map_id,data) VALUES(?,?) ON CONFLICT(map_id) DO UPDATE SET data=excluded.data',
        id,
        JSON.stringify(value),
      ),
  )
  sync(
    before.versions,
    after.versions,
    (key) => sql.exec('DELETE FROM field_versions WHERE field_key=?', key),
    (key, value) =>
      sql.exec(
        'INSERT INTO field_versions(field_key,data) VALUES(?,?) ON CONFLICT(field_key) DO UPDATE SET data=excluded.data',
        key,
        JSON.stringify(value),
      ),
  )
  for (const [key, value] of Object.entries(after.tombstones))
    if (!equal(before.tombstones[key], value))
      sql.exec(
        'INSERT INTO deletion_records(entity_key,data) VALUES(?,?) ON CONFLICT(entity_key) DO UPDATE SET data=excluded.data',
        key,
        JSON.stringify(value),
      )
  for (const [id, value] of Object.entries(after.results))
    if (!Object.hasOwn(before.results, id))
      sql.exec(
        'INSERT OR IGNORE INTO operations(op_id,result) VALUES(?,?)',
        id,
        JSON.stringify(value),
      )
  if (after.seq !== before.seq) {
    sql.exec(
      'INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      'seq',
      String(after.seq),
    )
    sql.exec(
      'INSERT INTO events(seq,at,data) VALUES(?,?,?)',
      after.seq,
      now,
      JSON.stringify(diffSpace(before.space, after.space)),
    )
    sql.exec('DELETE FROM events WHERE seq < ?', Math.max(0, after.seq - 1000))
  }
  sync(
    jobs(before),
    jobs(after),
    (id) => sql.exec('DELETE FROM scheduled_jobs WHERE id=?', id),
    (id, due) =>
      sql.exec(
        'INSERT INTO scheduled_jobs(id,due_at) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET due_at=excluded.due_at',
        id,
        due,
      ),
  )
}
export const MAX_DELTA_CHANGES = 30000
export const MAX_DELTA_BYTES = 4 * 1024 * 1024
export function readDelta(sql: StorageSql, since: number, seq: number) {
  if (since <= 0 || since > seq) return null
  if (since === seq) return []
  const earliest = sql
    .exec<{ seq: number | null }>('SELECT MIN(seq) AS seq FROM events')
    .toArray()[0]?.seq
  if (earliest === undefined || earliest === null || since < earliest - 1) return null
  const changes = []
  let bytes = 2
  for (const event of sql.exec<{ data: string }>(
    'SELECT data FROM events WHERE seq>? ORDER BY seq',
    since,
  )) {
    const data = JSON.parse(event.data)
    bytes += event.data.length
    if (
      !Array.isArray(data) ||
      bytes > MAX_DELTA_BYTES ||
      changes.length + data.length > MAX_DELTA_CHANGES
    )
      return null
    changes.push(...data)
  }
  return changes
}
