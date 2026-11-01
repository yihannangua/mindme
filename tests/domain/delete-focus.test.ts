import { describe, expect, it } from 'vitest'
import { execute } from '../../src/domain/commands'
import { makeNode } from '../../src/domain/model'
import { ctx, first, seed } from '../helpers'

function fixture() {
  const space = seed(),
    map = first(space)
  for (const [order, id] of ['a', 'b', 'c', 'd'].entries())
    map.nodes[id] = { ...makeNode(id, map.rootId, id, order * 2), side: order < 2 ? 1 : -1 }
  map.nodes.child = makeNode('child', 'b', 'child')
  map.nodes.grandchild = makeNode('grandchild', 'child', 'grandchild')
  return space
}

describe('删除节点后的焦点', () => {
  it.each([
    ['a', 'b'],
    ['b', 'c'],
    ['c', 'd'],
    ['d', 'c'],
    ['child', 'b'],
  ])('删除 %s 后选中 %s，不保留已删除的后代', (id, selected) => {
    const space = fixture(),
      map = first(space),
      result = execute(space, map.id, { type: 'delete', nodeId: id }, ctx())
    expect(result.selectedId).toBe(selected)
    expect(result.space.maps[map.id].nodes[id]).toBeUndefined()
    expect(result.space.maps[map.id].nodes[selected]).toBeDefined()
    if (id === 'b') {
      expect(result.space.maps[map.id].nodes.child).toBeUndefined()
      expect(result.space.maps[map.id].nodes.grandchild).toBeUndefined()
      expect(map.nodes.child).toBeDefined()
    }
  })
  it('删除唯一同级节点时选择父节点，保护中心主题', () => {
    const space = seed(),
      map = first(space)
    map.nodes.only = makeNode('only', map.rootId, '唯一主题')
    expect(execute(space, map.id, { type: 'delete', nodeId: 'only' }, ctx()).selectedId).toBe(
      map.rootId,
    )
    expect(() => execute(space, map.id, { type: 'delete', nodeId: map.rootId }, ctx())).toThrow(
      '中心主题',
    )
  })
  it('跨父节点批量删除时不选中已删除的后代，按首个分支选择同级', () => {
    const space = fixture(),
      map = first(space)
    map.nodes.first = makeNode('first', 'a', 'first', 0)
    map.nodes.next = makeNode('next', 'a', 'next', 1)
    map.nodes.other = makeNode('other', 'd', 'other', 0)
    const result = execute(
      space,
      map.id,
      { type: 'delete-many', nodeIds: ['other', 'first'] },
      ctx(),
    )
    expect(result.selectedId).toBe('next')
    expect(result.space.maps[map.id].nodes.first).toBeUndefined()
    expect(result.space.maps[map.id].nodes.other).toBeUndefined()
  })
  it.each([
    [['a', 'b'], 'c'],
    [['a', 'c'], 'b'],
    [['c', 'd'], 'b'],
    [['a', 'b', 'c', 'd'], 'root'],
    [['child', 'b', 'c'], 'd'],
  ])('批量删除 %j 后选择未删除的同级或父节点', (ids, expected) => {
    const space = fixture(),
      map = first(space),
      result = execute(space, map.id, { type: 'delete-many', nodeIds: ids }, ctx())
    expect(result.selectedId).toBe(expected === 'root' ? map.rootId : expected)
    expect(result.space.maps[map.id].nodes[result.selectedId!]).toBeDefined()
  })
})
