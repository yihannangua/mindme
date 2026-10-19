import { DurableObject } from 'cloudflare:workers'
import type { Env } from '../env'
import { json, readJson } from '../api/http'
import { diffSpace } from '../../src/domain/operations'
import { maintenance } from '../../src/domain/commands'
import { clone, type Operation } from '../../src/domain/types'
import {
  mergeOperation,
  newServerState,
  type OperationResult,
  type ServerState,
} from '../../src/sync/protocol'
import { initializeStorage, persistState, readDelta } from './storage'
import { storageFailure } from '../api/failures'
import { exportMigration } from '../../shared/state'
import type { Session } from '../auth/session'

export class SpaceObject extends DurableObject<Env> {
  private sql: SqlStorage
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    initializeStorage(this.sql)
  }
  private readMeta(key: string) {
    return this.sql
      .exec<{ value: string }>('SELECT value FROM metadata WHERE key = ?', key)
      .toArray()[0]?.value
  }
  private writeMeta(key: string, value: string) {
    this.sql.exec('INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)', key, value)
  }
  private load(): ServerState {
    const state = newServerState()
    state.seq = Number(this.readMeta('seq') ?? '0')
    for (const row of this.sql.exec<{ data: string }>('SELECT data FROM maps')) {
      const map = JSON.parse(row.data)
      state.space.maps[map.id] = { ...map, nodes: {}, history: [] }
    }
    for (const row of this.sql.exec<{ map_id: string; data: string }>(
      'SELECT map_id,data FROM nodes',
    )) {
      const node = JSON.parse(row.data)
      if (state.space.maps[row.map_id]) state.space.maps[row.map_id].nodes[node.id] = node
    }
    for (const row of this.sql.exec<{ map_id: string; data: string }>(
      'SELECT map_id,data FROM versions',
    ))
      if (state.space.maps[row.map_id])
        state.space.maps[row.map_id].history.push(JSON.parse(row.data))
    for (const map of Object.values(state.space.maps)) map.history.sort((a, b) => a.at - b.at)
    for (const row of this.sql.exec<{ data: string }>('SELECT data FROM tabs')) {
      const tab = JSON.parse(row.data)
      state.space.tabs[tab.mapId] = tab
    }
    for (const row of this.sql.exec<{ field_key: string; data: string }>(
      'SELECT field_key,data FROM field_versions',
    ))
      state.versions[row.field_key] = JSON.parse(row.data)
    for (const row of this.sql.exec<{ entity_key: string; data: string }>(
      'SELECT entity_key,data FROM deletion_records',
    ))
      state.tombstones[row.entity_key] = JSON.parse(row.data)
    // 操作结果按请求中的 op_id 查询，避免历史操作结果随空间大小一起加载。
    return state
  }
  private async schedule() {
    const job = this.sql
      .exec<{ due: number | null }>('SELECT MIN(due_at) AS due FROM scheduled_jobs')
      .toArray()[0]
    const session = this.sql
      .exec<{ due: number | null }>('SELECT MIN(expires_at)*1000 AS due FROM sessions')
      .toArray()[0]
    const due = Math.min(job?.due ?? Infinity, session?.due ?? Infinity)
    const current = await this.ctx.storage.getAlarm()
    if (Number.isFinite(due)) {
      const next = Math.max(Date.now() + 1000, due)
      if (current === null || Math.abs(current - next) > 1000) await this.ctx.storage.setAlarm(next)
    } else if (current !== null) await this.ctx.storage.deleteAlarm()
  }
  private validSession(request: Request) {
    const sid = request.headers.get('X-Session-Id'),
      sub = request.headers.get('X-Auth-Sub')
    if (!sid || !sub || this.readMeta('subject') !== sub) return false
    const session = this.sql
      .exec<{ expires_at: number }>(
        'SELECT expires_at FROM sessions WHERE sid=? AND sub=?',
        sid,
        sub,
      )
      .toArray()[0]
    return !!session && session.expires_at > Date.now() / 1000
  }
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    if (path === '/internal/migration-export') {
      if (request.method !== 'POST' || request.headers.get('X-Migration-Approved') !== '1')
        return json({ error: '迁移接口不可用' }, 404)
      // Worker 已完成短期令牌校验；同步只读遍历没有 await，不启动写事务。
      const snapshot = exportMigration(this.sql, Date.now())
      return json(snapshot, 200, {
        'Content-Disposition': 'attachment; filename="mindme-server-migration.json"',
      })
    }
    if (path === '/internal/register-session' && request.method === 'POST') {
      const session = (await request.json()) as Session
      const bound = this.readMeta('subject')
      if (bound && bound !== session.sub) return json({ error: '身份不匹配' }, 403)
      this.ctx.storage.transactionSync(() => {
        this.writeMeta('subject', session.sub)
        this.sql.exec(
          'INSERT INTO sessions(sid,sub,expires_at) VALUES(?,?,?)',
          session.sid,
          session.sub,
          session.exp,
        )
      })
      await this.schedule()
      return json({ ok: true })
    }
    if (!this.validSession(request)) return json({ error: '会话已过期或无权访问' }, 401)
    if (path === '/internal/check-session') return json({ ok: true })
    if (path === '/internal/logout') {
      this.sql.exec('DELETE FROM sessions WHERE sid=?', request.headers.get('X-Session-Id'))
      for (const socket of this.ctx.getWebSockets())
        if (
          (socket.deserializeAttachment() as { sid: string }).sid ===
          request.headers.get('X-Session-Id')
        )
          socket.close(1008, '会话已退出')
      return json({ ok: true })
    }
    if (path === '/api/ws') {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
        return json({ error: '需要 WebSocket 升级' }, 426)
      const pair = new WebSocketPair(),
        [client, server] = Object.values(pair)
      this.ctx.acceptWebSocket(server)
      server.serializeAttachment({
        sid: request.headers.get('X-Session-Id'),
        sub: request.headers.get('X-Auth-Sub'),
      })
      return new Response(null, { status: 101, webSocket: client })
    }
    if (path !== '/api/sync' || request.method !== 'POST') return json({ error: '接口不存在' }, 404)
    let body: { schemaVersion: number; since: number; operations: Operation[] }
    try {
      body = (await readJson(request, 24 * 1024 * 1024)) as typeof body
      if (
        !body ||
        body.schemaVersion !== 1 ||
        !Number.isSafeInteger(body.since) ||
        body.since < 0 ||
        !Array.isArray(body.operations) ||
        body.operations.length > 100
      )
        throw new Error('同步格式不合法')
    } catch {
      return json({ error: '同步格式不合法或请求过大' }, 400)
    }
    if (this.env.MIGRATION_READ_ONLY === 'true' && body.operations.length)
      return json(
        { error: '空间正在迁移，请稍后重试；本地修改保留', code: 'MIGRATION_IN_PROGRESS' },
        503,
        { 'Retry-After': '60' },
      )
    if (!body.operations.length) {
      const seq = Number(this.readMeta('seq') ?? '0'),
        changes = readDelta(this.sql, body.since, seq)
      if (changes !== null)
        return json({
          schemaVersion: 1,
          seq,
          space: null,
          baseSeq: body.since,
          changes,
          results: [],
          serverTime: Date.now(),
          subject: request.headers.get('X-Auth-Sub'),
        })
    }
    let responseState: ServerState,
      results: OperationResult[] = []
    try {
      this.ctx.storage.transactionSync(() => {
        let state = this.load()
        const before = clone(state)
        for (const op of body.operations) {
          const duplicate =
            typeof op?.opId === 'string'
              ? this.sql
                  .exec<{ result: string }>('SELECT result FROM operations WHERE op_id=?', op.opId)
                  .toArray()[0]
              : undefined
          if (duplicate) {
            results.push(JSON.parse(duplicate.result))
            continue
          }
          const merged = mergeOperation(state, op, Date.now())
          state = merged.state
          results.push(merged.result)
        }
        persistState(this.sql, before, state, Date.now())
        responseState = state
      })
    } catch (error) {
      const quota = storageFailure(error)
      if (quota) return quota
      return json({ error: '同步事务失败，请保留本地数据后重试' }, 503)
    }
    await this.schedule()
    if (body.operations.length) this.broadcast(responseState!.seq)
    const changes = readDelta(this.sql, body.since, responseState!.seq)
    return json({
      schemaVersion: 1,
      seq: responseState!.seq,
      space: changes !== null ? null : responseState!.space,
      ...(changes !== null ? { baseSeq: body.since, changes } : {}),
      results,
      serverTime: Date.now(),
      subject: request.headers.get('X-Auth-Sub'),
    })
  }
  private broadcast(seq: number) {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as { sid: string; sub: string }
      const valid = this.sql
        .exec<{ expires_at: number }>(
          'SELECT expires_at FROM sessions WHERE sid=? AND sub=?',
          attachment.sid,
          attachment.sub,
        )
        .toArray()[0]
      try {
        if (!valid || valid.expires_at <= Date.now() / 1000) socket.close(1008, '会话已过期')
        else socket.send(JSON.stringify({ type: 'invalidate', seq }))
      } catch {
        socket.close()
      }
    }
  }
  async alarm() {
    if (this.env.MIGRATION_READ_ONLY === 'true') {
      await this.ctx.storage.setAlarm(Date.now() + 60000)
      return
    }
    let seq = 0
    this.ctx.storage.transactionSync(() => {
      const state = this.load(),
        before = clone(state),
        now = Date.now()
      state.space = maintenance(state.space, { now, id: () => crypto.randomUUID() })
      const changes = diffSpace(before.space, state.space)
      if (changes.length) {
        state.seq++
        for (const change of changes)
          if (change.field === '$map' && change.after === null)
            state.tombstones[change.mapId] = {
              seq: state.seq,
              stamp: { deviceId: 'server', deviceSeq: state.seq, at: now, uncertainty: 0 },
            }
        persistState(this.sql, before, state, now)
      }
      this.sql.exec('DELETE FROM sessions WHERE expires_at <= ?', Math.floor(now / 1000))
      seq = state.seq
    })
    await this.schedule()
    this.broadcast(seq)
  }
  async webSocketMessage(socket: WebSocket) {
    const attachment = socket.deserializeAttachment() as { sid: string; sub: string }
    const valid = this.sql
      .exec<{ expires_at: number }>(
        'SELECT expires_at FROM sessions WHERE sid=? AND sub=?',
        attachment.sid,
        attachment.sub,
      )
      .toArray()[0]
    if (!valid || valid.expires_at <= Date.now() / 1000) socket.close(1008, '会话已过期')
    else socket.send(JSON.stringify({ type: 'invalidate' }))
  }
  async webSocketClose(socket: WebSocket) {
    socket.close()
  }
}
