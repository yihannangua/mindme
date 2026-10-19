import { describe, expect, it } from 'vitest'
import { edgePath, layoutTree, measureNode } from '../../src/layout/tree'
import { makeNode, validateMap } from '../../src/domain/model'
import { first, seed } from '../helpers'
describe('顺时针平衡布局', () => {
  it('中文字、英文与组合表情完整折行并保留多行', () => {
    const node = makeNode(
        'a',
        null,
        '中文'.repeat(30) + '👨‍👩‍👧‍👦'.repeat(5) + '\n' + 'English words '.repeat(10),
      ),
      metric = measureNode(node)
    expect(metric.lines.join('')).toBe(node.text.replace(/\n/g, ''))
    expect(metric.lines.some((line) => line.includes('👨‍👩‍👧‍👦'))).toBe(true)
    expect(metric.height).toBeGreaterThan(42)
    const marked = measureNode({ ...node, markers: { flag: 'red', priority: '①' } })
    expect(marked.textLeft - metric.textLeft).toBe(44)
  })
  it('草稿实时增宽、换行增高，不修改原节点，取消后恢复原布局', () => {
    const map = first(seed())
    map.nodes.a = makeNode('a', map.rootId, '短')
    map.nodes.b = makeNode('b', map.rootId, '其他节点', 1)
    const before = layoutTree(map),
      short = before.byId.get('a')!,
      wider = layoutTree(map, { draft: { id: 'a', text: '输入中的较长文字' } }).byId.get('a')!,
      long = layoutTree(map, { draft: { id: 'a', text: '连续文字'.repeat(60) } }).byId.get('a')!
    expect(wider.width).toBeGreaterThan(short.width)
    expect(long.width).toBeLessThanOrEqual(476)
    expect(long.height).toBeGreaterThan(wider.height)
    expect(long.lines.join('')).toBe('连续文字'.repeat(60))
    expect(map.nodes.a.text).toBe('短')
    expect(layoutTree(map).byId.get('a')).toEqual(short)
  })
  it('草稿保留手动换行、末尾空行及浏览器实际高度，布局为其他节点留出空间', () => {
    const map = first(seed())
    map.nodes.a = makeNode('a', map.rootId, '短')
    map.nodes.b = makeNode('b', map.rootId, '邻居', 1)
    const layout = layoutTree(map, { draft: { id: 'a', text: '第一行\n\n第三行\n', height: 300 } }),
      a = layout.byId.get('a')!,
      b = layout.byId.get('b')!
    expect(a.lines).toEqual(['第一行', '', '第三行', ''])
    expect(a.height).toBeGreaterThanOrEqual(320)
    expect(b.y - b.height / 2).toBeGreaterThan(a.y + a.height / 2)
  })
  it('使用实际字体宽度换行，中心节点和图标文字均完整保留', () => {
    const node = makeNode('a', null, 'W'.repeat(64)),
      metric = measureNode(node, () => 14),
      marked = measureNode({ ...node, markers: { flag: 'red' } }, () => 14)
    expect(metric.lines).toEqual(['W'.repeat(31), 'W'.repeat(31), 'WW'])
    expect(measureNode({ ...node, text: 'W'.repeat(30) }, () => 14).lines).toHaveLength(1)
    expect(metric.textWidth).toBe(438)
    expect(marked.textLeft - metric.textLeft).toBe(22)
    expect(marked.width - metric.width).toBe(22)
  })
  it('紧凑风格降低节点尺寸与层级间距，经典布局保持原指标', () => {
    const map = first(seed())
    map.nodes.a = makeNode('a', map.rootId, '一个分支主题')
    map.nodes.b = makeNode('b', 'a', '子主题')
    const classic = layoutTree(map),
      compact = layoutTree(map, { style: 'compact' })
    expect(compact.byId.get('a')!.height).toBeLessThan(classic.byId.get('a')!.height)
    expect(compact.byId.get('a')!.width).toBeLessThan(classic.byId.get('a')!.width)
    expect(compact.byId.get('b')!.x - compact.byId.get('a')!.x).toBeLessThan(
      classic.byId.get('b')!.x - classic.byId.get('a')!.x,
    )
    expect(edgePath(compact.byId.get('a')!, compact.byId.get('b')!, 'compact')).toContain(' H ')
    expect(edgePath(classic.byId.get('a')!, classic.byId.get('b')!)).toContain(' C ')
  })
  it('1000 节点布局无同层重叠，折叠只影响可见性', () => {
    const map = first(seed())
    for (let i = 0; i < 10; i++) {
      const id = `b-${i}`
      map.nodes[id] = { ...makeNode(id, map.rootId, `分支 ${i}`, i), side: i < 5 ? 1 : -1 }
      for (let j = 0; j < 99; j++) {
        const child = `${id}-${j}`
        map.nodes[child] = makeNode(child, id, `节点 ${j}`, j)
      }
    }
    validateMap(map)
    const layout = layoutTree(map)
    expect(layout.nodes).toHaveLength(1001)
    const children = layout.nodes
      .filter((item) => item.node.parentId === 'b-0')
      .sort((a, b) => a.y - b.y)
    for (let i = 1; i < children.length; i++)
      expect(children[i].y - children[i].height / 2).toBeGreaterThan(
        children[i - 1].y + children[i - 1].height / 2,
      )
    map.nodes['b-0'].collapsed = true
    expect(layoutTree(map).nodes).toHaveLength(902)
    expect(Object.keys(map.nodes)).toHaveLength(1001)
  })
  it('移动保留父子关系，手动位置影响整个子分支', () => {
    const map = first(seed())
    map.nodes.a = makeNode('a', map.rootId, '分支')
    map.nodes.b = makeNode('b', 'a', '子主题')
    const before = layoutTree(map)
    map.nodes.a.position = { x: 25, y: 60 }
    const after = layoutTree(map)
    expect(after.byId.get('a')!.x - before.byId.get('a')!.x).toBe(25)
    expect(after.byId.get('b')!.y - before.byId.get('b')!.y).toBe(60)
    expect(map.nodes.b.parentId).toBe('a')
  })
})
