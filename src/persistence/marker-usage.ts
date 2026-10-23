import { MARKERS, type MarkerCategory } from '../domain/types'

export interface MarkerUsage {
  category: MarkerCategory
  value: string
  count: number
  lastUsed: number
}

type StorageAccess = () => Pick<Storage, 'getItem' | 'setItem'>
const key = 'mindme.marker-usage.v1'
const validMarker = (category: string, value: string): category is MarkerCategory =>
  Object.hasOwn(MARKERS, category) &&
  (MARKERS[category as MarkerCategory] as readonly string[]).includes(value)

export const markerLabel = (category: MarkerCategory, value: string) =>
  `${category === 'priority' ? '优先级' : category === 'progress' ? '进度' : '旗子'} ${category === 'progress' ? `${(MARKERS.progress as readonly string[]).indexOf(value)}/8` : value}`

export const frequentMarkers = (entries: MarkerUsage[]) =>
  [...entries].sort((a, b) => b.count - a.count || b.lastUsed - a.lastUsed).slice(0, 5)

// 使用偏好只留在本机；不根据脑图已有图标反推使用次数，也不进入同步队列。
export class MarkerUsageStorage {
  private fallback: MarkerUsage[] = []
  private loaded = false
  constructor(private storage: StorageAccess = () => window.localStorage) {}
  load(): MarkerUsage[] {
    if (this.loaded) return this.fallback
    this.loaded = true
    try {
      const data = JSON.parse(this.storage().getItem(key) ?? 'null')
      if (data?.version !== 1 || !Array.isArray(data.entries)) return this.fallback
      const seen = new Set<string>()
      const entries = data.entries
        .filter((item: MarkerUsage) => {
          if (
            !item ||
            !validMarker(item.category, item.value) ||
            !Number.isSafeInteger(item.count) ||
            item.count <= 0 ||
            !Number.isSafeInteger(item.lastUsed) ||
            item.lastUsed < 0
          )
            return false
          const id = `${item.category}:${item.value}`
          if (seen.has(id)) return false
          seen.add(id)
          return true
        })
        .map(({ category, value, count, lastUsed }: MarkerUsage) => ({
          category,
          value,
          count,
          lastUsed,
        }))
      this.fallback = entries
      return entries
    } catch {
      return this.fallback
    }
  }
  record(category: MarkerCategory, value: string): MarkerUsage[] {
    const entries = this.load()
    if (!validMarker(category, value)) return entries
    const lastUsed = Math.min(
      Number.MAX_SAFE_INTEGER,
      Math.max(0, ...entries.map((item) => item.lastUsed)) + 1,
    )
    const previous = entries.find((item) => item.category === category && item.value === value)
    const next = entries.filter((item) => item !== previous)
    next.push({
      category,
      value,
      count: Math.min(Number.MAX_SAFE_INTEGER, (previous?.count ?? 0) + 1),
      lastUsed,
    })
    this.fallback = next
    try {
      this.storage().setItem(key, JSON.stringify({ version: 1, entries: next }))
    } catch {
      // 本机存储不可用时仍在本次页面内统计，不能阻断图标设置。
    }
    return next
  }
}
export const markerUsageStorage = new MarkerUsageStorage()
