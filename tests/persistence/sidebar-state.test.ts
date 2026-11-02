import { describe, expect, it } from 'vitest'
import { SidebarStateStorage } from '../../src/persistence/sidebar-state'

function storage() {
  const values = new Map<string, string>()
  const access = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
  }
  return { values, access, state: new SidebarStateStorage(() => access) }
}

describe('侧栏本机显示偏好', () => {
  it('首次使用两侧默认展开，四种状态都可由新实例独立恢复', () => {
    const { state, access, values } = storage()
    values.set('mindme.editor.v1.activeMap', 'existing-map')
    expect(state.load()).toEqual({ left: true, right: true })
    for (const left of [true, false]) {
      for (const right of [true, false]) {
        state.save({ left, right })
        expect(new SidebarStateStorage(() => access).load()).toEqual({ left, right })
      }
    }
    expect(values.get('mindme.editor.v1.activeMap')).toBe('existing-map')
    expect([...values.keys()]).toEqual(['mindme.editor.v1.activeMap', 'mindme.sidebar.v1'])
  })

  it('损坏或未知版本回退默认值，单侧字段非法时不影响另一侧', () => {
    const { state, values } = storage()
    for (const invalid of ['{', 'null', '[]', '{"version":2,"left":false,"right":false}']) {
      values.set('mindme.sidebar.v1', invalid)
      expect(state.load()).toEqual({ left: true, right: true })
    }
    values.set('mindme.sidebar.v1', JSON.stringify({ version: 1, left: false, right: 'false' }))
    expect(state.load()).toEqual({ left: false, right: true })
    values.set('mindme.sidebar.v1', JSON.stringify({ version: 1, left: null, right: false }))
    expect(state.load()).toEqual({ left: true, right: false })
  })

  it('存储读取或写入失败时回退默认值且不抛出异常', () => {
    const disabled = new SidebarStateStorage(() => {
      throw new Error('存储被禁用')
    })
    expect(disabled.load()).toEqual({ left: true, right: true })
    expect(() => disabled.save({ left: false, right: false })).not.toThrow()
    const quota = new SidebarStateStorage(() => ({
      getItem: () => '{"version":1,"left":false,"right":true}',
      setItem: () => {
        throw new Error('存储额度不足')
      },
    }))
    expect(quota.load()).toEqual({ left: false, right: true })
    expect(() => quota.save({ left: true, right: false })).not.toThrow()
  })
})
