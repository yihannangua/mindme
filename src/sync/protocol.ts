import { applyChanges, readField } from '../domain/operations'
import {
  clone,
  emptySpace,
  equal,
  own,
  safeId,
  type Change,
  type Operation,
  type Space,
  type Stamp,
} from '../domain/types'

export type ResultStatus = 'accepted' | 'stale' | 'conflict' | 'rejected'
export interface OperationResult {
  opId: string
  status: ResultStatus
  reason?: string
  seq: number
}
export interface ServerState {
  schemaVersion: 1
  space: Space
  seq: number
  versions: Record<string, { stamp: Stamp; seq: number }>
  tombstones: Record<string, { seq: number; stamp: Stamp }>
  results: Record<string, OperationResult>
}
export interface SyncResponse {
  schemaVersion: 1
  space: Space | null
  changes?: Change[]
  baseSeq?: number
  seq: number
  results: OperationResult[]
  serverTime: number
  subject: string
}
export const newServerState = (): ServerState => ({
  schemaVersion: 1,
  space: emptySpace(),
  seq: 0,
  versions: {},
  tombstones: {},
  results: {},
})
export const fieldKey = (change: Change) => `${change.mapId}/${change.nodeId ?? ''}/${change.field}`
export function orderStamp(a: Stamp, b: Stamp): 'newer' | 'older' | 'unknown' {
  if (a.deviceId === b.deviceId) return a.deviceSeq > b.deviceSeq ? 'newer' : 'older'
  if (a.at - a.uncertainty > b.at + b.uncertainty) return 'newer'
  if (a.at + a.uncertainty < b.at - b.uncertainty) return 'older'
  return 'unknown'
}
export function validateOperation(op: Operation): boolean {
  return (
    !!op &&
    op.schemaVersion === 1 &&
    (op.intent === undefined || ['edit', 'undo', 'bootstrap', 'restore'].includes(op.intent)) &&
    safeId(op.opId) &&
    !!op.stamp &&
    safeId(op.stamp.deviceId) &&
    Number.isSafeInteger(op.stamp.deviceSeq) &&
    op.stamp.deviceSeq > 0 &&
    Number.isFinite(op.stamp.at) &&
    op.stamp.at >= 0 &&
    Number.isFinite(op.stamp.uncertainty) &&
    op.stamp.uncertainty >= 0 &&
    Number.isSafeInteger(op.baseRevision) &&
    op.baseRevision >= 0 &&
    Array.isArray(op.changes) &&
    op.changes.length > 0 &&
    op.changes.length <= 30000 &&
    op.changes.every(
      (c) =>
        c &&
        safeId(c.mapId) &&
        (c.nodeId === undefined || safeId(c.nodeId)) &&
        typeof c.field === 'string' &&
        (c.nodeId
          ? [
              '$node',
              'parentId',
              'order',
              'text',
              'collapsed',
              'position',
              'side',
              'marker:priority',
              'marker:progress',
              'marker:flag',
            ]
          : [
              '$map',
              '$tab',
              'title',
              'deletedAt',
              'history',
              'history-add',
              'historyDirtySince',
              'tab:open',
              'tab:pinned',
              'tab:order',
            ]
        ).includes(c.field),
    )
  )
}
export function mergeOperation(
  input: ServerState,
  op: Operation,
  now: number,
): { state: ServerState; result: OperationResult } {
  if (op && own(input.results, op.opId)) return { state: input, result: input.results[op.opId] }
  const state = clone(input)
  const finish = (status: ResultStatus, reason?: string) => {
    const result: OperationResult = { opId: op?.opId ?? '', status, reason, seq: state.seq }
    if (safeId(result.opId)) state.results[result.opId] = result
    return { state, result }
  }
  if (
    !validateOperation(op) ||
    op.baseRevision > state.seq ||
    op.stamp.at - op.stamp.uncertainty > now + 30000
  )
    return finish('rejected', '操作格式、修订号或设备时间不合法')
  const accepted: Change[] = []
  for (const change of op.changes) {
    const map = state.space.maps[change.mapId]
    const deletion = change.nodeId
      ? state.tombstones[`${change.mapId}/${change.nodeId}`]
      : undefined
    const explicitRestore =
      !!deletion &&
      change.field === '$node' &&
      change.after !== null &&
      ['undo', 'restore'].includes(op.intent ?? '') &&
      (op.baseRevision >= deletion.seq ||
        (op.stamp.deviceId === deletion.stamp.deviceId &&
          op.stamp.deviceSeq > deletion.stamp.deviceSeq))
    const tombstone =
      state.tombstones[change.mapId] ||
      (deletion &&
        !explicitRestore &&
        (!map?.nodes[change.nodeId!] ||
          (op.baseRevision < deletion.seq &&
            !(
              op.stamp.deviceId === deletion.stamp.deviceId &&
              op.stamp.deviceSeq > deletion.stamp.deviceSeq
            ))))
    if (tombstone) return finish('conflict', '内容已被永久删除，离线文字已保留为草稿')
    if (
      map?.deletedAt !== null &&
      map?.deletedAt !== undefined &&
      !(
        op.changes.some((c) => c.mapId === map.id && c.field === 'deletedAt' && c.after === null) ||
        op.changes.some((c) => c.mapId === map.id && c.field === '$map' && c.after === null)
      )
    )
      return finish('conflict', '脑图已移入回收站，离线修改已保留为草稿')
    if (map && change.field === 'history-add') {
      const item = change.after as { id?: unknown; at?: unknown; content?: unknown }
      if (!item || typeof item.id !== 'string' || !Number.isFinite(item.at) || !item.content)
        return finish('rejected', '历史版本格式不合法')
      if (map.history.some((version) => version.id === item.id)) continue
      const duplicate = map.history.find(
        (version) =>
          version.at === item.at &&
          version.reason === (item as { reason?: unknown }).reason &&
          equal(version.content, (item as { content: unknown }).content),
      )
      if (duplicate) continue
      accepted.push(change)
      continue
    }
    if (map && change.field === 'history' && Array.isArray(change.after)) {
      const versions = new Map(map.history.map((version) => [version.id, version]))
      for (const item of change.after) {
        if (!item || typeof item.id !== 'string') return finish('rejected', '历史版本格式不合法')
        if (!versions.has(item.id)) versions.set(item.id, item)
      }
      const normalized = [...versions.values()]
        .sort((a, b) => a.at - b.at)
        .filter(
          (version, index, all) =>
            index === 0 ||
            version.reason === 'restore' ||
            !equal(version.content, all[index - 1].content),
        )
        .slice(-10)
      const oldIds = new Set(map.history.map((version) => version.id))
      const seenContents = map.history.map((version) => version.content)
      for (const version of normalized)
        if (
          !oldIds.has(version.id) &&
          !seenContents.some((content) => equal(content, version.content))
        ) {
          accepted.push({ mapId: change.mapId, field: 'history-add', before: null, after: version })
          seenContents.push(version.content)
        }
      continue
    }
    if (map && change.field === 'historyDirtySince') {
      accepted.push({
        ...change,
        after:
          typeof change.after === 'number'
            ? Math.min(map.historyDirtySince ?? Infinity, change.after)
            : map.revision > op.baseRevision
              ? map.historyDirtySince
              : null,
      })
      continue
    }
    const version = state.versions[fieldKey(change)]
    if (
      version &&
      op.baseRevision < version.seq &&
      !(change.after === null && ['$map', '$node'].includes(change.field))
    ) {
      const order = orderStamp(op.stamp, version.stamp)
      if (order === 'unknown')
        return finish('conflict', '两台设备的修改时间区间重叠，无法确定先后，已保留草稿')
      if (order === 'older') {
        if (!equal(readField(state.space, change), change.after))
          return finish('stale', '较早的离线修改未覆盖较新的内容，已保留草稿')
        continue
      }
    }
    if (change.field === '$map' && change.after !== null && map)
      return finish('conflict', '脑图标识已存在')
    if (change.field === '$node' && change.after !== null && map?.nodes[change.nodeId!])
      return finish('conflict', '节点标识已存在')
    accepted.push(change)
  }
  try {
    state.space = applyChanges(state.space, accepted, now)
    state.seq++
    for (const change of accepted) {
      state.versions[fieldKey(change)] = { stamp: clone(op.stamp), seq: state.seq }
      // 创建也登记每个字段的版本，避免晚到旧编辑覆盖首次创建。
      if (change.field === '$node' && change.after && change.nodeId)
        for (const field of [
          'text',
          'parentId',
          'order',
          'collapsed',
          'position',
          'side',
          'marker:priority',
          'marker:progress',
          'marker:flag',
        ])
          state.versions[fieldKey({ ...change, field })] = {
            stamp: clone(op.stamp),
            seq: state.seq,
          }
      if (change.after === null && change.field === '$map')
        state.tombstones[change.mapId] = { seq: state.seq, stamp: clone(op.stamp) }
      if (change.after === null && change.field === '$node')
        state.tombstones[`${change.mapId}/${change.nodeId}`] = {
          seq: state.seq,
          stamp: clone(op.stamp),
        }
      if (state.space.maps[change.mapId]) state.space.maps[change.mapId].revision = state.seq
    }
    return finish('accepted')
  } catch (error) {
    return {
      state: {
        ...input,
        results: {
          ...input.results,
          [op.opId]: {
            opId: op.opId,
            status: 'rejected',
            seq: input.seq,
            reason: error instanceof Error ? error.message : '结构校验失败',
          },
        },
      },
      result: {
        opId: op.opId,
        status: 'rejected',
        seq: input.seq,
        reason: error instanceof Error ? error.message : '结构校验失败',
      },
    }
  }
}
export function retryDelay(attempt: number, random = 0.5, retryAfterMs = 0) {
  return Math.max(
    retryAfterMs,
    Math.min(30000, 1000 * 2 ** Math.min(attempt, 5)) * (0.8 + random * 0.4),
  )
}
export function errorClass(status: number) {
  return status === 401 || status === 403
    ? 'unauthorized'
    : status === 429 || status >= 500
      ? 'retry'
      : 'attention'
}
