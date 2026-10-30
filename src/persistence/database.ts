import { validateSpace } from '../domain/model'
import {
  assert,
  clone,
  equal,
  SCHEMA_VERSION,
  type LocalSnapshot,
  type Space,
} from '../domain/types'

export const DB_VERSION = 1
const STORES = [
  'maps',
  'nodes',
  'markers',
  'tabs',
  'snapshots',
  'trash',
  'outbox',
  'metadata',
  'quarantine',
] as const
export class LocalDatabase {
  private generation = 0
  private lastSaved: LocalSnapshot | null = null
  private lastServerSpace: Space | undefined
  private constructor(private db: IDBDatabase) {}
  static open(name = 'mindme.v1'): Promise<LocalDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(name, DB_VERSION)
      request.onupgradeneeded = () => {
        for (const name of STORES)
          if (!request.result.objectStoreNames.contains(name))
            request.result.createObjectStore(name)
      }
      request.onsuccess = () => {
        const database = new LocalDatabase(request.result)
        request.result.onversionchange = () => database.close()
        resolve(database)
      }
      request.onerror = () => reject(request.error ?? new Error('无法打开本地数据库'))
      request.onblocked = () => reject(new Error('数据库升级被其他标签页阻塞，请关闭旧页面后重试'))
    })
  }
  close() {
    this.db.close()
  }
  async load(): Promise<LocalSnapshot | null> {
    const { generation, value } = await new Promise<{
      generation: number
      value: LocalSnapshot | undefined
    }>((resolve, reject) => {
      const tx = this.db.transaction('metadata', 'readonly')
      const store = tx.objectStore('metadata')
      const generation = store.get('generation'),
        value = store.get('snapshot')
      tx.oncomplete = () =>
        resolve({ generation: Number(generation.result ?? 0), value: value.result })
      tx.onabort = () => reject(tx.error ?? new Error('读取本地快照失败'))
    })
    this.generation = generation
    if (!value) return null
    try {
      validateSnapshot(value)
      this.lastSaved = clone({ ...value, serverSpace: undefined })
      this.lastServerSpace = value.serverSpace
      return value
    } catch (error) {
      await new Promise<void>((resolve, reject) => {
        const tx = this.db.transaction('quarantine', 'readwrite')
        tx.objectStore('quarantine').put(
          { value, reason: error instanceof Error ? error.message : '未知错误' },
          `snapshot-${Date.now()}`,
        )
        tx.oncomplete = () => resolve()
        tx.onabort = () => reject(tx.error)
      })
      throw new Error('本地快照损坏，已隔离保留原始数据。请先导出隔离数据或恢复备份，避免覆盖')
    }
  }
  get(store: (typeof STORES)[number], key: IDBValidKey): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store)
      const request = tx.objectStore(store).get(key)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  }
  saveDraft(draft: LocalSnapshot['editorDraft'] | null): Promise<void> {
    assert(this.lastSaved, '尚无已保存的本地快照，无法单独保存草稿')
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('metadata', 'readwrite')
      const store = tx.objectStore('metadata')
      let conflict = false
      const generation = store.get('generation')
      generation.onsuccess = () => {
        if (Number(generation.result ?? 0) !== this.generation) {
          conflict = true
          tx.abort()
        }
      }
      const snapshot = { ...this.lastSaved!, serverSpace: this.lastServerSpace }
      if (draft) snapshot.editorDraft = draft
      else delete snapshot.editorDraft
      // 草稿写入旧版同样认识的完整快照；代次与快照在同一事务提交。
      store.put(this.generation + 1, 'generation')
      store.put(snapshot, 'snapshot')
      tx.oncomplete = () => {
        this.generation++
        if (draft) this.lastSaved!.editorDraft = clone(draft)
        else delete this.lastSaved!.editorDraft
        resolve()
      }
      tx.onabort = () =>
        reject(
          conflict
            ? new Error('其他页面已修改本地数据。请先导出当前草稿，再重新打开本页，避免覆盖')
            : (tx.error ?? new Error('本地保存失败，可能是磁盘空间不足或浏览器限制')),
        )
    })
  }
  save(snapshot: LocalSnapshot): Promise<void> {
    validateSnapshot(snapshot)
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(
        STORES.filter((name) => name !== 'quarantine'),
        'readwrite',
      )
      // 快照与 outbox 共用一次原子提交；任何写入失败均回滚。
      let conflict = false
      const generation = tx.objectStore('metadata').get('generation')
      generation.onsuccess = () => {
        if (Number(generation.result ?? 0) !== this.generation) {
          conflict = true
          tx.abort()
        }
      }
      tx.objectStore('metadata').put(this.generation + 1, 'generation')
      tx.objectStore('metadata').put(snapshot, 'snapshot')
      const before = this.lastSaved
      const syncRecords = <T>(
        store: (typeof STORES)[number],
        previous: Record<string, T>,
        current: Record<string, T>,
        key: (id: string) => IDBValidKey = (id) => id,
      ) => {
        const table = tx.objectStore(store)
        for (const id of Object.keys(previous))
          if (!Object.hasOwn(current, id)) table.delete(key(id))
        for (const [id, value] of Object.entries(current))
          if (!equal(previous[id], value)) table.put(value, key(id))
      }
      const maps = (value: LocalSnapshot | null) =>
        Object.fromEntries(
          Object.values(value?.space.maps ?? {}).map(
            ({ nodes: _nodes, history: _history, ...map }) => [map.id, map],
          ),
        )
      syncRecords('maps', maps(before), maps(snapshot))
      syncRecords('tabs', before?.space.tabs ?? {}, snapshot.space.tabs)
      syncRecords(
        'outbox',
        Object.fromEntries((before?.outbox ?? []).map((op) => [op.opId, op])),
        Object.fromEntries(snapshot.outbox.map((op) => [op.opId, op])),
      )
      const trash = (value: LocalSnapshot | null) =>
        Object.fromEntries(
          Object.values(value?.space.maps ?? {})
            .filter((map) => map.deletedAt !== null)
            .map((map) => [map.id, { mapId: map.id, deletedAt: map.deletedAt }]),
        )
      syncRecords('trash', trash(before), trash(snapshot))
      for (const mapId of new Set([
        ...Object.keys(before?.space.maps ?? {}),
        ...Object.keys(snapshot.space.maps),
      ])) {
        const previous = before?.space.maps[mapId],
          current = snapshot.space.maps[mapId]
        const key = (id: string) => [mapId, id]
        syncRecords('nodes', previous?.nodes ?? {}, current?.nodes ?? {}, key)
        const markers = (nodes: NonNullable<typeof previous>['nodes']) =>
          Object.fromEntries(Object.values(nodes).map((node) => [node.id, node.markers]))
        syncRecords('markers', markers(previous?.nodes ?? {}), markers(current?.nodes ?? {}), key)
        syncRecords(
          'snapshots',
          Object.fromEntries((previous?.history ?? []).map((version) => [version.id, version])),
          Object.fromEntries((current?.history ?? []).map((version) => [version.id, version])),
          key,
        )
      }
      tx.oncomplete = () => {
        this.generation++
        this.lastSaved = clone({ ...snapshot, serverSpace: undefined })
        this.lastServerSpace = snapshot.serverSpace
        resolve()
      }
      tx.onerror = () => {
        /* 等待 abort，确保不会在回滚前报告成功。 */
      }
      tx.onabort = () =>
        reject(
          conflict
            ? new Error('其他页面已修改本地数据。请先导出当前草稿，再重新打开本页，避免覆盖')
            : (tx.error ?? new Error('本地保存失败，可能是磁盘空间不足或浏览器限制')),
        )
    })
  }
}
export function validateSnapshot(value: LocalSnapshot) {
  assert(
    value &&
      value.schemaVersion === SCHEMA_VERSION &&
      typeof value.deviceId === 'string' &&
      Number.isInteger(value.deviceSeq) &&
      value.deviceSeq >= 0 &&
      Number.isInteger(value.serverSeq) &&
      value.serverSeq >= 0 &&
      (value.ownerSub === null || typeof value.ownerSub === 'string'),
    '本地快照版本或设备信息不支持',
  )
  validateSpace(value.space)
  if (value.serverSpace) validateSpace(value.serverSpace)
  assert(Array.isArray(value.outbox) && Array.isArray(value.drafts), '本地队列格式错误')
  for (const op of value.outbox)
    assert(
      op.schemaVersion === 1 &&
        typeof op.opId === 'string' &&
        Array.isArray(op.changes) &&
        op.stamp &&
        ['pending', 'sending', 'confirmed', 'retry', 'attention', 'discarded'].includes(op.state),
      '离线操作格式错误',
    )
}
