import type { MapContent, MindNode } from '../domain/types'
import type { CanvasStyle } from '../editor/style'
import { nodeFont } from '../editor/node-style'
export interface LayoutNode {
  node: MindNode
  x: number
  y: number
  width: number
  height: number
  textLeft: number
  textWidth: number
  lineHeight: number
  lines: string[]
  side: -1 | 0 | 1
  color: string
}
export interface TreeLayout {
  nodes: LayoutNode[]
  byId: Map<string, LayoutNode>
  width: number
  height: number
}
export type TextMeasure = (text: string, node: MindNode) => number
interface LayoutOptions {
  measureText?: TextMeasure
  draft?: { id: string; text: string; height?: number }
  style?: CanvasStyle
}
const palette = ['#779eae', '#9ab19c', '#b29ac0', '#c3aa7c']
const segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' })
function glyphWidth(char: string) {
  return /[\u2e80-\uffff]|\p{Extended_Pictographic}/u.test(char)
    ? 14
    : /[A-ZMW@]/.test(char)
      ? 10
      : 7.3
}
export function measureNode(
  node: MindNode,
  measureText?: TextMeasure,
  style: CanvasStyle = 'classic',
) {
  const compact = style === 'compact',
    maxTextWidth = compact ? 360 : 440,
    lineHeight =
      node.fontSize == null ? (compact ? 15 : 21) : Math.ceil(nodeFont(node, style).size * 1.5),
    horizontalPadding = compact ? 18 : 32,
    verticalPadding = compact ? 6 : 20,
    minWidth = compact ? 28 : 44,
    minHeight = compact ? 18 : 42
  const lines: string[] = [],
    widths: number[] = []
  for (const paragraph of node.text.split('\n')) {
    let line = '',
      width = 0
    for (const { segment } of segmenter.segment(paragraph)) {
      const size = measureText
        ? measureText(segment, node)
        : glyphWidth(segment) * (nodeFont(node, style).size / 14)
      if (width + size > maxTextWidth && line) {
        lines.push(line)
        widths.push(width)
        line = ''
        width = 0
      }
      line += segment
      width += size
    }
    lines.push(line)
    widths.push(width)
  }
  // 留出字形边缘和浏览器小数像素的余量，避免末字被输入框裁掉。
  const textWidth = Math.max(minWidth, Math.ceil(Math.max(...widths)) + (compact ? 2 : 4))
  const markerWidth = Object.keys(node.markers).length * 22
  return {
    width: textWidth + markerWidth + horizontalPadding,
    height: Math.max(minHeight, lines.length * lineHeight + verticalPadding),
    textLeft: compact ? 7 + markerWidth + (markerWidth ? 4 : 0) : 16 + markerWidth,
    textWidth,
    lineHeight,
    lines,
  }
}
export function layoutTree(map: MapContent, options: LayoutOptions = {}): TreeLayout {
  const index = new Map<string, MindNode[]>()
  for (const node of Object.values(map.nodes))
    if (node.parentId) {
      if (!index.has(node.parentId)) index.set(node.parentId, [])
      index.get(node.parentId)!.push(node)
    }
  for (const nodes of index.values())
    nodes.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
  const metrics = new Map<string, ReturnType<typeof measureNode>>(),
    heights = new Map<string, number>()
  const size = (id: string): number => {
    const node = map.nodes[id],
      draft = options.draft?.id === id ? options.draft : undefined,
      metric = measureNode(
        draft ? { ...node, text: draft.text } : node,
        options.measureText,
        options.style,
      )
    if (draft?.height)
      metric.height = Math.max(metric.height, draft.height + (options.style === 'compact' ? 6 : 20))
    metrics.set(id, metric)
    const children = node.collapsed ? [] : (index.get(id) ?? [])
    const h = Math.max(
      metric.height + (options.style === 'compact' ? 8 : 24),
      children.reduce((sum, item) => sum + size(item.id), 0),
    )
    heights.set(id, h)
    return h
  }
  size(map.rootId)
  const nodes: LayoutNode[] = [],
    byId = new Map<string, LayoutNode>()
  const put = (node: MindNode, x: number, y: number, side: -1 | 0 | 1, color: string) => {
    const item = { node, x, y, ...metrics.get(node.id)!, side, color }
    nodes.push(item)
    byId.set(node.id, item)
    return item
  }
  const rootNode = map.nodes[map.rootId]
  const root = put(rootNode, rootNode.position?.x ?? 0, rootNode.position?.y ?? 0, 0, '#d75a4e')
  const visit = (node: MindNode, parent: LayoutNode, y: number, side: -1 | 1, color: string) => {
    const metric = metrics.get(node.id)!,
      x =
        parent.x +
        side * (parent.width / 2 + (options.style === 'compact' ? 26 : 75) + metric.width / 2)
    const placed = put(node, x + (node.position?.x ?? 0), y + (node.position?.y ?? 0), side, color)
    const children = node.collapsed ? [] : (index.get(node.id) ?? [])
    let top = placed.y - children.reduce((sum, item) => sum + heights.get(item.id)!, 0) / 2
    for (const child of children) {
      const height = heights.get(child.id)!
      visit(child, placed, top + height / 2, side, color)
      top += height
    }
  }
  const first = root.node.collapsed ? [] : (index.get(root.node.id) ?? [])
  for (const side of [1, -1] as const) {
    const branches = first.filter((node, i) => (node.side || (i % 4 < 2 ? 1 : -1)) === side)
    let top = root.y - branches.reduce((sum, node) => sum + heights.get(node.id)!, 0) / 2
    // 左侧反序形成从右上开始、经右下到左下和左上的顺时针序列。
    const ordered = side === -1 ? [...branches].reverse() : branches
    for (const node of ordered) {
      const height = heights.get(node.id)!
      visit(node, root, top + height / 2, side, palette[first.indexOf(node) % palette.length])
      top += height
    }
  }
  return {
    nodes,
    byId,
    width:
      Math.max(...nodes.map((n) => n.x + n.width / 2)) -
      Math.min(...nodes.map((n) => n.x - n.width / 2)),
    height:
      Math.max(...nodes.map((n) => n.y + n.height / 2)) -
      Math.min(...nodes.map((n) => n.y - n.height / 2)),
  }
}
export function edgePath(parent: LayoutNode, child: LayoutNode, style: CanvasStyle = 'classic') {
  const sx = parent.x + (parent.width / 2) * child.side,
    ex = child.x - (child.width / 2) * child.side,
    mid = (sx + ex) / 2
  return style === 'compact'
    ? `M ${sx} ${parent.y} H ${mid} V ${child.y} H ${ex}`
    : `M ${sx} ${parent.y} C ${mid} ${parent.y}, ${mid} ${child.y}, ${ex} ${child.y}`
}
