import { MARKERS, type MarkerCategory } from '../domain/types'

const categoryLabels: Record<MarkerCategory, string> = {
  priority: '优先级',
  expression: '表情',
  progress: '进度',
  flag: '旗子',
  star: '星星',
  person: '人像',
  arrow: '箭头',
  symbol: '符号',
  month: '月份',
}
const valueLabels: Partial<Record<MarkerCategory, Record<string, string>>> = {
  expression: {
    smile: '微笑',
    grin: '大笑',
    angry: '生气',
    cry: '哭',
    surprised: '惊讶',
    sleepy: '困',
    neutral: '平静',
  },
  arrow: {
    up: '向上',
    'up-right': '右上',
    right: '向右',
    'down-right': '右下',
    down: '向下',
    'down-left': '左下',
    left: '向左',
    'up-left': '左上',
    rotate: '旋转',
  },
  symbol: {
    plus: '加号',
    minus: '减号',
    question: '问号',
    info: '信息',
    exclamation: '感叹号',
    cross: '叉号',
    check: '勾选',
    pause: '暂停',
    chart: '图表',
    people: '人群',
    'thumb-down': '反对',
    quote: '引用',
    tools: '工具',
    plane: '飞机',
    heart: '爱心',
    'thumb-up': '赞同',
    'trend-up': '上升',
    key: '钥匙',
    dollar: '金额',
    music: '音乐',
    pencil: '编辑',
    pie: '饼图',
    cart: '购物车',
    phone: '电话',
    thermometer: '温度',
    trophy: '奖杯',
  },
}
const legacyPriority: Record<string, string> = { '①': '1', '②': '2', '③': '3', '④': '4' }

export const markerCategoryLabel = (category: MarkerCategory) => categoryLabels[category]

export const markerLabel = (category: MarkerCategory, value: string) => {
  if (category === 'progress') {
    const index = (MARKERS.progress as readonly string[]).indexOf(value)
    return `进度 ${index < 0 ? 0 : index}/8`
  }
  if (category === 'priority') return `优先级 ${legacyPriority[value] ?? value}`
  return `${categoryLabels[category]} ${valueLabels[category]?.[value] ?? value}`
}

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
