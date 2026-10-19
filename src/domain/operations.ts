import { validateSpace } from './model'
import { assert, clone, equal, own, type Change, type HistoryChange, type Space } from './types'

const mapFields = ['title', 'deletedAt', 'historyDirtySince'] as const
const nodeFields = ['parentId', 'order', 'text', 'collapsed', 'position', 'side'] as const
export function diffSpace(before: Space, after: Space): Change[] {
  const changes: Change[] = []
  const add = (change: Change) => {
    if (!equal(change.before, change.after)) changes.push(change)
  }
  for (const mapId of new Set([...Object.keys(before.maps), ...Object.keys(after.maps)])) {
    const a = before.maps[mapId],
      b = after.maps[mapId]
    if (!a || !b) {
      add({ mapId, field: '$map', before: a ?? null, after: b ?? null })
      continue
    }
    for (const field of mapFields) add({ mapId, field, before: a[field], after: b[field] })
    const previousHistory = new Set(a.history.map((version) => version.id))
    for (const version of b.history)
      if (!previousHistory.has(version.id))
        changes.push({
          mapId,
          field: 'history-add',
          before: null,
          after: clone(version),
        } as HistoryChange)
    for (const nodeId of new Set([...Object.keys(a.nodes), ...Object.keys(b.nodes)])) {
      const an = a.nodes[nodeId],
        bn = b.nodes[nodeId]
      if (!an || !bn) {
        add({ mapId, nodeId, field: '$node', before: an ?? null, after: bn ?? null })
        continue
      }
      for (const field of nodeFields)
        add({ mapId, nodeId, field, before: an[field], after: bn[field] })
      for (const category of ['priority', 'progress', 'flag'] as const)
        add({
          mapId,
          nodeId,
          field: `marker:${category}`,
          before: an.markers[category] ?? null,
          after: bn.markers[category] ?? null,
        })
    }
  }
  for (const mapId of new Set([...Object.keys(before.tabs), ...Object.keys(after.tabs)])) {
    const a = before.tabs[mapId],
      b = after.tabs[mapId]
    if (!a || !b) add({ mapId, field: '$tab', before: a ?? null, after: b ?? null })
    else
      for (const field of ['order', 'pinned', 'open'] as const)
        add({ mapId, field: `tab:${field}`, before: a[field], after: b[field] })
  }
  return changes
}
export function readField(
  space: Space,
  change: Pick<Change, 'mapId' | 'nodeId' | 'field'>,
): unknown {
  const map = space.maps[change.mapId]
  if (change.field === '$map') return map ?? null
  if (change.field === '$tab') return space.tabs[change.mapId] ?? null
  if (change.field.startsWith('tab:'))
    return space.tabs[change.mapId]?.[change.field.slice(4) as 'open'] ?? null
  if (!map) return null
  if (!change.nodeId) return map[change.field as 'title'] ?? null
  const node = map.nodes[change.nodeId]
  if (change.field === '$node') return node ?? null
  if (!node) return null
  return change.field.startsWith('marker:')
    ? (node.markers[change.field.slice(7) as 'flag'] ?? null)
    : (node[change.field as 'text'] ?? null)
}
export function applyChanges(space: Space, changes: Change[], now: number): Space {
  const next = clone(space)
  for (const change of changes) {
    const { mapId, nodeId, field, after } = change
    if (field === '$map') {
      if (after === null) delete next.maps[mapId]
      else next.maps[mapId] = clone(after) as Space['maps'][string]
      continue
    }
    if (field === '$tab') {
      if (after === null) delete next.tabs[mapId]
      else next.tabs[mapId] = clone(after) as Space['tabs'][string]
      continue
    }
    if (field.startsWith('tab:')) {
      assert(
        next.tabs[mapId] && ['open', 'order', 'pinned'].includes(field.slice(4)),
        '标签字段不存在',
      )
      Object.assign(next.tabs[mapId], { [field.slice(4)]: after })
      continue
    }
    const map = next.maps[mapId]
    assert(map, '脑图已删除')
    if (field === 'history-add') {
      const version = clone(after) as Space['maps'][string]['history'][number]
      if (!map.history.some((item) => item.id === version.id))
        map.history = [...map.history, version].sort((a, b) => a.at - b.at).slice(-10)
    } else if (!nodeId) {
      assert((mapFields as readonly string[]).includes(field), '脑图字段不合法')
      Object.assign(map, { [field]: clone(after) })
    } else if (field === '$node') {
      if (after === null) delete map.nodes[nodeId]
      else map.nodes[nodeId] = clone(after) as (typeof map.nodes)[string]
    } else {
      assert(own(map.nodes, nodeId), '节点已删除')
      if (field.startsWith('marker:')) {
        const category = field.slice(7) as 'flag'
        assert(['priority', 'progress', 'flag'].includes(category), '标记类别不合法')
        if (after === null) delete map.nodes[nodeId].markers[category]
        else map.nodes[nodeId].markers[category] = after as string
      } else {
        assert((nodeFields as readonly string[]).includes(field), '节点字段不合法')
        Object.assign(map.nodes[nodeId], { [field]: clone(after) })
      }
    }
    map.updatedAt = now
  }
  validateSpace(next)
  return next
}
export interface UndoEntry {
  forward: Change[]
  inverse: Change[]
}
export function undoEntry(changes: Change[]): UndoEntry {
  const forward = changes.filter(
    (change) => !['history', 'history-add', 'historyDirtySince'].includes(change.field),
  )
  return {
    forward: clone(forward),
    inverse: [...forward]
      .reverse()
      .map((change) => ({ ...clone(change), before: change.after, after: change.before })),
  }
}
export function guardedChanges(space: Space, changes: Change[]) {
  // 只修改仍等于本机写入值的字段，防止撤销覆盖远端更新。
  return changes.filter((change) => equal(readField(space, change), change.before))
}
