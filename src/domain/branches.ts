import type { MapContent, MindNode } from './types'

// 只搬动选择集合中最外层的分支，并收集所有后代，避免父子同时选中被拆散。
export function selectedForest(map: MapContent, selectedIds: string[]) {
  if (!selectedIds.length) return { roots: [] as string[], ids: new Set<string>() }
  const selected = new Set(selectedIds),
    index = new Map<string, MindNode[]>(),
    roots: string[] = [],
    ids = new Set<string>()
  for (const node of Object.values(map.nodes)) {
    if (!node.parentId) continue
    if (!index.has(node.parentId)) index.set(node.parentId, [])
    index.get(node.parentId)!.push(node)
  }
  for (const siblings of index.values())
    siblings.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
  const visit = (id: string, ancestorSelected: boolean) => {
    const included = selected.has(id)
    if (included && !ancestorSelected) roots.push(id)
    if (included || ancestorSelected) ids.add(id)
    for (const child of index.get(id) ?? []) visit(child.id, included || ancestorSelected)
  }
  visit(map.rootId, false)
  return { roots, ids }
}
