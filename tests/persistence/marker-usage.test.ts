import { describe, expect, it } from 'vitest'
import {
  frequentMarkers,
  MarkerUsageStorage,
  markerLabel,
} from '../../src/persistence/marker-usage'

function storage(value?: string) {
  const values = new Map<string, string>()
  if (value) values.set('mindme.marker-usage.v1', value)
  const access = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
  }
  return { values, access, state: new MarkerUsageStorage(() => access) }
}

describe('常用图标本机偏好', () => {
  it('按使用次数排序，同次数按最近使用排序，最多五个且不丢弃低频历史', () => {
    const { state, access } = storage()
    for (const value of ['red', 'orange', 'blue', 'green', 'purple', 'teal', 'gray'])
      state.record('flag', value)
    state.record('flag', 'red')
    const all = state.record('priority', '①')
    expect(frequentMarkers(all).map((item) => item.value)).toEqual([
      'red',
      '①',
      'gray',
      'teal',
      'purple',
    ])
    expect(all).toHaveLength(8)
    expect(all.find((item) => item.value === 'red')?.count).toBe(2)
    const restored = new MarkerUsageStorage(() => access)
    expect(frequentMarkers(restored.load())).toEqual(frequentMarkers(all))
    expect(frequentMarkers(restored.record('flag', 'orange')).map((item) => item.value)).toEqual([
      'orange',
      'red',
      '①',
      'gray',
      'teal',
    ])
  })
  it('忽略非法、重复图标、未知版本和损坏数据', () => {
    const valid = { category: 'flag', value: 'blue', count: 2, lastUsed: 3 }
    const { state } = storage(
      JSON.stringify({
        version: 1,
        entries: [
          valid,
          { ...valid, count: 7 },
          null,
          {},
          { ...valid, value: 'unknown' },
          { ...valid, category: '__proto__' },
          { ...valid, value: 'red', count: -1 },
          { ...valid, value: 'green', lastUsed: null },
        ],
      }),
    )
    expect(state.load()).toEqual([valid])
    expect(state.record('flag', 'unknown')).toEqual([valid])
    for (const value of ['broken', '{"version":2,"entries":[]}', '{"version":1,"entries":null}'])
      expect(storage(value).state.load()).toEqual([])
  })
  it('读取或写入失败时仍能在当前页面累计次数，旧存储不会覆盖内存中的新统计', () => {
    const unavailable = new MarkerUsageStorage(() => {
      throw Error('存储被禁用')
    })
    unavailable.record('flag', 'blue')
    expect(unavailable.record('flag', 'blue')[0].count).toBe(2)
    const original = JSON.stringify({
      version: 1,
      entries: [{ category: 'priority', value: '①', count: 2, lastUsed: 2 }],
    })
    const quota = new MarkerUsageStorage(() => ({
      getItem: () => original,
      setItem: () => {
        throw Error('额度不足')
      },
    }))
    quota.record('priority', '①')
    expect(quota.record('priority', '①')[0].count).toBe(4)
  })
  it('进度标签与右侧图标一致', () => {
    expect(markerLabel('progress', 'start')).toBe('进度 0/8')
    expect(markerLabel('progress', 'done')).toBe('进度 8/8')
    expect(markerLabel('priority', '①')).toBe('优先级 ①')
    expect(markerLabel('flag', 'blue')).toBe('旗子 blue')
  })
})
