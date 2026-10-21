import { selectedForest } from './branches'
import { balanceMap } from '../layout/balance'
import { assertName, children, makeNode, subtree, validateSpace } from './model'
import { assert, clone, MARKERS, type Context, type MarkerCategory, type Space } from './types'

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
  | { type: 'marker'; nodeId: string; category: MarkerCategory; value: string }
  | { type: 'marker-many'; nodeIds: string[]; category: MarkerCategory; value: string }
  | { type: 'layout' }
  | { type: 'trash' }
  | { type: 'untrash' }
  | { type: 'purge' }
  | { type: 'restore'; versionId: string }

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
      assert(node!.parentId !== null, '中心主题不能直接删除，请将脑图移至回收站')
      selectedId = node!.parentId!
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
      selectedId = map.nodes[forest.roots[0]].parentId!
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
      node!.position = null
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
        root.position = null
      }
      if (targetSide !== null) for (const id of forest.ids) map.nodes[id].side = targetSide
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
      break
    }
  }
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
  map.history.push({
    schemaVersion: 1,
    id: ctx.id(),
    at: ctx.now,
    reason,
    content: clone({ id, title, rootId, nodes, deletedAt }),
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
