import { describe, expect, it } from 'vitest'
import { nextDirectionalNode, type Direction } from '../../src/editor/navigation'
import { layoutTree, type LayoutNode, type TreeLayout } from '../../src/layout/tree'
import { makeNode } from '../../src/domain/model'
import { first, seed } from '../helpers'

function points(coordinates: [string, number, number][]): TreeLayout {
  const nodes: LayoutNode[] = coordinates.map(([id, x, y]) => ({
    node: makeNode(id, null, id),
    x,
    y,
    width: 80,
    height: 42,
    textLeft: 16,
    textWidth: 48,
    lines: [id],
    side: 0,
    color: '#000',
  }))
  return {
    nodes,
    byId: new Map(nodes.map((node) => [node.node.id, node])),
    width: 500,
    height: 500,
  }
}

describe('方向键节点导航', () => {
  const layout = points([
    ['current', 0, 0],
    ['left', -100, 0],
    ['right', 100, 0],
    ['up', 0, -100],
    ['down', 0, 100],
  ])
  it('没有当前节点、单节点或方向边界时不选择其他节点', () => {
    expect(nextDirectionalNode(layout, 'missing', 'up')).toBeUndefined()
    expect(nextDirectionalNode(points([['only', 0, 0]]), 'only', 'right')).toBeUndefined()
    expect(nextDirectionalNode(layout, 'right', 'right')).toBeUndefined()
    expect(nextDirectionalNode(layout, 'down', 'down')).toBeUndefined()
  })
  it('左右键只在树的父子关系中切换，不按几何距离跳到其他节点', () => {
    const map = first(seed())
    map.nodes.parent = { ...makeNode('parent', map.rootId, '父节点'), side: 1 }
    map.nodes.child = { ...makeNode('child', 'parent', '子节点'), side: 1 }
    map.nodes.other = { ...makeNode('other', map.rootId, '其他分支', 1), side: 1 }
    const layout = layoutTree(map)
    expect(nextDirectionalNode(layout, map.rootId, 'right')?.node.id).toBe('parent')
    expect(nextDirectionalNode(layout, 'parent', 'right')?.node.id).toBe('child')
    expect(nextDirectionalNode(layout, 'child', 'left')?.node.id).toBe('parent')
    expect(nextDirectionalNode(layout, 'parent', 'left')?.node.id).toBe(map.rootId)
    expect(nextDirectionalNode(layout, 'child', 'right')).toBeUndefined()
  })
  it('左右分支、父子和折叠状态使用实际布局，导航不修改脑图', () => {
    const map = first(seed())
    map.nodes.r = { ...makeNode('r', map.rootId, '右侧'), side: 1 }
    map.nodes.l = { ...makeNode('l', map.rootId, '左侧'), side: -1 }
    map.nodes.child = makeNode('child', 'r', '子级')
    let layout = layoutTree(map)
    const before = JSON.stringify(map)
    expect(nextDirectionalNode(layout, map.rootId, 'right')?.node.id).toBe('r')
    expect(nextDirectionalNode(layout, map.rootId, 'left')?.node.id).toBe('l')
    expect(nextDirectionalNode(layout, 'r', 'left')?.node.id).toBe(map.rootId)
    expect(nextDirectionalNode(layout, 'l', 'right')?.node.id).toBe(map.rootId)
    expect(nextDirectionalNode(layout, 'r', 'right')?.node.id).toBe('child')
    expect(JSON.stringify(map)).toBe(before)
    map.nodes.r.collapsed = true
    layout = layoutTree(map)
    expect(nextDirectionalNode(layout, 'r', 'right')).toBeUndefined()
    expect(nextDirectionalNode(layout, 'child', 'left')).toBeUndefined()
  })
  it('同层文字宽度不同不造成左右误跳，父节点仍可按朝内方向选中', () => {
    const map = first(seed())
    map.nodes.a = { ...makeNode('a', map.rootId, '较长的节点文字', 0), side: 1 }
    map.nodes.b = { ...makeNode('b', map.rootId, '短', 1), side: 1 }
    const layout = layoutTree(map)
    expect(nextDirectionalNode(layout, 'a', 'left')?.node.id).toBe(map.rootId)
    expect(nextDirectionalNode(layout, 'b', 'right')).toBeUndefined()
    expect(nextDirectionalNode(layout, 'a', 'down')?.node.id).toBe('b')
  })
  it('同级节点有横向偏移时，上下键仍按同级纵向顺序切换', () => {
    const map = first(seed()),
      parent = makeNode('parent', map.rootId, '父节点'),
      current = makeNode('current', parent.id, '当前', 0),
      next = makeNode('next', parent.id, '下一个', 1)
    const layout = points([
      [map.rootId, 0, 0],
      [parent.id, 0, 0],
      [current.id, 0, 0],
      [next.id, 180, 24],
    ])
    layout.byId.get(parent.id)!.node = parent
    layout.byId.get(current.id)!.node = current
    layout.byId.get(next.id)!.node = next
    expect(nextDirectionalNode(layout, current.id, 'down')?.node.id).toBe(next.id)
    expect(nextDirectionalNode(layout, next.id, 'up')?.node.id).toBe(current.id)
  })
  it('上下键不会从当前侧跳到另一侧的同级节点', () => {
    const map = first(seed()),
      right = { ...makeNode('right', map.rootId, '右侧'), side: 1 as const },
      left = { ...makeNode('left', map.rootId, '左侧'), side: -1 as const }
    const layout = layoutTree({ ...map, nodes: { ...map.nodes, right, left } })
    expect(nextDirectionalNode(layout, right.id, 'up')).toBeUndefined()
    expect(nextDirectionalNode(layout, left.id, 'down')).toBeUndefined()
  })
  it('当前节点没有同级兄弟时，切换到父节点同侧兄弟的直接子节点', () => {
    const map = first(seed())
    map.nodes.parentA = { ...makeNode('parentA', map.rootId, '父节点甲', 0), side: 1 }
    map.nodes.parentB = { ...makeNode('parentB', map.rootId, '父节点乙', 1), side: 1 }
    map.nodes.parentC = { ...makeNode('parentC', map.rootId, '父节点丙', 2), side: 1 }
    map.nodes.childA = { ...makeNode('childA', 'parentA', '甲的孩子'), side: 1 }
    map.nodes.childC = { ...makeNode('childC', 'parentC', '丙的孩子'), side: 1 }
    const layout = layoutTree(map)
    expect(nextDirectionalNode(layout, 'childA', 'down')?.node.id).toBe('childC')
    expect(nextDirectionalNode(layout, 'childC', 'up')?.node.id).toBe('childA')
  })
  it.each([1, -1] as const)('侧向 %s 连续跳过空分支和折叠分支，双向切换且边界保持', (side) => {
    const map = first(seed())
    for (let i = 0; i < 5; i++)
      map.nodes[`p${i}`] = { ...makeNode(`p${i}`, map.rootId, `父主题${i}`, i), side }
    map.nodes.p2.collapsed = true
    for (const i of [0, 2, 4])
      map.nodes[`c${i}`] = { ...makeNode(`c${i}`, `p${i}`, `孩子${i}`), side }
    const before = structuredClone(map),
      layout = layoutTree(map)
    const down = side === 1 ? 'c4' : 'c0',
      up = side === 1 ? 'c0' : 'c4'
    expect(nextDirectionalNode(layout, up, 'down')?.node.id).toBe(down)
    expect(nextDirectionalNode(layout, down, 'up')?.node.id).toBe(up)
    expect(nextDirectionalNode(layout, up, 'up')).toBeUndefined()
    expect(nextDirectionalNode(layout, down, 'down')).toBeUndefined()
    expect(layout.byId.has('c2')).toBe(false)
    expect(map).toEqual(before)
  })
  it('可以导航到屏幕外手动移动的节点', () => {
    const map = first(seed())
    map.nodes.far = { ...makeNode('far', map.rootId, '远端'), position: { x: 3000, y: 0 }, side: 1 }
    const layout = layoutTree(map)
    expect(nextDirectionalNode(layout, map.rootId, 'right')?.node.id).toBe('far')
  })
})
