import {
  LIMITS,
  clone,
  type MapContent,
  type NodeLink,
  type NodeSummary,
  type Space,
} from './types'

export const DEFAULT_LINK_TEXT = '关系'
export const DEFAULT_SUMMARY_TEXT = '概要'

export const mapLinks = (map: MapContent): NodeLink[] => map.links ?? []
export const mapSummaries = (map: MapContent): NodeSummary[] => map.summaries ?? []

const orderedSiblings = (map: MapContent, parentId: string) =>
  Object.values(map.nodes)
    .filter((node) => node.parentId === parentId)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))

/**
 * 概括锚点必须是同一父节点下、顺序相邻的节点。
 * 返回按树顺序排好的节点标识；不满足条件时返回 null。
 */
export function summaryAnchorIds(map: MapContent, requested: string[]): string[] | null {
  const ids = [...new Set(requested)]
  if (!ids.length || ids.length > LIMITS.nodes) return null
  const nodes = ids.map((id) => map.nodes[id])
  if (nodes.some((node) => !node)) return null
  const parentId = nodes[0].parentId
  if (!parentId) return null
  if (nodes.some((node) => node.parentId !== parentId)) return null
  const siblings = orderedSiblings(map, parentId)
  const positions = ids.map((id) => siblings.findIndex((node) => node.id === id))
  if (positions.some((position) => position < 0)) return null
  positions.sort((a, b) => a - b)
  if (positions.some((position, index) => index > 0 && position !== positions[index - 1] + 1))
    return null
  return ids.sort(
    (a, b) => (map.nodes[a].order ?? 0) - (map.nodes[b].order ?? 0) || a.localeCompare(b),
  )
}

export function validSummaryAnchors(map: MapContent, ids: string[]): boolean {
  return summaryAnchorIds(map, ids) !== null
}

/** 概括括号覆盖锚点及其所有已展开后代节点。 */
export function summaryRangeIds(map: MapContent, anchorIds: string[]): string[] {
  const ids = new Set<string>(),
    stack = [...anchorIds]
  while (stack.length) {
    const id = stack.pop()!
    if (ids.has(id) || !map.nodes[id]) continue
    ids.add(id)
    for (const node of Object.values(map.nodes)) if (node.parentId === id) stack.push(node.id)
  }
  return [...ids]
}

export function annotationText(text: string, fallback: string): string {
  const trimmed = text.trim()
  return trimmed || fallback
}

/** 将旧版地图级概括标注迁移为可继续建子节点的普通概括节点。 */
export function migrateLegacySummaries(space: Space): { space: Space; changed: boolean } {
  const next = clone(space)
  let changed = false
  for (const map of Object.values(next.maps)) {
    const summaries = map.summaries ?? []
    if (!summaries.length) continue
    const remaining: NodeSummary[] = []
    for (const summary of summaries) {
      if (map.nodes[summary.id]) continue
      const nodeIds = summaryAnchorIds(map, summary.nodeIds)
      if (!nodeIds) {
        remaining.push(summary)
        continue
      }
      const side =
        nodeIds.filter((id) => map.nodes[id].side === -1).length > nodeIds.length / 2 ? -1 : 1
      map.nodes[summary.id] = {
        id: summary.id,
        parentId: null,
        order: 0,
        text: summary.text,
        collapsed: false,
        markers: {},
        position: null,
        side,
        summaryOf: [...nodeIds],
      }
      changed = true
    }
    if (remaining.length) map.summaries = remaining
    else {
      delete map.summaries
      changed = true
    }
  }
  return { space: next, changed }
}

/**
 * 节点结构变化后清理已经不成立的连线和概括。
 * 连线两端仍存在即可；概括要求全部锚点仍属于同一父节点且保持相邻。
 */
export function pruneAnnotations(map: MapContent) {
  if (map.links) {
    const links = map.links.filter(
      (link) => map.nodes[link.fromId] && map.nodes[link.toId] && link.fromId !== link.toId,
    )
    if (links.length !== map.links.length) map.links = links
  }
  if (map.summaries) {
    const summaries = map.summaries.filter((summary) => validSummaryAnchors(map, summary.nodeIds))
    if (summaries.length !== map.summaries.length) map.summaries = summaries
  }
  // 概括节点也是独立树根；锚点失效时连同其子分支一起清理。
  const invalidSummaries = Object.values(map.nodes).filter(
    (node) => node.summaryOf && !validSummaryAnchors(map, node.summaryOf),
  )
  for (const summary of invalidSummaries) {
    const stack = [summary.id]
    while (stack.length) {
      const id = stack.pop()!
      if (!map.nodes[id]) continue
      for (const child of Object.values(map.nodes)) if (child.parentId === id) stack.push(child.id)
      delete map.nodes[id]
    }
  }
}
