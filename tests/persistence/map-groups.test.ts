import { describe, expect, it } from 'vitest'
import { groupIdForMap, MapGroupStorage } from '../../src/persistence/map-groups'

const backend = (initial: string | null = null) => {
  const values = new Map<string, string>()
  if (initial !== null) values.set('mindme.map-groups.v1', initial)
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    values,
  }
}

describe('脑图分组本机偏好', () => {
  it('新建、重命名、折叠和移动分组，重新加载后保留', () => {
    const storage = backend()
    const store = new MapGroupStorage(() => storage)
    let state = store.load()
    expect(state).toEqual({ version: 1, groups: [], assignments: {} })

    state = store.create(state, ' 工作 ')
    expect(state.groups[0].name).toBe('工作')
    const id = state.groups[0].id
    expect(() => store.create(state, '工作')).toThrow('分组名称已存在')
    expect(() => store.create(state, '   ')).toThrow('分组名称不能为空')

    state = store.rename(state, id, '项目')
    expect(state.groups[0].name).toBe('项目')
    state = store.toggle(state, id)
    expect(state.groups[0].collapsed).toBe(true)
    state = store.assign(state, 'map-1', id)
    expect(groupIdForMap(state, 'map-1')).toBe(id)
    store.save(state)

    const restored = new MapGroupStorage(() => storage).load()
    expect(restored.groups[0].name).toBe('项目')
    expect(restored.groups[0].collapsed).toBe(true)
    expect(groupIdForMap(restored, 'map-1')).toBe(id)
  })

  it('损坏数据回退为空，未知分组归入未分组', () => {
    expect(new MapGroupStorage(() => backend('{bad')).load()).toEqual({
      version: 1,
      groups: [],
      assignments: {},
    })
    const storage = backend(
      JSON.stringify({
        version: 1,
        groups: [{ id: 'group-a', name: '组', order: 0, collapsed: false }],
        assignments: { 'map-1': 'missing', 'map-2': 'group-a' },
      }),
    )
    const state = new MapGroupStorage(() => storage).load()
    expect(state.assignments).toEqual({ 'map-2': 'group-a' })
    expect(groupIdForMap(state, 'map-1')).toBeNull()
    expect(groupIdForMap(state, 'map-2')).toBe('group-a')
  })

  it('存储不可用时仍可在当前页面操作', () => {
    const store = new MapGroupStorage(() => ({
      getItem: () => {
        throw new Error('存储被禁用')
      },
      setItem: () => {
        throw new Error('存储额度不足')
      },
    }))
    let state = store.load()
    state = store.create(state, '离线')
    state = store.save(state)
    expect(state.groups[0].name).toBe('离线')
  })
})
