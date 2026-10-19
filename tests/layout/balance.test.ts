import { describe, expect, it } from 'vitest'
import { children, makeNode, createMap } from '../../src/domain/model'
import { execute } from '../../src/domain/commands'
import { diffSpace } from '../../src/domain/operations'
import { ctx, first, seed } from '../helpers'

function unbalanced() {
  const space = seed(),
    map = first(space)
  map.nodes[map.rootId].position = { x: 300, y: 200 }
  for (const [i, count] of [6, 3, 0, 0].entries()) {
    const id = `branch-${i}`
    const side = i < 2 ? 1 : -1
    map.nodes[id] = {
      ...makeNode(id, map.rootId, `分支${i}`, i),
      side,
      position: { x: 80, y: i * 40 },
    }
    for (let j = 0; j < count; j++) {
      const child = `${id}-${j}`
      map.nodes[child] = {
        ...makeNode(child, id, `主题${j}`, j),
        side,
        position: { x: 30, y: 10 },
      }
    }
  }
  map.nodes['branch-1'].markers = { flag: 'blue' }
  return space
}

describe('自动均衡布局', () => {
  it('按原顺序均衡一级分支方向，清除整图偏移且保留内容、层级和主题顺序', () => {
    const source = unbalanced(),
      before = structuredClone(first(source)),
      result = execute(source, before.id, { type: 'layout' }, ctx(2000)).space,
      map = first(result)
    expect(Object.keys(map.nodes)).toEqual(Object.keys(before.nodes))
    expect(first(source)).toEqual(before)
    expect(map.nodes['branch-0'].side).toBe(1)
    expect(map.nodes['branch-1'].side).toBe(-1)
    expect(map.nodes['branch-2'].side).toBe(-1)
    expect(map.nodes['branch-3'].side).toBe(-1)
    expect(children(map, map.rootId).map((node) => node.id)).toEqual([
      'branch-0',
      'branch-1',
      'branch-2',
      'branch-3',
    ])
    for (const [id, node] of Object.entries(map.nodes)) {
      expect(node.position).toBeNull()
      for (const field of ['text', 'parentId', 'order', 'markers', 'collapsed'] as const)
        expect(node[field]).toEqual(before.nodes[id][field])
    }
    expect(map.nodes['branch-1-0'].side).toBe(-1)
    expect(map.nodes[map.rootId].side).toBe(0)
  })
  it('折叠状态不改变，隐藏节点也清除手动偏移并保留原方向', () => {
    const source = unbalanced(),
      map = first(source)
    map.nodes['branch-0'].collapsed = true
    const after = first(execute(source, map.id, { type: 'layout' }, ctx()).space)
    expect(after.nodes['branch-0'].collapsed).toBe(true)
    expect(after.nodes['branch-1'].side).toBe(-1)
    expect(after.nodes['branch-0'].side).toBe(1)
    expect(after.nodes['branch-0-0'].position).toBeNull()
    expect(after.nodes['branch-0-0'].side).toBe(1)
  })
  it('重复布局不产生变更，也不影响其他脑图', () => {
    let source = unbalanced()
    source = createMap(source, '其他脑图', ctx())
    const map = first(source),
      other = Object.values(source.maps).find((item) => item.id !== map.id)!,
      result = execute(source, map.id, { type: 'layout' }, ctx(2000)).space
    expect(result.maps[other.id]).toEqual(other)
    result.maps[map.id].historyDirtySince = null
    const repeated = execute(result, map.id, { type: 'layout' }, ctx(3000)).space
    expect(repeated).toBe(result)
    expect(diffSpace(result, repeated)).toEqual([])
  })
  it('单个中心主题也能复位，复位后无多余变更', () => {
    const source = seed(),
      map = first(source)
    map.nodes[map.rootId].position = { x: 300, y: -100 }
    const result = execute(source, map.id, { type: 'layout' }, ctx()).space
    expect(first(result).nodes[map.rootId].position).toBeNull()
    expect(execute(result, map.id, { type: 'layout' }, ctx()).space).toBe(result)
  })
})
