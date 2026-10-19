import { describe, expect, it } from 'vitest'
import { makeNode, children, createMap } from '../../src/domain/model'
import { execute } from '../../src/domain/commands'
import { selectedForest } from '../../src/domain/branches'
import { diffSpace } from '../../src/domain/operations'
import { mergeOperation, newServerState } from '../../src/sync/protocol'
import { ctx, first, seed, operation } from '../helpers'

function fixture() {
  const space = seed(),
    map = first(space)
  for (const [i, id] of ['a', 'b', 'target'].entries())
    map.nodes[id] = {
      ...makeNode(id, map.rootId, id, i),
      side: id === 'target' ? -1 : 1,
      position: { x: 20, y: 10 },
    }
  map.nodes.child = { ...makeNode('child', 'a', '后代'), side: 1, markers: { flag: 'blue' } }
  map.nodes.grandchild = { ...makeNode('grandchild', 'child', '孙节点'), side: 1 }
  map.nodes.existing = { ...makeNode('existing', 'target', '既有孩子', 10), side: -1 }
  return space
}

describe('多选分支批量挂接', () => {
  it('多选删除只删除最外层分支并保护中心主题', () => {
    const source = fixture(),
      map = first(source)
    const result = execute(
      source,
      map.id,
      { type: 'delete-many', nodeIds: ['child', 'a', 'b'] },
      ctx(),
    )
    expect(Object.keys(first(result.space).nodes)).toEqual([map.rootId, 'target', 'existing'])
    expect(result.selectedId).toBe(map.rootId)
    expect(() =>
      execute(source, map.id, { type: 'delete-many', nodeIds: [map.rootId, 'a'] }, ctx()),
    ).toThrow('中心主题')
  })
  it('外层分支按树顺序追加至目标，保留完整后代、文字与标记及目标折叠', () => {
    const source = fixture(),
      map = first(source),
      before = structuredClone(source)
    map.nodes.target.collapsed = true
    const next = first(
      execute(
        source,
        map.id,
        { type: 'reparent-many', nodeIds: ['b', 'a', 'b'], parentId: 'target' },
        ctx(),
      ).space,
    )
    expect(children(next, 'target').map((node) => node.id)).toEqual(['existing', 'a', 'b'])
    expect(next.nodes.target.collapsed).toBe(true)
    for (const id of ['a', 'b']) expect(next.nodes[id].position).toBeNull()
    for (const id of ['a', 'b', 'child', 'grandchild']) expect(next.nodes[id].side).toBe(-1)
    expect(next.nodes.child.parentId).toBe('a')
    expect(next.nodes.grandchild.parentId).toBe('child')
    expect(next.nodes.child.markers).toEqual(before.maps[map.id].nodes.child.markers)
    expect(source.maps[map.id].nodes.a.parentId).toBe(map.rootId)
  })
  it.each([
    ['single', true],
    ['single', false],
    ['many', true],
    ['many', false],
  ] as const)('挂接 %s 保持目标折叠状态 %s，差异不包含折叠写入', (mode, collapsed) => {
    const source = fixture(),
      map = first(source)
    map.nodes.target.collapsed = collapsed
    map.nodes.child.collapsed = true
    const before = structuredClone(source),
      command =
        mode === 'single'
          ? { type: 'reparent' as const, nodeId: 'a', parentId: 'target' }
          : { type: 'reparent-many' as const, nodeIds: ['a', 'b'], parentId: 'target' },
      after = execute(source, map.id, command, ctx()).space
    expect(after.maps[map.id].nodes.target).toEqual(map.nodes.target)
    expect(after.maps[map.id].nodes.a.parentId).toBe('target')
    expect(after.maps[map.id].nodes.child.collapsed).toBe(true)
    expect(after.maps[map.id].nodes.grandchild.parentId).toBe('child')
    expect(diffSpace(source, after).some((change) => change.field === 'collapsed')).toBe(false)
    expect(source).toEqual(before)
  })
  it('父子同时选中只挂接最外层分支，范围不重复且不拆散层级', () => {
    const source = fixture(),
      map = first(source)
    expect(selectedForest(map, ['child', 'a', 'b']).roots).toEqual(['a', 'b'])
    expect([...selectedForest(map, ['child', 'a', 'b']).ids].sort()).toEqual([
      'a',
      'b',
      'child',
      'grandchild',
    ])
    const next = first(
      execute(
        source,
        map.id,
        { type: 'reparent-many', nodeIds: ['child', 'a', 'b'], parentId: 'target' },
        ctx(),
      ).space,
    )
    expect(next.nodes.child.parentId).toBe('a')
    expect(next.nodes.a.parentId).toBe('target')
    expect(next.nodes.b.parentId).toBe('target')
  })
  it.each(['a', 'b', 'child', 'grandchild'])(
    '拒绝挂接到所选分支或后代 %s，整批不改原数据',
    (parentId) => {
      const source = fixture(),
        before = structuredClone(source)
      expect(() =>
        execute(
          source,
          first(source).id,
          { type: 'reparent-many', nodeIds: ['a', 'b'], parentId },
          ctx(),
        ),
      ).toThrow('后代')
      expect(source).toEqual(before)
    },
  )
  it('中心主题、失效节点、空选择和失效目标全部拒绝', () => {
    const source = fixture(),
      map = first(source),
      before = structuredClone(source)
    for (const nodeIds of [[map.rootId, 'a'], ['a', 'missing'], []])
      expect(() =>
        execute(source, map.id, { type: 'reparent-many', nodeIds, parentId: 'target' }, ctx()),
      ).toThrow()
    expect(() =>
      execute(
        source,
        map.id,
        { type: 'reparent-many', nodeIds: ['a', 'b'], parentId: 'missing' },
        ctx(),
      ),
    ).toThrow('目标')
    expect(source).toEqual(before)
  })
  it('同父分支重新挂接时顺序唯一，可挂到中心主题，其他脑图不受影响', () => {
    let source = fixture()
    const map = first(source)
    source = createMap(source, '其他脑图', ctx())
    const next = execute(
      source,
      map.id,
      { type: 'reparent-many', nodeIds: ['b', 'a'], parentId: map.rootId },
      ctx(),
    ).space
    expect(children(next.maps[map.id], map.rootId).map((node) => node.id)).toEqual([
      'target',
      'a',
      'b',
    ])
    expect(new Set(children(next.maps[map.id], map.rootId).map((node) => node.order)).size).toBe(3)
    const other = Object.keys(source.maps).find((id) => id !== map.id)!
    expect(next.maps[other]).toEqual(source.maps[other])
  })
  it('深度限制失败时整批回滚，不能只搬动一部分', () => {
    const source = fixture(),
      map = first(source)
    let parent = 'target'
    for (let i = 0; i < 126; i++) {
      const id = `deep-${i}`
      map.nodes[id] = makeNode(id, parent, id)
      parent = id
    }
    const before = structuredClone(source)
    expect(() =>
      execute(
        source,
        map.id,
        { type: 'reparent-many', nodeIds: ['a', 'b'], parentId: parent },
        ctx(),
      ),
    ).toThrow('128')
    expect(source).toEqual(before)
  })
  it('通过现有字段差异一次同步所有挂接，重试保持幂等', () => {
    const source = fixture(),
      map = first(source),
      next = execute(
        source,
        map.id,
        { type: 'reparent-many', nodeIds: ['a', 'b'], parentId: 'target' },
        ctx(),
      ).space
    const server = newServerState()
    server.space = structuredClone(source)
    const op = operation(source, next, 'batch-device', 2000),
      result = mergeOperation(server, op, 2001)
    expect(result.state.space.maps[map.id].nodes.a.parentId).toBe('target')
    expect(result.state.space.maps[map.id].nodes.b.parentId).toBe('target')
    expect(result.state.space.maps[map.id].nodes.child.parentId).toBe('a')
    expect(
      diffSpace(result.state.space, mergeOperation(result.state, op, 2002).state.space),
    ).toEqual([])
  })
})
