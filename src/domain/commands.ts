import { selectedForest } from './branches'
import { balanceMap } from '../layout/balance'
import {
  annotationText,
  DEFAULT_LINK_TEXT,
  DEFAULT_SUMMARY_TEXT,
  pruneAnnotations,
  summaryAnchorIds,
} from './annotations'
import { assertName, children, makeNode, subtree, validateSpace } from './model'
import {
  assert,
  clone,
  LIMITS,
  MARKERS,
  type Context,
  type MarkerCategory,
  type MapContent,
  type NodeFont,
  type Space,
} from './types'

export type Command =
  | { type: 'add'; nodeId: string; kind: 'child' | 'sibling' | 'parent'; text?: string }
  | { type: 'text'; nodeId: string; text: string }
  | { type: 'delete'; nodeId: string }
  | { type: 'delete-many'; nodeIds: string[] }
  | { type: 'reparent-many'; nodeIds: string[]; parentId: string }
  | { type: 'reparent'; nodeId: string; parentId: string }
  | { type: 'sort'; nodeId: string; delta: -1 | 1 }
  | { type: 'move'; nodeId: string; position: { x: number; y: number }; side?: -1 | 1 }
  | { type: 'fold'; nodeId: string; recursive?: boolean; value?: boolean }
  | { type: 'fold-all'; value?: boolean }
  | { type: 'marker'; nodeId: string; category: MarkerCategory; value: string }
  | { type: 'marker-many'; nodeIds: string[]; category: MarkerCategory; value: string }
  | {
      type: 'style-many'
      nodeIds: string[]
      style: {
        fontFamily?: NodeFont | null
        fontSize?: number | null
        backgroundColor?: string | null
      }
    }
  | { type: 'link-add'; fromId: string; toId: string; text?: string }
  | { type: 'link-text'; linkId: string; text: string }
  | { type: 'link-delete'; linkId: string }
  | { type: 'summary-add'; nodeIds: string[]; text?: string }
  | { type: 'summary-text'; summaryId: string; text: string }
  | { type: 'summary-delete'; summaryId: string }
  | { type: 'layout' }
  | { type: 'trash' }
  | { type: 'untrash' }
  | { type: 'purge' }
  | { type: 'restore'; versionId: string }

// 删除后优先选择后续同级，末尾则选择最近的前一个，没有同级时回到父节点。
function selectionAfterDelete(map: MapContent, id: string, removed: Set<string>): string {
  const node = map.nodes[id],
    parentId = node.parentId!,
    siblings = children(map, parentId),
    index = siblings.findIndex((sibling) => sibling.id === id)
  return (
    siblings.slice(index + 1).find((sibling) => !removed.has(sibling.id))?.id ??
    siblings
      .slice(0, index)
      .reverse()
      .find((sibling) => !removed.has(sibling.id))?.id ??
    parentId
  )
}

// 重新挂接或新增父主题后，整棵移动子树的手动偏移都已失效。
function clearSubtreePositions(map: MapContent, id: string) {
  for (const nodeId of subtree(map, id)) map.nodes[nodeId].position = null
}

export function execute(
  space: Space,
  mapId: string,
  command: Command,
  ctx: Context,
): { space: Space; selectedId?: string } {
  const next = clone(space),
    map = next.maps[mapId]
  assert(map, '脑图不存在')
  assert(map.deletedAt === null || ['untrash', 'purge'].includes(command.type), '脑图已在回收站中')
  let selectedId: string | undefined
  const node = 'nodeId' in command ? map.nodes[command.nodeId] : undefined
  if ('nodeId' in command) assert(node, '节点不存在')
  switch (command.type) {
    case 'add': {
      assert(command.kind === 'child' || node!.parentId !== null, '中心主题不能新增同级或父主题')
      const id = ctx.id(),
        parentId = command.kind === 'child' ? node!.id : node!.parentId!
      const siblings = children(map, parentId)
      const order =
        command.kind === 'child'
          ? siblings.length
          : node!.order + (command.kind === 'sibling' ? 1 : 0)
      if (command.kind === 'sibling')
        for (const item of siblings) if (item.order >= order) item.order++
      map.nodes[id] = {
        ...makeNode(id, parentId, command.text ?? '新主题', order),
        side: node!.id === map.rootId ? (siblings.length % 4 < 2 ? 1 : -1) : node!.side,
      }
      if (command.kind === 'parent') {
        clearSubtreePositions(map, node!.id)
        node!.parentId = id
        node!.order = 0
      }
      if (command.kind === 'child') node!.collapsed = false
      selectedId = id
      break
    }
    case 'text': {
      if (node!.id === map.rootId) {
        assertName(next, command.text, mapId)
        map.title = command.text.trim()
        node!.text = map.title
      } else node!.text = command.text
      break
    }
    case 'delete': {
      const summary = node!.parentId === null && node!.summaryOf !== undefined
      assert(node!.parentId !== null || summary, '中心主题不能直接删除，请将脑图移至回收站')
      selectedId = summary ? map.rootId : selectionAfterDelete(map, node!.id, new Set([node!.id]))
      for (const id of subtree(map, node!.id)) delete map.nodes[id]
      break
    }
    case 'delete-many': {
      assert(
        command.nodeIds.length > 1 && command.nodeIds.every((id) => !!map.nodes[id]),
        '选择包含不存在的节点',
      )
      assert(!command.nodeIds.includes(map.rootId), '中心主题不能批量删除')
      const forest = selectedForest(map, command.nodeIds)
      selectedId = forest.roots.some((id) => map.nodes[id].parentId === null)
        ? map.rootId
        : selectionAfterDelete(map, forest.roots[0], forest.ids)
      for (const id of forest.roots)
        for (const descendant of subtree(map, id)) delete map.nodes[descendant]
      break
    }
    case 'reparent': {
      assert(node!.parentId !== null, '中心主题不能挂接')
      assert(
        map.nodes[command.parentId] && !subtree(map, node!.id).includes(command.parentId),
        '不能挂接到自身或后代',
      )
      node!.parentId = command.parentId
      node!.order = children(map, command.parentId).length
      clearSubtreePositions(map, node!.id)
      node!.side = map.nodes[command.parentId].side || 1
      break
    }
    case 'reparent-many': {
      assert(
        command.nodeIds.length > 0 && command.nodeIds.every((id) => !!map.nodes[id]),
        '选择包含不存在的节点',
      )
      assert(!command.nodeIds.includes(map.rootId), '中心主题不能参与批量挂接')
      assert(map.nodes[command.parentId], '目标节点不存在')
      const forest = selectedForest(map, command.nodeIds)
      assert(!forest.ids.has(command.parentId), '不能挂接到已选节点或其后代')
      const moving = new Set(forest.roots),
        siblings = children(map, command.parentId).filter((item) => !moving.has(item.id)),
        order = Math.max(-1, ...siblings.map((item) => item.order)) + 1,
        targetSide = command.parentId === map.rootId ? null : map.nodes[command.parentId].side || 1
      for (const [i, id] of forest.roots.entries()) {
        const root = map.nodes[id]
        root.parentId = command.parentId
        root.order = order + i
      }
      for (const id of forest.ids) {
        map.nodes[id].position = null
        if (targetSide !== null) map.nodes[id].side = targetSide
      }
      break
    }
    case 'sort': {
      assert(node!.parentId !== null, '中心主题不能排序')
      const siblings = children(map, node!.parentId!),
        index = siblings.findIndex((item) => item.id === node!.id),
        target = siblings[index + command.delta]
      if (target) {
        siblings.forEach((item, i) => {
          item.order = i
        })
        const old = node!.order
        node!.order = target.order
        target.order = old
        ;[node!.side, target.side] = [target.side, node!.side]
        node!.position = null
        target.position = null
      }
      break
    }
    case 'move':
      node!.position = command.position
      if (command.side) node!.side = command.side
      break
    case 'fold': {
      const ids = command.recursive
        ? subtree(map, node!.id).filter((id) => children(map, id).length)
        : children(map, node!.id).length
          ? [node!.id]
          : []
      const value =
        command.value ??
        (command.recursive ? !ids.some((id) => map.nodes[id].collapsed) : !node!.collapsed)
      for (const id of ids) map.nodes[id].collapsed = value
      break
    }
    case 'fold-all': {
      const ids = Object.values(map.nodes)
        .filter((item) => children(map, item.id).length > 0)
        .map((item) => item.id)
      if (!ids.length) break
      const value = command.value ?? !ids.every((id) => map.nodes[id].collapsed)
      for (const id of ids) map.nodes[id].collapsed = value
      break
    }
    case 'marker':
    case 'marker-many': {
      assert((MARKERS[command.category] as readonly string[]).includes(command.value), '标记不合法')
      const ids = command.type === 'marker' ? [command.nodeId] : [...new Set(command.nodeIds)]
      assert(ids.length > 0, '请先选择节点')
      assert(
        ids.every((id) => !!map.nodes[id]),
        '节点不存在',
      )
      // 混合状态统一设置；仅全部已有同一标记时统一移除，整批作为一次命令撤销。
      const remove = ids.every((id) => map.nodes[id].markers[command.category] === command.value)
      for (const id of ids) {
        if (remove) delete map.nodes[id].markers[command.category]
        else map.nodes[id].markers[command.category] = command.value
      }
      break
    }
    case 'style-many': {
      const ids = [...new Set(command.nodeIds)]
      assert(ids.length > 0 && ids.every((id) => !!map.nodes[id]), '请选择有效节点')
      assert(
        Object.keys(command.style).every((key) =>
          ['fontFamily', 'fontSize', 'backgroundColor'].includes(key),
        ),
        '节点样式不合法',
      )
      for (const id of ids) Object.assign(map.nodes[id], command.style)
      break
    }
    case 'link-add': {
      const from = map.nodes[command.fromId],
        to = map.nodes[command.toId]
      assert(from && to && from.id !== to.id, '请选择两个不同的节点')
      assert(
        !(map.links ?? []).some(
          (link) =>
            (link.fromId === from.id && link.toId === to.id) ||
            (link.fromId === to.id && link.toId === from.id),
        ),
        '两个节点之间已有连线',
      )
      const text = annotationText(command.text ?? DEFAULT_LINK_TEXT, DEFAULT_LINK_TEXT)
      assert(text.length <= LIMITS.text, '连线文字过长')
      map.links = [...(map.links ?? []), { id: ctx.id(), fromId: from.id, toId: to.id, text }]
      break
    }
    case 'link-text': {
      const link = (map.links ?? []).find((item) => item.id === command.linkId)
      assert(link, '连线不存在')
      const text = annotationText(command.text, DEFAULT_LINK_TEXT)
      assert(text.length <= LIMITS.text, '连线文字过长')
      link.text = text
      break
    }
    case 'link-delete':
      assert(
        (map.links ?? []).some((link) => link.id === command.linkId),
        '连线不存在',
      )
      map.links = (map.links ?? []).filter((link) => link.id !== command.linkId)
      break
    case 'summary-add': {
      const nodeIds = summaryAnchorIds(map, command.nodeIds)
      assert(nodeIds, '概括只支持同一父节点下连续相邻的节点')
      const anchorKey = [...nodeIds].sort().join('/'),
        duplicate =
          (map.summaries ?? []).some(
            (summary) => [...summary.nodeIds].sort().join('/') === anchorKey,
          ) ||
          Object.values(map.nodes).some(
            (node) => node.summaryOf && [...node.summaryOf].sort().join('/') === anchorKey,
          )
      assert(!duplicate, '这些节点已有概括')
      const text = annotationText(command.text ?? DEFAULT_SUMMARY_TEXT, DEFAULT_SUMMARY_TEXT)
      assert(text.length <= LIMITS.text, '概括文字过长')
      const id = ctx.id(),
        side =
          nodeIds.filter((nodeId) => map.nodes[nodeId].side === -1).length > nodeIds.length / 2
            ? -1
            : 1
      map.nodes[id] = { ...makeNode(id, null, text, 0), side, summaryOf: [...nodeIds] }
      selectedId = id
      break
    }
    case 'summary-text': {
      const summaryNode = map.nodes[command.summaryId]
      if (summaryNode?.summaryOf) {
        const text = annotationText(command.text, DEFAULT_SUMMARY_TEXT)
        assert(text.length <= LIMITS.text, '概括文字过长')
        summaryNode.text = text
        break
      }
      const summary = (map.summaries ?? []).find((item) => item.id === command.summaryId)
      assert(summary, '概括不存在')
      const text = annotationText(command.text, DEFAULT_SUMMARY_TEXT)
      assert(text.length <= LIMITS.text, '概括文字过长')
      summary.text = text
      break
    }
    case 'summary-delete': {
      const summaryNode = map.nodes[command.summaryId]
      if (summaryNode?.summaryOf) {
        for (const id of subtree(map, summaryNode.id)) delete map.nodes[id]
        selectedId = map.rootId
        break
      }
      assert(
        (map.summaries ?? []).some((summary) => summary.id === command.summaryId),
        '概括不存在',
      )
      map.summaries = (map.summaries ?? []).filter((summary) => summary.id !== command.summaryId)
      break
    }
    case 'layout':
      if (!balanceMap(map)) return { space }
      break
    case 'trash':
      map.deletedAt = ctx.now
      if (next.tabs[mapId]) next.tabs[mapId].open = false
      break
    case 'untrash':
      map.deletedAt = null
      next.tabs[mapId] = {
        ...(next.tabs[mapId] ?? { order: Object.keys(next.tabs).length, pinned: false }),
        mapId,
        open: true,
      }
      break
    case 'purge':
      assert(map.deletedAt !== null, '请先将脑图移至回收站')
      delete next.maps[mapId]
      delete next.tabs[mapId]
      return { space: next }
    case 'restore': {
      const target = clone(map.history.find((item) => item.id === command.versionId))
      assert(target, '历史版本不存在')
      assertName(next, target.content.title, mapId)
      saveVersion(map, ctx, 'restore', true)
      Object.assign(map, target.content, { deletedAt: null })
      map.links = target.content.links ? clone(target.content.links) : undefined
      map.summaries = target.content.summaries ? clone(target.content.summaries) : undefined
      break
    }
  }
  // 删除节点、排序或挂接后，失效的连线和不再连续的概括随同一命令清理。
  pruneAnnotations(map)
  map.updatedAt = ctx.now
  map.historyDirtySince ??= ctx.now
  validateSpace(next)
  return { space: next, selectedId }
}
export function saveVersion(
  map: Space['maps'][string],
  ctx: Context,
  reason: 'window' | 'leave' | 'restore',
  force = false,
) {
  if (!force && map.historyDirtySince === null) return
  const { id, title, rootId, nodes, deletedAt } = map
  const content: MapContent = { id, title, rootId, nodes, deletedAt }
  if (map.links) content.links = clone(map.links)
  if (map.summaries) content.summaries = clone(map.summaries)
  map.history.push({
    schemaVersion: 1,
    id: ctx.id(),
    at: ctx.now,
    reason,
    content: clone(content),
  })
  map.history = map.history.slice(-10)
  map.historyDirtySince = null
}
export function maintenance(space: Space, ctx: Context, leave = false): Space {
  const next = clone(space)
  for (const map of Object.values(next.maps)) {
    if (map.deletedAt !== null && ctx.now - map.deletedAt >= 30 * 86400000) {
      delete next.maps[map.id]
      delete next.tabs[map.id]
    } else if (
      map.deletedAt === null &&
      map.historyDirtySince !== null &&
      (leave || ctx.now - map.historyDirtySince >= 300000)
    )
      saveVersion(map, ctx, leave ? 'leave' : 'window')
  }
  return next
}
