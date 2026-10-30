import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { LocalDatabase, validateSnapshot } from '../../src/persistence/database'
import { emptySpace, LIMITS, type LocalSnapshot } from '../../src/domain/types'
import { first, operation, seed } from '../helpers'
const snapshot = (): LocalSnapshot => {
  const space = seed()
  return {
    schemaVersion: 1,
    space,
    outbox: [operation(emptySpace(), space)],
    drafts: [],
    deviceId: 'device-a',
    deviceSeq: 1,
    serverSeq: 0,
    ownerSub: null,
  }
}
const openRaw = (name: string) =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
describe('IndexedDB 本地事务与恢复', () => {
  it('轻量草稿保存不改空间和队列，重开后恢复，完整保存原子清理', async () => {
    const name = crypto.randomUUID(),
      db = await LocalDatabase.open(name),
      value = snapshot()
    const map = first(value.space)
    value.serverSpace = structuredClone(value.space)
    await db.save(value)
    const draft = {
      mapId: map.id,
      nodeId: map.rootId,
      text: '待恢复文字',
      original: map.title,
      at: 1234,
    }
    await db.saveDraft(draft)
    const reopened = await LocalDatabase.open(name)
    expect((await reopened.load())?.editorDraft).toEqual(draft)
    expect((await reopened.load())?.outbox).toEqual(value.outbox)
    expect((await reopened.load())?.serverSpace).toEqual(value.serverSpace)
    const committed = structuredClone(value)
    committed.space.maps[map.id].title = '已确认文字'
    committed.space.maps[map.id].nodes[map.rootId].text = '已确认文字'
    await reopened.save(committed)
    expect((await reopened.load())?.editorDraft).toBeUndefined()
    expect((await reopened.load())?.space.maps[map.id].title).toBe('已确认文字')
    reopened.close()
    db.close()
  })
  it('超长草稿不被当作损坏数据，重开时完整保留', async () => {
    const name = crypto.randomUUID(),
      db = await LocalDatabase.open(name),
      value = snapshot(),
      map = first(value.space)
    await db.save(value)
    const draft = {
      mapId: map.id,
      nodeId: map.rootId,
      text: '长'.repeat(LIMITS.text + 1),
      original: map.title,
      at: 1234,
    }
    await db.saveDraft(draft)
    db.close()
    const reopened = await LocalDatabase.open(name)
    expect((await reopened.load())?.editorDraft).toEqual(draft)
    reopened.close()
  })
  it('草稿事务中止不改变上一次草稿、完整快照或待同步队列', async () => {
    const name = crypto.randomUUID(),
      db = await LocalDatabase.open(name),
      value = snapshot(),
      map = first(value.space)
    await db.save(value)
    const draft = {
      mapId: map.id,
      nodeId: map.rootId,
      text: '已保存草稿',
      original: map.title,
      at: 1,
    }
    await db.saveDraft(draft)
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'metadata' && args[1] === 'snapshot') {
        this.transaction.abort()
      }
      return put.apply(this, args)
    }
    try {
      await expect(db.saveDraft({ ...draft, text: '保存失败的草稿' })).rejects.toBeDefined()
    } finally {
      IDBObjectStore.prototype.put = put
    }
    db.close()
    const reopened = await LocalDatabase.open(name),
      recovered = await reopened.load()
    expect(recovered?.editorDraft).toEqual(draft)
    expect(recovered?.space).toEqual(value.space)
    expect(recovered?.outbox).toEqual(value.outbox)
    await reopened.saveDraft({ ...draft, text: '重试后草稿' })
    reopened.close()
    const next = await LocalDatabase.open(name)
    expect((await next.load())?.editorDraft?.text).toBe('重试后草稿')
    next.close()
  })
  it('草稿轻量事务仍检查代次，不覆盖其他页面写入', async () => {
    const name = crypto.randomUUID(),
      a = await LocalDatabase.open(name),
      b = await LocalDatabase.open(name),
      value = snapshot()
    await a.save(value)
    await b.load()
    await a.saveDraft(null)
    await expect(
      b.saveDraft({
        mapId: first(value.space).id,
        nodeId: first(value.space).rootId,
        text: '不覆盖',
        original: '测试脑图',
        at: 1,
      }),
    ).rejects.toThrow('其他页面')
    expect((await a.load())?.editorDraft).toBeUndefined()
    a.close()
    b.close()
  })
  it('旧版页面能从完整快照读取草稿，写入后新版读取旧版结果', async () => {
    const name = crypto.randomUUID(),
      db = await LocalDatabase.open(name),
      value = snapshot(),
      map = first(value.space)
    await db.save(value)
    await db.saveDraft({
      mapId: map.id,
      nodeId: map.rootId,
      text: '兼容草稿',
      original: map.title,
      at: 1234,
    })
    const raw = await openRaw(name)
    const oldSnapshot = await new Promise<LocalSnapshot>((resolve, reject) => {
      const tx = raw.transaction('metadata', 'readonly')
      const read = tx.objectStore('metadata').get('snapshot')
      tx.oncomplete = () => resolve(read.result)
      tx.onabort = () => reject(tx.error)
    })
    expect(oldSnapshot.editorDraft?.text).toBe('兼容草稿')
    oldSnapshot.space.maps[map.id].title = '旧版已恢复'
    oldSnapshot.space.maps[map.id].nodes[map.rootId].text = '旧版已恢复'
    delete oldSnapshot.editorDraft
    await new Promise<void>((resolve, reject) => {
      const tx = raw.transaction('metadata', 'readwrite')
      tx.objectStore('metadata').put(3, 'generation')
      tx.objectStore('metadata').put(oldSnapshot, 'snapshot')
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(tx.error)
    })
    raw.close()
    db.close()
    const reopened = await LocalDatabase.open(name),
      recovered = await reopened.load()
    expect(recovered?.space.maps[map.id].title).toBe('旧版已恢复')
    expect(recovered?.editorDraft).toBeUndefined()
    reopened.close()
  })
  it('首次安装建立版本化 stores，刷新恢复快照与待提交队列', async () => {
    const name = crypto.randomUUID(),
      db = await LocalDatabase.open(name),
      source = snapshot()
    expect(await db.load()).toBeNull()
    await db.save(source)
    db.close()
    const reopened = await LocalDatabase.open(name)
    expect(await reopened.load()).toEqual(source)
    expect(await reopened.get('outbox', source.outbox[0].opId)).toEqual(source.outbox[0])
    expect(
      await reopened.get('nodes', [first(source.space).id, first(source.space).rootId]),
    ).toMatchObject({ text: '测试脑图' })
    reopened.close()
  })
  it('重复写入是幂等的，主动关闭标签在恢复后保持关闭', async () => {
    const db = await LocalDatabase.open(crypto.randomUUID()),
      value = snapshot()
    value.space.tabs[first(value.space).id].open = false
    await db.save(value)
    await db.save(value)
    expect(await db.load()).toEqual(value)
    db.close()
  })
  it('损坏快照保留原文并隔离，不能当作首次安装覆盖', async () => {
    const name = crypto.randomUUID(),
      db = await LocalDatabase.open(name),
      value = snapshot()
    await db.save(value)
    const raw = await openRaw(name)
    await new Promise<void>((resolve) => {
      const tx = raw.transaction('metadata', 'readwrite')
      tx.objectStore('metadata').put({ schemaVersion: 999 }, 'snapshot')
      tx.oncomplete = () => resolve()
    })
    await expect(db.load()).rejects.toThrow('已隔离')
    expect(await db.get('metadata', 'snapshot')).toEqual({ schemaVersion: 999 })
    raw.close()
    db.close()
  })
  it('无效版本和孤立数据写入前拒绝，不损坏旧快照', async () => {
    const db = await LocalDatabase.open(crypto.randomUUID()),
      value = snapshot()
    await db.save(value)
    const invalid = structuredClone(value)
    invalid.space.maps[first(value.space).id].rootId = 'missing'
    expect(() => db.save(invalid)).toThrow()
    expect(await db.load()).toEqual(value)
    expect(() =>
      validateSnapshot({ ...value, schemaVersion: 999 } as unknown as LocalSnapshot),
    ).toThrow()
    db.close()
  })
  it('事务中途配额失败时快照与 outbox 一起回滚', async () => {
    const db = await LocalDatabase.open(crypto.randomUUID()),
      value = snapshot()
    await db.save(value)
    const original = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'outbox') {
        this.transaction.abort()
        return original.apply(this, args)
      }
      return original.apply(this, args)
    }
    const next = structuredClone(value)
    next.deviceSeq = 10
    next.outbox[0].attempts = 1
    try {
      await expect(db.save(next)).rejects.toBeDefined()
    } finally {
      IDBObjectStore.prototype.put = original
    }
    expect(await db.load()).toEqual(value)
    db.close()
  })
})
it('旧页面写入被数据库代次校验拒绝，不覆盖新页面的数据', async () => {
  const name = crypto.randomUUID(),
    a = await LocalDatabase.open(name),
    b = await LocalDatabase.open(name),
    value = snapshot()
  await a.save(value)
  await b.load()
  const next = structuredClone(value)
  next.deviceSeq++
  await a.save(next)
  const stale = structuredClone(value)
  stale.deviceSeq += 10
  await expect(b.save(stale)).rejects.toThrow('其他页面')
  expect(await a.load()).toEqual(next)
  a.close()
  b.close()
})
