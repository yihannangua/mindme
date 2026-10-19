import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppStore } from '../../src/app/store'
import { children, createMap } from '../../src/domain/model'
import { execute } from '../../src/domain/commands'
import { importDrafts } from '../../src/importers/backup'
import { parseOutline } from '../../src/importers/outline'
import { emptySpace } from '../../src/domain/types'
import { mergeOperation, newServerState } from '../../src/sync/protocol'
import { LocalDatabase } from '../../src/persistence/database'
import { ctx, first, operation } from '../helpers'
// 每个实例使用独立数据库，覆盖恢复、排队和云端确认间的竞态。
beforeEach(() => {
  vi.restoreAllMocks()
  const open = LocalDatabase.open
  const name = crypto.randomUUID()
  vi.spyOn(LocalDatabase, 'open').mockImplementation(() => open.call(LocalDatabase, name))
})
describe('应用状态与保存确认', () => {
  it('串行提交不会丢失连续编辑，撤销重做按脑图隔离', async () => {
    const store = new AppStore()
    await store.init()
    const map = first(store.getSnapshot().snapshot!.space)
    store.setActive(map.id)
    await Promise.all([
      store.command(map.id, { type: 'add', nodeId: map.rootId, kind: 'child', text: '一' }),
      store.command(map.id, { type: 'add', nodeId: map.rootId, kind: 'child', text: '二' }),
    ])
    const state = store.getSnapshot()
    expect(state.status).toBe('saved')
    expect(
      children(first(state.snapshot!.space), map.rootId)
        .slice(-2)
        .map((n) => n.text),
    ).toEqual(['一', '二'])
    await store.history(map.id, 'undo')
    expect(children(first(store.getSnapshot().snapshot!.space), map.rootId).at(-1)?.text).toBe('一')
    await store.history(map.id, 'redo')
    expect(children(first(store.getSnapshot().snapshot!.space), map.rootId).at(-1)?.text).toBe('二')
    await store.transform((space) => createMap(space, '另一个图', ctx()), undefined, false)
    store.setActive(Object.keys(store.getSnapshot().snapshot!.space.maps).at(-1)!)
    expect(store.getSnapshot().canUndo).toBe(false)
  })
  it('整图自动布局作为一次操作保存并可撤销重做，重复执行不增加队列', async () => {
    const store = new AppStore()
    await store.init()
    const mapId = first(store.getSnapshot().snapshot!.space).id
    store.setActive(mapId)
    await store.transform((space) => {
      for (const node of Object.values(space.maps[mapId].nodes)) {
        node.position = { x: 200, y: 50 }
        if (node.parentId) node.side = 1
      }
      return space
    }, mapId)
    const before = structuredClone(store.getSnapshot().snapshot!.space.maps[mapId].nodes),
      queued = store.getSnapshot().snapshot!.outbox.length
    await store.command(mapId, { type: 'layout' })
    const after = structuredClone(store.getSnapshot().snapshot!.space.maps[mapId].nodes)
    expect(after).not.toEqual(before)
    expect(store.getSnapshot().snapshot!.outbox).toHaveLength(queued + 1)
    await store.history(mapId, 'undo')
    expect(store.getSnapshot().snapshot!.space.maps[mapId].nodes).toEqual(before)
    await store.history(mapId, 'redo')
    expect(store.getSnapshot().snapshot!.space.maps[mapId].nodes).toEqual(after)
    const repeatedQueue = store.getSnapshot().snapshot!.outbox.length
    await store.command(mapId, { type: 'layout' })
    expect(store.getSnapshot().snapshot!.outbox).toHaveLength(repeatedQueue)
    const reopened = new AppStore()
    await reopened.init()
    expect(reopened.getSnapshot().snapshot!.space.maps[mapId].nodes).toEqual(after)
  })
  it('粘贴到折叠节点只新增内容，一次撤销重做和重开数据库均保留折叠', async () => {
    const store = new AppStore()
    await store.init()
    const map = first(store.getSnapshot().snapshot!.space),
      target = children(map, map.rootId)[0]
    store.setActive(map.id)
    await store.command(map.id, { type: 'add', nodeId: target.id, kind: 'child', text: '原有孩子' })
    await store.command(map.id, { type: 'fold', nodeId: target.id, value: true })
    const before = structuredClone(store.getSnapshot().snapshot!),
      result = parseOutline('# 粘贴内容\n- 粘贴后代')
    await store.transform(
      (space) => importDrafts(space, result, ctx(), { mapId: map.id, nodeId: target.id }),
      map.id,
      true,
      true,
    )
    const after = structuredClone(store.getSnapshot().snapshot!)
    expect(after.space.maps[map.id].nodes[target.id].collapsed).toBe(true)
    expect(children(after.space.maps[map.id], target.id).map((node) => node.text)).toEqual([
      '原有孩子',
      '粘贴内容',
    ])
    expect(after.outbox).toHaveLength(before.outbox.length + 1)
    expect(after.outbox.at(-1)!.changes.some((change) => change.field === 'collapsed')).toBe(false)
    await store.history(map.id, 'undo')
    expect(store.getSnapshot().snapshot!.space.maps[map.id].nodes).toEqual(
      before.space.maps[map.id].nodes,
    )
    await store.history(map.id, 'redo')
    expect(store.getSnapshot().snapshot!.space.maps[map.id].nodes).toEqual(
      after.space.maps[map.id].nodes,
    )
    const reopened = new AppStore()
    await reopened.init()
    expect(reopened.getSnapshot().snapshot!.space.maps[map.id].nodes).toEqual(
      after.space.maps[map.id].nodes,
    )
  })
  it('批量挂接一次保存全部分支，一次撤销重做并可从数据库恢复', async () => {
    const store = new AppStore()
    await store.init()
    const map = first(store.getSnapshot().snapshot!.space),
      [a, b, target] = children(map, map.rootId)
    store.setActive(map.id)
    const before = structuredClone(map.nodes),
      queued = store.getSnapshot().snapshot!.outbox.length
    await store.command(map.id, {
      type: 'reparent-many',
      nodeIds: [a.id, b.id],
      parentId: target.id,
    })
    const after = structuredClone(store.getSnapshot().snapshot!.space.maps[map.id].nodes)
    expect(after[a.id].parentId).toBe(target.id)
    expect(after[b.id].parentId).toBe(target.id)
    expect(store.getSnapshot().snapshot!.outbox).toHaveLength(queued + 1)
    await store.history(map.id, 'undo')
    expect(store.getSnapshot().snapshot!.space.maps[map.id].nodes).toEqual(before)
    await store.history(map.id, 'redo')
    expect(store.getSnapshot().snapshot!.space.maps[map.id].nodes).toEqual(after)
    const reopened = new AppStore()
    await reopened.init()
    expect(reopened.getSnapshot().snapshot!.space.maps[map.id].nodes).toEqual(after)
    const beforeFailure = structuredClone(store.getSnapshot().snapshot!)
    await expect(
      store.command(map.id, { type: 'reparent-many', nodeIds: [a.id, target.id], parentId: b.id }),
    ).rejects.toThrow('后代')
    expect(store.getSnapshot().snapshot).toEqual(beforeFailure)
  })
  it.each(['single', 'many'] as const)(
    '挂接 %s 至折叠节点一次撤销重做并从数据库恢复',
    async (mode) => {
      const store = new AppStore()
      await store.init()
      const map = first(store.getSnapshot().snapshot!.space),
        [a, b, target] = children(map, map.rootId)
      store.setActive(map.id)
      await store.command(map.id, {
        type: 'add',
        nodeId: target.id,
        kind: 'child',
        text: '目标已有孩子',
      })
      await store.command(map.id, { type: 'fold', nodeId: target.id, value: true })
      const before = structuredClone(store.getSnapshot().snapshot!)
      await store.command(
        map.id,
        mode === 'single'
          ? { type: 'reparent', nodeId: a.id, parentId: target.id }
          : { type: 'reparent-many', nodeIds: [a.id, b.id], parentId: target.id },
      )
      const after = structuredClone(store.getSnapshot().snapshot!)
      expect(after.space.maps[map.id].nodes[target.id].collapsed).toBe(true)
      expect(after.space.maps[map.id].nodes[a.id].parentId).toBe(target.id)
      expect(after.outbox).toHaveLength(before.outbox.length + 1)
      expect(after.outbox.at(-1)!.changes.some((change) => change.field === 'collapsed')).toBe(
        false,
      )
      await store.history(map.id, 'undo')
      expect(store.getSnapshot().snapshot!.space.maps[map.id].nodes).toEqual(
        before.space.maps[map.id].nodes,
      )
      await store.history(map.id, 'redo')
      expect(store.getSnapshot().snapshot!.space.maps[map.id].nodes).toEqual(
        after.space.maps[map.id].nodes,
      )
      const reopened = new AppStore()
      await reopened.init()
      expect(reopened.getSnapshot().snapshot!.space.maps[map.id].nodes).toEqual(
        after.space.maps[map.id].nodes,
      )
    },
  )
  it('本地保存失败保留内存与队列，不能显示已保存，重试后恢复', async () => {
    const store = new AppStore()
    await store.init()
    const map = first(store.getSnapshot().snapshot!.space)
    const save = LocalDatabase.prototype.save
    LocalDatabase.prototype.save = async () => {
      throw new Error('测试配额不足')
    }
    try {
      await expect(
        store.command(map.id, { type: 'text', nodeId: map.rootId, text: '内存草稿' }),
      ).rejects.toThrow('配额')
      expect(store.getSnapshot().status).toBe('error')
      expect(first(store.getSnapshot().snapshot!.space).title).toBe('内存草稿')
      expect(store.hasUnpersisted).toBe(true)
    } finally {
      LocalDatabase.prototype.save = save
    }
    await store.retrySave()
    expect(store.getSnapshot().status).toBe('saved')
    expect(store.getSnapshot().snapshot!.outbox).toHaveLength(2)
  })
  it('回车提交文字与清理编辑草稿在同一事务中完成', async () => {
    const store = new AppStore()
    await store.init()
    const map = first(store.getSnapshot().snapshot!.space)
    await store.editorDraft({
      mapId: map.id,
      nodeId: map.rootId,
      text: '原子提交后的文字',
      original: map.nodes[map.rootId].text,
      at: Date.now(),
    })
    const save = LocalDatabase.prototype.save
    let release: (() => void) | undefined
    LocalDatabase.prototype.save = () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
    try {
      const commit = store.commitTextEdit(
        map.id,
        map.rootId,
        '原子提交后的文字',
        map.nodes[map.rootId].text,
      )
      await Promise.resolve()
      await Promise.resolve()
      expect(store.getSnapshot().snapshot!.space.maps[map.id].nodes[map.rootId].text).toBe(
        '原子提交后的文字',
      )
      expect(store.getSnapshot().status).toBe('saving')
      release!()
      await commit
    } finally {
      LocalDatabase.prototype.save = save
    }
    const snapshot = store.getSnapshot().snapshot!
    expect(snapshot.space.maps[map.id].nodes[map.rootId].text).toBe('原子提交后的文字')
    expect(snapshot.editorDraft).toBeUndefined()
    expect(snapshot.outbox.at(-1)?.changes.some((change) => change.field === 'text')).toBe(true)
  })
  it('编辑确认不等待此前排队的本地草稿保存才更新画布快照', async () => {
    const store = new AppStore()
    await store.init()
    const map = first(store.getSnapshot().snapshot!.space),
      original = map.nodes[map.rootId].text
    const save = LocalDatabase.prototype.save
    const releases: Array<() => void> = []
    LocalDatabase.prototype.save = () =>
      new Promise<void>((resolve) => {
        releases.push(resolve)
      })
    try {
      const draftSave = store.editorDraft({
        mapId: map.id,
        nodeId: map.rootId,
        text: '正在输入的新文字',
        original,
        at: Date.now(),
      })
      await Promise.resolve()
      await Promise.resolve()
      expect(releases).toHaveLength(1)

      const commit = store.commitTextEdit(map.id, map.rootId, '正在输入的新文字', original)
      expect(store.getSnapshot().snapshot!.space.maps[map.id].nodes[map.rootId].text).toBe(
        '正在输入的新文字',
      )
      expect(store.getSnapshot().status).toBe('saving')

      releases[0]()
      await draftSave
      await Promise.resolve()
      await Promise.resolve()
      expect(releases).toHaveLength(2)
      releases[1]()
      await commit
      expect(store.getSnapshot().status).toBe('saved')
      expect(store.getSnapshot().snapshot!.editorDraft).toBeUndefined()
    } finally {
      LocalDatabase.prototype.save = save
      releases.forEach((release) => release())
    }
  })
  it('云端确认与新编辑交错时保留新操作，不丢失本地队列', async () => {
    const store = new AppStore()
    await store.init()
    let snapshot = store.getSnapshot().snapshot!,
      server = newServerState()
    const sent = snapshot.outbox[0],
      initial = mergeOperation(server, sent, Date.now())
    server = initial.state
    const map = first(snapshot.space)
    await store.command(map.id, { type: 'text', nodeId: map.rootId, text: '请求期间新编辑' })
    await store.acknowledge(
      {
        schemaVersion: 1,
        space: server.space,
        seq: server.seq,
        results: [initial.result],
        serverTime: Date.now(),
        subject: 'test-user',
      },
      [sent.opId],
    )
    snapshot = store.getSnapshot().snapshot!
    expect(snapshot.outbox).toHaveLength(1)
    expect(first(snapshot.space).title).toBe('请求期间新编辑')
    expect(snapshot.ownerSub).toBe('test-user')
  })
  it('永久删除后的离线修改进入草稿，不能假装同步成功', async () => {
    const store = new AppStore()
    await store.init()
    const source = store.getSnapshot().snapshot!,
      map = first(source.space)
    const initial = mergeOperation(newServerState(), source.outbox[0], Date.now())
    await store.acknowledge(
      {
        schemaVersion: 1,
        space: initial.state.space,
        seq: 1,
        results: [initial.result],
        serverTime: Date.now(),
        subject: 'test',
      },
      [source.outbox[0].opId],
    )
    await store.command(map.id, { type: 'text', nodeId: map.rootId, text: '离线草稿' })
    const pending = store.getSnapshot().snapshot!.outbox[0]
    const trash = execute(initial.state.space, map.id, { type: 'trash' }, ctx(3000)).space
    const deleted = mergeOperation(
      initial.state,
      operation(initial.state.space, trash, 'remote', Date.now(), 1, 1),
      Date.now(),
    )
    const rejected = mergeOperation(deleted.state, pending, Date.now())
    await store.acknowledge(
      {
        schemaVersion: 1,
        space: rejected.state.space,
        seq: rejected.state.seq,
        results: [rejected.result],
        serverTime: Date.now(),
        subject: 'test',
      },
      [pending.opId],
    )
    expect(store.getSnapshot().snapshot!.drafts).toHaveLength(1)
    expect(store.getSnapshot().snapshot!.outbox[0].state).toBe('attention')
  })
  it('空间身份不可被另一个账号覆盖', async () => {
    const store = new AppStore()
    await store.init()
    const snapshot = store.getSnapshot().snapshot!,
      initial = mergeOperation(newServerState(), snapshot.outbox[0], Date.now())
    await store.acknowledge(
      {
        schemaVersion: 1,
        space: initial.state.space,
        seq: 1,
        results: [initial.result],
        serverTime: Date.now(),
        subject: 'first-user',
      },
      [snapshot.outbox[0].opId],
    )
    await expect(
      store.acknowledge(
        {
          schemaVersion: 1,
          space: emptySpace(),
          seq: 2,
          results: [],
          serverTime: Date.now(),
          subject: 'other-user',
        },
        [],
      ),
    ).rejects.toThrow('其他账号')
    expect(first(store.getSnapshot().snapshot!.space).id).toBe(first(initial.state.space).id)
  })
})
it('首次绑定空云空间时持久化账号身份，允许随后提交初始数据', async () => {
  const store = new AppStore()
  await store.init()
  await store.acknowledge(
    {
      schemaVersion: 1,
      space: emptySpace(),
      seq: 0,
      results: [],
      serverTime: Date.now(),
      subject: 'new-account',
    },
    [],
  )
  expect(store.getSnapshot().snapshot!.ownerSub).toBe('new-account')
  expect(store.getSnapshot().snapshot!.outbox).toHaveLength(1)
})
it('增量拉取在已确认基线上重放，不把本机未确认字段写进云端基线', async () => {
  const store = new AppStore()
  await store.init()
  const snapshot = store.getSnapshot().snapshot!,
    initial = mergeOperation(newServerState(), snapshot.outbox[0], Date.now())
  await store.acknowledge(
    {
      schemaVersion: 1,
      space: initial.state.space,
      seq: 1,
      results: [initial.result],
      serverTime: Date.now(),
      subject: 'test',
    },
    [snapshot.outbox[0].opId],
  )
  const map = first(initial.state.space),
    child = children(map, map.rootId)[0]
  await store.command(map.id, { type: 'text', nodeId: child.id, text: '本机未确认' })
  const remote = execute(
    initial.state.space,
    map.id,
    { type: 'marker', nodeId: child.id, category: 'flag', value: 'blue' },
    ctx(),
  ).space
  const changes = operation(initial.state.space, remote).changes
  await store.acknowledge(
    {
      schemaVersion: 1,
      space: null,
      changes,
      baseSeq: 1,
      seq: 2,
      results: [],
      serverTime: Date.now(),
      subject: 'test',
    },
    [],
  )
  const result = store.getSnapshot().snapshot!
  expect(result.space.maps[map.id].nodes[child.id]).toMatchObject({
    text: '本机未确认',
    markers: { flag: 'blue' },
  })
  expect(result.serverSpace!.maps[map.id].nodes[child.id].text).toBe(child.text)
  expect(result.outbox).toHaveLength(1)
})
it('导入与历史恢复等原子操作保存失败时，保持原内容和原队列', async () => {
  const store = new AppStore()
  await store.init()
  const source = structuredClone(store.getSnapshot().snapshot!)
  const save = LocalDatabase.prototype.save
  LocalDatabase.prototype.save = async () => {
    throw new Error('保存失败')
  }
  try {
    await expect(
      store.transform((space) => createMap(space, '不应保留的新图', ctx()), undefined, false, true),
    ).rejects.toThrow('保存失败')
    expect(store.getSnapshot().snapshot).toEqual(source)
  } finally {
    LocalDatabase.prototype.save = save
  }
})
it('数据库不可用时保留可编辑、可导出的内存空间，并禁止云端提交', async () => {
  vi.spyOn(LocalDatabase, 'open').mockRejectedValue(new Error('浏览器禁用'))
  const store = new AppStore()
  await store.init()
  const map = first(store.getSnapshot().snapshot!.space)
  expect(store.getSnapshot().status).toBe('error')
  expect(store.hasUnpersisted).toBe(true)
  await expect(
    store.command(map.id, { type: 'text', nodeId: map.rootId, text: '内存仍可编辑' }),
  ).rejects.toThrow()
  expect(first(store.getSnapshot().snapshot!.space).title).toBe('内存仍可编辑')
})
it('主动关闭标签不会被远端恢复列表重新打开，远端固定属性仍可更新', async () => {
  const store = new AppStore()
  await store.init()
  const source = store.getSnapshot().snapshot!,
    initial = mergeOperation(newServerState(), source.outbox[0], Date.now())
  await store.acknowledge(
    {
      schemaVersion: 1,
      space: initial.state.space,
      seq: 1,
      results: [initial.result],
      serverTime: Date.now(),
      subject: 'test',
    },
    [source.outbox[0].opId],
  )
  const map = first(initial.state.space)
  await store.transform(
    (space) => {
      space.tabs[map.id].open = false
      return space
    },
    undefined,
    false,
  )
  const pending = store.getSnapshot().snapshot!.outbox[0],
    closed = mergeOperation(initial.state, pending, Date.now())
  await store.acknowledge(
    {
      schemaVersion: 1,
      space: closed.state.space,
      seq: closed.state.seq,
      results: [closed.result],
      serverTime: Date.now(),
      subject: 'test',
    },
    [pending.opId],
  )
  const remote = structuredClone(closed.state.space)
  remote.tabs[map.id].open = true
  remote.tabs[map.id].pinned = true
  await store.acknowledge(
    {
      schemaVersion: 1,
      space: remote,
      seq: closed.state.seq + 1,
      results: [],
      serverTime: Date.now(),
      subject: 'test',
    },
    [],
  )
  expect(store.getSnapshot().snapshot!.space.tabs[map.id]).toMatchObject({
    open: false,
    pinned: true,
  })
})
