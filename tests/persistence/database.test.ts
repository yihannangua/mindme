import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { LocalDatabase, validateSnapshot } from '../../src/persistence/database'
import { emptySpace, type LocalSnapshot } from '../../src/domain/types'
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
