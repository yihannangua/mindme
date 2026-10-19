import { describe, expect, it } from 'vitest'
import {
  pointerSelection,
  restoreSelection,
  retainSelection,
  singleSelection,
} from '../../src/editor/selection'

const order = ['root', 'a', 'child', 'b', 'c']
describe('节点多选', () => {
  it('Shift 选中两端及中间可见节点，正反方向均可', () => {
    expect(pointerSelection(singleSelection('a'), 'c', 'range', order)).toEqual({
      ids: ['a', 'child', 'b', 'c'],
      activeId: 'c',
      anchorId: 'a',
    })
    expect(pointerSelection(singleSelection('c'), 'a', 'range', order)).toEqual({
      ids: ['a', 'child', 'b', 'c'],
      activeId: 'a',
      anchorId: 'c',
    })
  })
  it('连续 Shift 调整终点时起点不变，可以缩小范围', () => {
    const all = pointerSelection(singleSelection('a'), 'c', 'range', order)
    expect(pointerSelection(all, 'child', 'range', order)).toEqual({
      ids: ['a', 'child'],
      activeId: 'child',
      anchorId: 'a',
    })
    expect(pointerSelection(all, 'a', 'range', order)).toEqual(singleSelection('a'))
  })
  it('无起点或起点已折叠隐藏时选择点击节点，范围跳过隐藏节点', () => {
    expect(pointerSelection(singleSelection(null), 'b', 'range', order)).toEqual(
      singleSelection('b'),
    )
    expect(pointerSelection(singleSelection('hidden'), 'b', 'range', order)).toEqual(
      singleSelection('b'),
    )
    expect(pointerSelection(singleSelection('a'), 'b', 'range', ['root', 'a', 'b'])).toEqual({
      ids: ['a', 'b'],
      activeId: 'b',
      anchorId: 'a',
    })
  })
  it('Alt 逐个加入不重复，移除当前节点会保留其他选择，最后一个可取消', () => {
    const a = singleSelection('a'),
      both = pointerSelection(a, 'c', 'toggle', order)
    expect(both).toEqual({ ids: ['a', 'c'], activeId: 'c', anchorId: 'c' })
    expect(pointerSelection(both, 'c', 'toggle', order)).toEqual(a)
    const onlyC = pointerSelection(both, 'a', 'toggle', order)
    expect(onlyC).toEqual(singleSelection('c'))
    expect(pointerSelection(onlyC, 'c', 'toggle', order)).toEqual(singleSelection(null))
    expect(a).toEqual(singleSelection('a'))
  })
  it('普通点击清除多选，Alt 点击建立新的 Shift 起点', () => {
    const selection = pointerSelection(singleSelection('a'), 'c', 'toggle', order)
    expect(pointerSelection(selection, 'b', 'single', order)).toEqual(singleSelection('b'))
    expect(pointerSelection(selection, 'b', 'range', order)).toEqual({
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
    const selection = pointerSelection(singleSelection('a'), 'c', 'toggle', order)
    expect(retainSelection(selection, new Set(order))).toBe(selection)
    expect(retainSelection(selection, new Set(['a']))).toEqual(singleSelection('a'))
    expect(retainSelection(selection, new Set())).toEqual(singleSelection(null))
  })
})
