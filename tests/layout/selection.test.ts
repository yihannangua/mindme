import { describe, expect, it } from 'vitest'
import {
  pointerSelection,
  restoreSelection,
  retainSelection,
  singleSelection,
} from '../../src/editor/selection'

const order = ['root', 'a', 'child', 'b', 'c']
const parents = { root: null, a: 'root', child: 'a', b: 'root', c: 'root' }
describe('节点多选', () => {
  it('同级范围跳过子节点，跨父级时只选择目标', () => {
    expect(pointerSelection(singleSelection('a'), 'c', 'range', order, parents)).toEqual({
      ids: ['a', 'b', 'c'],
      activeId: 'c',
      anchorId: 'a',
    })
    expect(pointerSelection(singleSelection('c'), 'a', 'range', order, parents).ids).toEqual([
      'a',
      'b',
      'c',
    ])
    expect(pointerSelection(singleSelection('a'), 'child', 'range', order, parents)).toEqual(
      singleSelection('child'),
    )
  })
  it('Shift 选中两端及中间同级节点，正反方向均可', () => {
    expect(pointerSelection(singleSelection('a'), 'c', 'range', order, parents)).toEqual({
      ids: ['a', 'b', 'c'],
      activeId: 'c',
      anchorId: 'a',
    })
    expect(pointerSelection(singleSelection('c'), 'a', 'range', order, parents)).toEqual({
      ids: ['a', 'b', 'c'],
      activeId: 'a',
      anchorId: 'c',
    })
  })
  it('连续 Shift 调整终点时起点不变，可以缩小范围', () => {
    const all = pointerSelection(singleSelection('a'), 'c', 'range', order, parents)
    expect(pointerSelection(all, 'b', 'range', order, parents)).toEqual({
      ids: ['a', 'b'],
      activeId: 'b',
      anchorId: 'a',
    })
    expect(pointerSelection(all, 'a', 'range', order, parents)).toEqual(singleSelection('a'))
  })
  it('无起点或起点已折叠隐藏时选择点击节点，范围跳过隐藏节点', () => {
    expect(pointerSelection(singleSelection(null), 'b', 'range', order, parents)).toEqual(
      singleSelection('b'),
    )
    expect(pointerSelection(singleSelection('hidden'), 'b', 'range', order, parents)).toEqual(
      singleSelection('b'),
    )
    expect(
      pointerSelection(singleSelection('a'), 'b', 'range', ['root', 'a', 'b'], parents),
    ).toEqual({
      ids: ['a', 'b'],
      activeId: 'b',
      anchorId: 'a',
    })
  })
  it('Alt 逐个加入不重复，移除当前节点会保留其他选择，最后一个可取消', () => {
    const a = singleSelection('a'),
      both = pointerSelection(a, 'c', 'toggle', order, parents)
    expect(both).toEqual({ ids: ['a', 'c'], activeId: 'c', anchorId: 'c' })
    expect(pointerSelection(both, 'c', 'toggle', order, parents)).toEqual(a)
    const onlyC = pointerSelection(both, 'a', 'toggle', order, parents)
    expect(onlyC).toEqual(singleSelection('c'))
    expect(pointerSelection(onlyC, 'c', 'toggle', order, parents)).toEqual(singleSelection(null))
    expect(a).toEqual(singleSelection('a'))
  })
  it('普通点击清除多选，Alt 点击建立新的 Shift 起点', () => {
    const selection = pointerSelection(singleSelection('a'), 'c', 'toggle', order, parents)
    expect(pointerSelection(selection, 'b', 'single', order, parents)).toEqual(singleSelection('b'))
    expect(pointerSelection(selection, 'b', 'range', order, parents)).toEqual({
      ids: ['b', 'c'],
      activeId: 'b',
      anchorId: 'c',
    })
  })
  it('恢复兼容旧单选偏好，多选去重并修正失效的当前节点和起点', () => {
    expect(restoreSelection({ selectedId: 'a' })).toEqual(singleSelection('a'))
    expect(
      restoreSelection({
        selectedIds: ['a', 'a', 'b'],
        selectedId: 'missing',
        anchorId: 'missing',
      }),
    ).toEqual({ ids: ['a', 'b'], activeId: 'b', anchorId: 'b' })
    expect(restoreSelection({ selectedIds: [], selectedId: 'a' })).toEqual(singleSelection(null))
  })
  it('节点被删除后保留仍存在的选择并修正当前节点，选择不变时复用对象', () => {
    const selection = pointerSelection(singleSelection('a'), 'c', 'toggle', order, parents)
    expect(retainSelection(selection, new Set(order))).toBe(selection)
    expect(retainSelection(selection, new Set(['a']))).toEqual(singleSelection('a'))
    expect(retainSelection(selection, new Set())).toEqual(singleSelection(null))
  })
})
