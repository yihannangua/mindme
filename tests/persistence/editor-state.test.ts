import { describe, expect, it } from 'vitest'
import { EditorStateStorage } from '../../src/persistence/editor-state'

function storage() {
  const values = new Map<string, string>()
  const access = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
  }
  return { values, access, state: new EditorStateStorage(() => access) }
}

describe('本机编辑位置保存', () => {
  it('新实例可以恢复当前脑图、画布与选择，各脑图独立保存', () => {
    const { state, access } = storage()
    state.saveActiveMap('second')
    state.updateMap('first', { selectedId: 'node-a', view: { x: 100, y: -50, zoom: 0.5 } })
    state.updateMap('second', { selectedId: 'node-b', view: { x: -200, y: 80, zoom: 1.5 } })
    const restored = new EditorStateStorage(() => access)
    expect(restored.activeMap()).toBe('second')
    expect(restored.map('first')).toEqual({
      selectedId: 'node-a',
      view: { x: 100, y: -50, zoom: 0.5 },
    })
    expect(restored.map('second')).toEqual({
      selectedId: 'node-b',
      view: { x: -200, y: 80, zoom: 1.5 },
    })
  })
  it('视角与选择的独立更新不会覆盖彼此，清除选择和当前脑图可持久保存', () => {
    const { state } = storage()
    state.updateMap('a', { view: { x: 10, y: 20, zoom: 1.2 } })
    state.updateMap('a', { selectedId: 'node' })
    state.updateMap('a', { selectedId: null })
    expect(state.map('a')).toEqual({ selectedId: null, view: { x: 10, y: 20, zoom: 1.2 } })
    state.saveActiveMap('a')
    state.saveActiveMap('')
    expect(state.activeMap()).toBe('')
    expect(state.map('missing')).toEqual({})
  })
  it('损坏和未知版本偏好不影响编辑，非法视角不用于恢复', () => {
    const { state, access, values } = storage()
    for (const invalid of ['{', 'null', '[]', '{"version":2}']) {
      values.set('mindme.editor.v1.map:a', invalid)
      expect(state.map('a')).toEqual({})
    }
    for (const view of [
      { x: '10', y: 0, zoom: 1 },
      { x: null, y: 0, zoom: 1 },
      { x: 0, y: 0, zoom: 0 },
      { x: 0, y: 0, zoom: 3 },
    ]) {
      values.set('mindme.editor.v1.map:a', JSON.stringify({ version: 1, selectedId: 'node', view }))
      expect(state.map('a')).toEqual({ selectedId: 'node' })
    }
  })
  it('多选集合、当前节点和范围起点可恢复，视角更新不覆盖多选，非法集合被忽略', () => {
    const { state, access, values } = storage()
    state.updateMap('a', { selectedIds: ['one', 'two', 'one'], selectedId: 'two', anchorId: 'one' })
    state.updateMap('a', { view: { x: 10, y: 20, zoom: 1.2 } })
    expect(new EditorStateStorage(() => access).map('a')).toEqual({
      selectedIds: ['one', 'two'],
      selectedId: 'two',
      anchorId: 'one',
      view: { x: 10, y: 20, zoom: 1.2 },
    })
    values.set(
      'mindme.editor.v1.map:b',
      JSON.stringify({ version: 1, selectedId: 'legacy', selectedIds: [42], anchorId: {} }),
    )
    expect(state.map('b')).toEqual({ selectedId: 'legacy' })
  })
  it('每张脑图独立保存经典或紧凑风格，缺省和非法值回退为经典', () => {
    const { state, access, values } = storage()
    expect(state.map('a').style).toBeUndefined()
    state.updateMap('a', { style: 'compact' })
    state.updateMap('b', { style: 'classic' })
    const restored = new EditorStateStorage(() => access)
    expect(restored.map('a').style).toBe('compact')
    expect(restored.map('b').style).toBe('classic')
    values.set('mindme.editor.v1.map:c', JSON.stringify({ version: 1, style: 'unknown' }))
    expect(restored.map('c').style).toBeUndefined()
  })
  it('存储被禁用或写入失败时不阻断页面编辑', () => {
    const disabled = new EditorStateStorage(() => {
      throw new Error('存储被禁用')
    })
    expect(disabled.activeMap()).toBe('')
    expect(disabled.map('a')).toEqual({})
    expect(() => disabled.saveActiveMap('a')).not.toThrow()
    expect(() => disabled.updateMap('a', { selectedId: 'node' })).not.toThrow()
    const quota = new EditorStateStorage(() => ({
      getItem: () => null,
      setItem: () => {
        throw new Error('额度不足')
      },
    }))
    expect(() => quota.updateMap('a', { view: { x: 0, y: 0, zoom: 1 } })).not.toThrow()
  })
})
