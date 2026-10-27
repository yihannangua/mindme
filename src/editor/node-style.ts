import type { MindNode, NodeFont } from '../domain/types'
import type { CanvasStyle } from './style'

const families: Record<NodeFont, string> = {
  sans: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Helvetica Neue', sans-serif",
  serif: "'Songti SC', 'Noto Serif CJK SC', SimSun, serif",
  mono: "'SF Mono', 'Menlo', 'Noto Sans Mono CJK SC', monospace",
}

export function nodeFont(node: MindNode, style: CanvasStyle) {
  return {
    family: families[node.fontFamily ?? 'sans'],
    size: node.fontSize ?? (style === 'compact' ? (node.parentId === null ? 16 : 11) : 14),
  }
}

export function backgroundTextColor(color: string) {
  const channels = [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16) / 255)
  const linear = channels.map((value) =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
  )
  const luminance = linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
  return luminance > 0.179 ? '#1b2931' : '#ffffff'
}
