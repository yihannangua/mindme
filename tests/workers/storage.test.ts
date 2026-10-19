import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { initializeStorage, persistState, readDelta } from '../../workers/space-object/storage'
import { storageFailure } from '../../workers/api/failures'
import { makeNode } from '../../src/domain/model'
import { mergeOperation, newServerState, type ServerState } from '../../src/sync/protocol'
import { emptySpace } from '../../src/domain/types'
import { edit, first, operation, seed } from '../helpers'
function database() {
  const db = new DatabaseSync(':memory:'),
    queries: string[] = []
  let rejectWrites = false
  const sql = {
    exec(query: string, ...bindings: (string | number | null)[]) {
      queries.push(query)
      if (rejectWrites && /^\s*(CREATE|INSERT|UPDATE|DELETE|ALTER)\b/i.test(query))
        throw new Error('Exceeded allowed rows written in Durable Objects free tier.')
      if (query.trim().split(';').filter(Boolean).length > 1) {
        db.exec(query)
        return { toArray: () => [] }
      }
      const statement = db.prepare(query)
      if (statement.columns().length) {
        const rows = statement.all(...bindings)
        return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() }
      }
      statement.run(...bindings)
      return { toArray: () => [] }
    },
  }
  const changes = () =>
    (db.prepare('SELECT total_changes() AS count').get() as { count: number }).count
  return {
    db,
    sql: sql as unknown as SqlStorage,
    queries,
    changes,
    block: () => {
      rejectWrites = true
    },
  }
}
function bigState() {
  const space = seed(),
    map = first(space)
  for (let i = 0; i < 3993; i++) {
    const id = `node-${i}`
    map.nodes[id] = makeNode(id, map.rootId, `主题 ${i}`, i)
  }
  return mergeOperation(newServerState(), operation(emptySpace(), space), 10000).state
}
describe('SQLite 写入额度与增量持久化', () => {
  it('已有数据库冷启动在禁止写入时仍能通过版本查询，不执行任何 DDL', () => {
    const { db, sql, queries, changes, block } = database()
    initializeStorage(sql)
    const written = changes()
    queries.length = 0
    block()
    expect(() => initializeStorage(sql)).not.toThrow()
    expect(changes()).toBe(written)
    expect(queries.every((query) => query.startsWith('SELECT'))).toBe(true)
    db.close()
  })
  it('3994 节点单点改字只更新目标行，SQL 行变化有固定上限', () => {
    const { db, sql, queries, changes } = database()
    initializeStorage(sql)
    const before = bigState()
    persistState(sql, newServerState(), before, 10000)
    const nextSpace = edit(before.space, { type: 'text', nodeId: 'node-2000', text: '只改此处' })
    const merged = mergeOperation(
      before,
      operation(before.space, nextSpace, 'A', 11000, 1, before.seq),
      12000,
    )
    expect(merged.result.status).toBe('accepted')
    const written = changes()
    queries.length = 0
    persistState(sql, before, merged.state, 12000)
    expect(changes() - written).toBeLessThanOrEqual(12)
    expect(queries.filter((query) => query.startsWith('INSERT INTO nodes'))).toHaveLength(1)
    expect(
      queries.some((query) => /DELETE FROM (nodes|markers|versions) WHERE map_id=\?$/.test(query)),
    ).toBe(false)
    expect(
      JSON.parse(
        (db.prepare('SELECT data FROM nodes WHERE id=?').get('node-2000') as { data: string }).data,
      ).text,
    ).toBe('只改此处')
    expect(
      (db.prepare('SELECT COUNT(*) AS count FROM nodes').get() as { count: number }).count,
    ).toBe(3994)
    db.close()
  })
  it('新增历史版本事件只写 history-add，不重复携带整段历史', () => {
    const { db, sql } = database()
    initializeStorage(sql)
    const before = bigState()
    persistState(sql, newServerState(), before, 10000)
    const next = structuredClone(before),
      mapId = Object.keys(next.space.maps)[0],
      map = next.space.maps[mapId]
    map.history.push({
      schemaVersion: 1,
      id: 'history-add-only',
      at: 11000,
      reason: 'window',
      content: { id: map.id, title: map.title, rootId: map.rootId, nodes: {}, deletedAt: null },
    })
    next.seq++
    persistState(sql, before, next, 11000)
    const changes = readDelta(sql, before.seq, next.seq)!
    expect(changes).toHaveLength(1)
    expect(changes[0].field).toBe('history-add')
    expect(JSON.stringify(changes).length).toBeLessThan(1000)
    db.close()
  })
  it('增量过大时返回空结果标记，让客户端改取完整空间', () => {
    const { db, sql } = database()
    initializeStorage(sql)
    const before = bigState()
    persistState(sql, newServerState(), before, 10000)
    const next = structuredClone(before)
    next.seq++
    const largeMap = next.space.maps[Object.keys(next.space.maps)[0]]
    for (let i = 0; i < 6; i++)
      largeMap.history.push({
        schemaVersion: 1,
        id: `large-history-${i}`,
        at: 11000 + i,
        reason: 'window',
        content: structuredClone(largeMap),
      })
    persistState(sql, before, next, 11000)
    expect(readDelta(sql, before.seq, next.seq)).toBeNull()
    db.close()
  })
  it('空闲同步、重复确认及相同字段版本不产生数据库写入', () => {
    const { db, sql, changes, queries, block } = database()
    initializeStorage(sql)
    const before = bigState()
    persistState(sql, newServerState(), before, 10000)
    const written = changes(),
      next = structuredClone(before)
    queries.length = 0
    block()
    persistState(sql, before, next, 20000)
    expect(readDelta(sql, before.seq, before.seq)).toEqual([])
    expect(changes()).toBe(written)
    expect(queries).toEqual([])
    db.close()
  })
  it('历史与任务只写差异，单个标记不重写其他标记', () => {
    const { db, sql, queries } = database()
    initializeStorage(sql)
    const before = bigState()
    persistState(sql, newServerState(), before, 10000)
    const space = edit(before.space, {
      type: 'marker',
      nodeId: 'node-42',
      category: 'flag',
      value: 'blue',
    })
    const next = mergeOperation(
      before,
      operation(before.space, space, 'A', 11000, 1, before.seq),
      12000,
    ).state
    queries.length = 0
    persistState(sql, before, next, 12000)
    expect(queries.filter((query) => query.startsWith('INSERT INTO markers'))).toHaveLength(1)
    expect(
      queries.some(
        (query) => query.includes('INTO versions') || query.includes('INTO scheduled_jobs'),
      ),
    ).toBe(false)
    db.close()
  })
  it('同批删除后名称复用仍然原子有效，删除旧节点和版本', () => {
    const { db, sql } = database()
    initializeStorage(sql)
    const before = bigState()
    persistState(sql, newServerState(), before, 10000)
    const after: ServerState = structuredClone(before),
      old = first(after.space),
      replacementId = 'replacement'
    delete after.space.maps[old.id]
    delete after.space.tabs[old.id]
    const root = makeNode('new-root', null, old.title)
    after.space.maps[replacementId] = {
      ...old,
      id: replacementId,
      rootId: root.id,
      nodes: { [root.id]: root },
    }
    after.seq++
    persistState(sql, before, after, 12000)
    expect(
      (db.prepare('SELECT COUNT(*) AS count FROM nodes').get() as { count: number }).count,
    ).toBe(1)
    expect((db.prepare('SELECT id FROM maps').get() as { id: string }).id).toBe(replacementId)
    db.close()
  })
  it('免费写入额度耗尽返回明确错误及 UTC 次日重试时间，其他异常不泄露', async () => {
    const now = Date.UTC(2026, 9, 16, 6, 30),
      response = storageFailure(
        new Error('Exceeded allowed rows written in Durable Objects free tier.'),
        now,
      )!
    expect(response.status).toBe(429)
    expect(Number(response.headers.get('Retry-After'))).toBe(63000)
    const body = (await response.json()) as { code: string; error: string; retryAt: number }
    expect(body.code).toBe('STORAGE_WRITE_QUOTA')
    expect(body.error).toContain('10/17 08:00')
    expect(body.retryAt).toBe(Date.UTC(2026, 9, 17))
    expect(storageFailure(new Error('私密内容'))).toBeNull()
  })
})
