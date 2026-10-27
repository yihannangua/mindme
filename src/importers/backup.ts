import { selectedForest } from '../domain/branches'
import { children, makeNode, uniqueName, validateMap, validateSpace } from '../domain/model'
import {
  assert,
  clone,
  LIMITS,
  type Context,
  type MapContent,
  type MindMap,
  type Space,
  type TabState,
} from '../domain/types'
import type { ImportDraft, ImportResult } from './outline'
export const BRANCHES_MIME = 'application/x-mindme-branches+json'
export interface Backup {
  format: 'mindme'
  schemaVersion: 1
  exportedAt: number
  maps: MapContent[]
  tabs: TabState[]
}
export function exportBackup(space: Space, now: number, mapId?: string): Backup {
  const maps = Object.values(space.maps)
    .filter((map) => map.deletedAt === null && (!mapId || map.id === mapId))
    .map(({ id, title, rootId, nodes, deletedAt }) =>
      clone({ id, title, rootId, nodes, deletedAt }),
    )
  const ids = new Set(maps.map((map) => map.id))
  return {
    format: 'mindme',
    schemaVersion: 1,
    exportedAt: now,
    maps,
    tabs: Object.values(space.tabs)
      .filter((tab) => ids.has(tab.mapId))
      .sort((a, b) => a.order - b.order)
      .map(clone),
  }
}
export function parseBackup(text: string): Backup {
  assert(text.length <= LIMITS.fileBytes, '备份文件超过 20 MiB')
  let value: Backup
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('备份 JSON 格式损坏')
  }
  assert(
    value &&
      value.format === 'mindme' &&
      value.schemaVersion === 1 &&
      Array.isArray(value.maps) &&
      Array.isArray(value.tabs) &&
      Number.isFinite(value.exportedAt),
    '不支持的备份格式或版本',
  )
  assert(value.maps.length <= LIMITS.maps, '备份脑图过多')
  const ids = new Set<string>()
  for (const map of value.maps) {
    validateMap(map)
    assert(map.deletedAt === null && !ids.has(map.id), '备份包含回收站内容或重复标识')
    ids.add(map.id)
  }
  const tabs = new Set<string>()
  for (const tab of value.tabs) {
    assert(
      tab &&
        ids.has(tab.mapId) &&
        !tabs.has(tab.mapId) &&
        typeof tab.pinned === 'boolean' &&
        typeof tab.open === 'boolean' &&
        Number.isFinite(tab.order),
      '备份标签数据损坏',
    )
    tabs.add(tab.mapId)
  }
  return value
}
export function importBackup(space: Space, backup: Backup, ctx: Context): Space {
  const next = clone(space),
    remap = new Map<string, string>()
  for (const original of backup.maps) {
    const id = ctx.id(),
      nodeIds = new Map(Object.keys(original.nodes).map((id) => [id, ctx.id()])),
      title = uniqueName(next, original.title)
    const nodes = Object.fromEntries(
      Object.values(original.nodes).map((node) => {
        const copy = {
          ...clone(node),
          id: nodeIds.get(node.id)!,
          parentId: node.parentId ? nodeIds.get(node.parentId)! : null,
        }
        if (copy.parentId === null) copy.text = title
        return [copy.id, copy]
      }),
    )
    next.maps[id] = {
      ...clone(original),
      schemaVersion: 1,
      id,
      title,
      rootId: nodeIds.get(original.rootId)!,
      nodes,
      updatedAt: ctx.now,
      revision: 0,
      history: [],
      historyDirtySince: ctx.now,
    }
    remap.set(original.id, id)
  }
  let order = Math.max(-1, ...Object.values(next.tabs).map((tab) => tab.order)) + 1
  for (const tab of [...backup.tabs].sort((a, b) => a.order - b.order)) {
    const id = remap.get(tab.mapId)!
    next.tabs[id] = { ...tab, mapId: id, order: order++ }
  }
  for (const id of remap.values())
    if (!next.tabs[id]) next.tabs[id] = { mapId: id, order: order++, open: false, pinned: false }
  validateSpace(next)
  return next
}
export function importDrafts(
  space: Space,
  result: ImportResult,
  ctx: Context,
  target?: { mapId: string; nodeId: string },
): Space {
  const next = clone(space)
  for (const draft of result.drafts) {
    assert(draft.nodes.length > 0, '导入内容为空')
    const root = draft.nodes.filter((node) => node.parentId === null)
    assert(root.length === 1, '导入内容缺少唯一中心主题')
    const ids = new Map(draft.nodes.map((node) => [node.id, ctx.id()]))
    assert(ids.size === draft.nodes.length, '导入内容存在重复节点')
    let map: MindMap
    if (target) {
      map = next.maps[target.mapId]
      assert(map && map.deletedAt === null && map.nodes[target.nodeId], '选中的导入位置已不存在')
    } else {
      const id = ctx.id(),
        title = uniqueName(next, draft.title)
      map = {
        schemaVersion: 1,
        id,
        title,
        rootId: ids.get(root[0].id)!,
        nodes: {},
        updatedAt: ctx.now,
        revision: 0,
        deletedAt: null,
        history: [],
        historyDirtySince: ctx.now,
      }
      next.maps[id] = map
      next.tabs[id] = { mapId: id, order: Object.keys(next.tabs).length, pinned: false, open: true }
    }
    const offset = target ? children(map, target.nodeId).length : 0
    for (const [index, original] of draft.nodes.entries()) {
      const id = ids.get(original.id)!,
        parentId = original.parentId ? ids.get(original.parentId)! : (target?.nodeId ?? null)
      const node = {
        ...makeNode(id, parentId, parentId === null ? map.title : original.text, offset + index),
        markers: clone(original.markers),
        collapsed: !!original.collapsed,
        ...(original.fontFamily != null && { fontFamily: original.fontFamily }),
        ...(original.fontSize != null && { fontSize: original.fontSize }),
        ...(original.backgroundColor != null && { backgroundColor: original.backgroundColor }),
      }
      node.side = index % 4 < 2 ? 1 : -1
      map.nodes[id] = node
    }
    map.updatedAt = ctx.now
    map.historyDirtySince ??= ctx.now
  }
  validateSpace(next)
  return next
}
export function copyBranch(map: MindMap, nodeId: string): ImportDraft {
  const nodes: ImportDraft['nodes'] = []
  const visit = (id: string, parentId: string | null) => {
    const node = map.nodes[id]
    nodes.push({
      id,
      parentId,
      text: node.text,
      markers: clone(node.markers),
      collapsed: node.collapsed,
      fontFamily: node.fontFamily,
      fontSize: node.fontSize,
      backgroundColor: node.backgroundColor,
    })
    for (const child of children(map, id)) visit(child.id, id)
  }
  visit(nodeId, null)
  return { title: map.nodes[nodeId].text, nodes }
}

export function copyBranches(map: MindMap, nodeIds: string[]): ImportDraft[] {
  return selectedForest(map, nodeIds).roots.map((id) => copyBranch(map, id))
}

export function branchText(drafts: ImportDraft[]): string {
  return drafts
    .map((draft) => {
      const depths = new Map<string, number>()
      return draft.nodes
        .map((node) => {
          const depth = node.parentId ? (depths.get(node.parentId) ?? 0) + 1 : 0
          depths.set(node.id, depth)
          return `${'  '.repeat(depth)}- ${node.text}`
        })
        .join('\n')
    })
    .join('\n')
}
