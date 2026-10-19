import { describe, expect, it } from 'vitest'
import { execute } from '../../src/domain/commands'
import { children } from '../../src/domain/model'
import { emptySpace } from '../../src/domain/types'
import {
  errorClass,
  mergeOperation,
  newServerState,
  orderStamp,
  retryDelay,
} from '../../src/sync/protocol'
import { ctx, edit, first, operation, seed } from '../helpers'
function setup() {
  let space = seed()
  const root = first(space).rootId
  space = edit(space, { type: 'add', nodeId: root, kind: 'child' })
  const merged = mergeOperation(newServerState(), operation(emptySpace(), space), 10000)
  return {
    state: merged.state,
    space: merged.state.space,
    nodeId: children(first(space), root)[0].id,
  }
}
describe('双设备同步协议', () => {
  it('不同属性和不同标记类别分别合并', () => {
    const { state, space, nodeId } = setup()
    const a = edit(space, { type: 'text', nodeId, text: 'A的文字' }),
      b = edit(space, { type: 'marker', nodeId, category: 'flag', value: 'blue' })
    const ma = mergeOperation(state, operation(space, a, 'A', 3000, 1, 1), 10000)
    const mb = mergeOperation(ma.state, operation(space, b, 'B', 3100, 1, 1), 10000)
    expect(mb.result.status).toBe('accepted')
    expect(first(mb.state.space).nodes[nodeId]).toMatchObject({
      text: 'A的文字',
      markers: { flag: 'blue' },
    })
  })
  it('旧离线修改晚上传也不能覆盖新修改', () => {
    const { state, space, nodeId } = setup()
    const newer = edit(space, { type: 'text', nodeId, text: '较新' }),
      older = edit(space, { type: 'text', nodeId, text: '旧离线' })
    const a = mergeOperation(state, operation(space, newer, 'B', 5000, 1, 1), 10000)
    const b = mergeOperation(a.state, operation(space, older, 'A', 3000, 1, 1), 10000)
    expect(b.result.status).toBe('stale')
    expect(first(b.state.space).nodes[nodeId].text).toBe('较新')
  })
  it('时间不确定区间重叠时保留冲突，不伪造顺序', () => {
    const { state, space, nodeId } = setup()
    const a = edit(space, { type: 'text', nodeId, text: 'A' }),
      b = edit(space, { type: 'text', nodeId, text: 'B' })
    const ma = mergeOperation(state, operation(space, a, 'A', 3000, 1, 1, 1000), 10000)
    const mb = mergeOperation(ma.state, operation(space, b, 'B', 3500, 1, 1, 1000), 10000)
    expect(mb.result.status).toBe('conflict')
    expect(first(mb.state.space).nodes[nodeId].text).toBe('A')
  })
  it('重复提交幂等，重复返回相同修订号', () => {
    const { state, space, nodeId } = setup(),
      after = edit(space, { type: 'text', nodeId, text: '一次' }),
      op = operation(space, after, 'A', 3000, 1, 1)
    const a = mergeOperation(state, op, 10000),
      b = mergeOperation(a.state, op, 10000)
    expect(b.state.seq).toBe(a.state.seq)
    expect(b.result).toEqual(a.result)
  })
  it('删除优先，旧编辑和创建均不能复活已删除节点', () => {
    const { state, space, nodeId } = setup()
    const deleted = edit(space, { type: 'delete', nodeId }),
      old = edit(space, { type: 'text', nodeId, text: '离线内容' })
    const a = mergeOperation(state, operation(space, deleted, 'A', 5000, 1, 1), 10000)
    const b = mergeOperation(a.state, operation(space, old, 'B', 6000, 1, 1), 10000)
    expect(b.result.status).toBe('conflict')
    expect(first(b.state.space).nodes[nodeId]).toBeUndefined()
    const create = operation(deleted, space, 'B', 7000, 2, 1)
    expect(mergeOperation(a.state, create, 10000).result.status).toBe('conflict')
  })
  it('移入回收站后拒绝离线编辑，永久删除后防重放', () => {
    const { state, space, nodeId } = setup(),
      map = first(space),
      trash = edit(space, { type: 'trash' }, 5000)
    const a = mergeOperation(state, operation(space, trash, 'A', 5000, 1, 1), 10000)
    expect(
      mergeOperation(
        a.state,
        operation(space, edit(space, { type: 'text', nodeId, text: '旧文字' }), 'B', 6000, 1, 1),
        10000,
      ).result.status,
    ).toBe('conflict')
    const purged = execute(trash, map.id, { type: 'purge' }, ctx(6000)).space
    const b = mergeOperation(a.state, operation(trash, purged, 'A', 6000, 2, 2), 10000)
    expect(b.result.status).toBe('accepted')
    expect(
      mergeOperation(b.state, operation(emptySpace(), space, 'B', 7000, 1), 10000).result.status,
    ).toBe('conflict')
  })
  it('非法结构与部分操作失败时整批不落地', () => {
    const { state, space, nodeId } = setup(),
      after = edit(space, { type: 'text', nodeId, text: '不应提交' }),
      op = operation(space, after, 'A', 3000, 1, 1)
    op.changes.push({
      mapId: first(space).id,
      nodeId,
      field: 'parentId',
      before: first(space).rootId,
      after: nodeId,
    })
    const merged = mergeOperation(state, op, 10000)
    expect(merged.result.status).toBe('rejected')
    expect(merged.state.space).toEqual(space)
  })
  it('根据错误分类暂停或重试，并遵守退避与 Retry-After', () => {
    expect(errorClass(401)).toBe('unauthorized')
    expect(errorClass(403)).toBe('unauthorized')
    expect(errorClass(429)).toBe('retry')
    expect(errorClass(503)).toBe('retry')
    expect(errorClass(400)).toBe('attention')
    expect([0, 1, 2, 3, 4, 5, 6].map((n) => retryDelay(n))).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000,
    ])
    expect(retryDelay(1, 0.5, 60000)).toBe(60000)
  })
  it('同设备发生顺序优先，交叠区间不臆测时间', () => {
    const a = { deviceId: 'A', deviceSeq: 2, at: 1000, uncertainty: 1000 },
      b = { deviceId: 'A', deviceSeq: 1, at: 5000, uncertainty: 0 }
    expect(orderStamp(a, b)).toBe('newer')
    expect(orderStamp(a, { ...b, deviceId: 'B', at: 1000 })).toBe('unknown')
  })
})

import { EstimatedClock } from '../../src/sync/clock'
it('单调时钟估算保留 RTT 和长离线漂移，系统时钟跳变扩大不确定区间', () => {
  const clock = new EstimatedClock()
  expect(clock.read(1000, 0).uncertainty).toBe(86400000)
  clock.calibrate(10000, 1000, 1100, 200)
  expect(clock.read(1200, 300).at).toBe(10150)
  expect(clock.read(1200, 300).uncertainty).toBeGreaterThanOrEqual(55)
  expect(clock.read(3601200, 3600300).uncertainty).toBeGreaterThan(200)
  expect(clock.read(500000, 300).uncertainty).toBeGreaterThan(400000)
})
it('显式撤销删除允许恢复本机分支，普通迟到创建不能冒充撤销', () => {
  const { state, space, nodeId } = setup(),
    deleted = edit(space, { type: 'delete', nodeId })
  const deletion = operation(space, deleted, 'A', 5000, 1, 1),
    a = mergeOperation(state, deletion, 10000)
  const restore = operation(deleted, space, 'A', 6000, 2, 1)
  restore.intent = 'undo'
  const b = mergeOperation(a.state, restore, 10000)
  expect(b.result.status).toBe('accepted')
  expect(first(b.state.space).nodes[nodeId]).toBeDefined()
})
it('历史版本恢复可显式恢复已知删除的节点，旧离线编辑仍不能复活节点', () => {
  const { state, space, nodeId } = setup(),
    deleted = edit(space, { type: 'delete', nodeId })
  const a = mergeOperation(state, operation(space, deleted, 'A', 5000, 1, 1), 10000)
  const restore = operation(deleted, space, 'B', 7000, 1, a.state.seq)
  restore.intent = 'restore'
  expect(mergeOperation(a.state, restore, 10000).result.status).toBe('accepted')
})
it('拒绝原型字段和不在协议中的字段，避免恶意属性注入', () => {
  const { state, space, nodeId } = setup(),
    after = edit(space, { type: 'text', nodeId, text: '正常' })
  const op = operation(space, after, 'A', 3000, 1, 1)
  op.changes.push({
    mapId: first(space).id,
    nodeId,
    field: 'marker:__proto__',
    before: null,
    after: { compromised: true },
  })
  const result = mergeOperation(state, op, 10000)
  expect(result.result.status).toBe('rejected')
  expect(result.state.space).toEqual(space)
})
it('新历史版本以单条 history-add 合并，旧 history 全量格式仍兼容', () => {
  const { state, space } = setup(),
    map = first(space),
    next = structuredClone(space),
    content = {
      id: map.id,
      title: map.title,
      rootId: map.rootId,
      nodes: map.nodes,
      deletedAt: null,
    },
    version = {
      schemaVersion: 1 as const,
      id: 'version-add',
      at: 3000,
      reason: 'window' as const,
      content,
    }
  next.maps[map.id].history = [version]
  const changes = [{ mapId: map.id, field: 'history-add', before: null, after: version }]
  const op = operation(space, next, 'A', 3000, 1, 0)
  op.changes = changes
  const result = mergeOperation(state, op, 10000)
  expect(result.result.status).toBe('accepted')
  expect(first(result.state.space).history).toEqual([version])
})
it('两台设备为同一内容生成历史时合并重复内容', () => {
  const { state, space } = setup(),
    map = first(space),
    a = structuredClone(space),
    b = structuredClone(space)
  const content = {
    id: map.id,
    title: map.title,
    rootId: map.rootId,
    nodes: map.nodes,
    deletedAt: null,
  }
  a.maps[map.id].history = [
    { schemaVersion: 1, id: 'version-a', at: 3000, reason: 'window', content },
  ]
  b.maps[map.id].history = [
    { schemaVersion: 1, id: 'version-b', at: 3100, reason: 'window', content },
  ]
  const firstResult = mergeOperation(state, operation(space, a, 'A', 3000, 1, 1), 10000)
  const secondResult = mergeOperation(
    firstResult.state,
    operation(space, b, 'B', 3100, 1, 1),
    10000,
  )
  expect(secondResult.result.status).toBe('accepted')
  expect(
    new Set(
      first(secondResult.state.space).history.map((version) => JSON.stringify(version.content)),
    ).size,
  ).toBe(1)
})
