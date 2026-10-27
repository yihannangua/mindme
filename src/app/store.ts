import { execute, maintenance, type Command } from '../domain/commands'
import { initialSpace, validateSpace } from '../domain/model'
import {
  applyChanges,
  diffSpace,
  guardedChanges,
  undoEntry,
  type UndoEntry,
} from '../domain/operations'
import {
  assert,
  clone,
  equal,
  LIMITS,
  type Context,
  type LocalSnapshot,
  type Operation,
  type Space,
} from '../domain/types'
import { LocalDatabase } from '../persistence/database'
import { EstimatedClock } from '../sync/clock'
import type { SyncResponse } from '../sync/protocol'

export interface ViewState {
  snapshot: LocalSnapshot | null
  status: 'loading' | 'saved' | 'saving' | 'error'
  error: string
  canUndo: boolean
  canRedo: boolean
  pendingTasks: number
}
const uuid = () => crypto.randomUUID()
export const context = (): Context => ({ now: Date.now(), id: uuid })
function freshSnapshot(): LocalSnapshot {
  const space = initialSpace(context()),
    deviceId = uuid()
  return {
    schemaVersion: 1,
    space,
    outbox: [
      {
        schemaVersion: 1,
        opId: uuid(),
        stamp: { deviceId, deviceSeq: 1, at: Date.now(), uncertainty: 86400000 },
        baseRevision: 0,
        intent: 'bootstrap',
        changes: diffSpace({ schemaVersion: 1, maps: {}, tabs: {} }, space),
        state: 'pending',
        attempts: 0,
      },
    ],
    drafts: [],
    deviceId,
    deviceSeq: 1,
    serverSeq: 0,
    ownerSub: null,
    localTabs: {},
  }
}
export class AppStore {
  private database: LocalDatabase | null = null
  private listeners = new Set<() => void>()
  private queue: Promise<unknown> = Promise.resolve()
  private undo = new Map<string, UndoEntry[]>()
  private redo = new Map<string, UndoEntry[]>()
  private activeId = ''
  private view: ViewState = {
    snapshot: null,
    status: 'loading',
    error: '',
    canUndo: false,
    canRedo: false,
    pendingTasks: 0,
  }
  private unpersisted = false
  private pendingTasks = 0
  getSnapshot = () => this.view
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private emit(patch: Partial<ViewState>) {
    this.view = {
      ...this.view,
      ...patch,
      canUndo: !!this.undo.get(this.activeId)?.length,
      canRedo: !!this.redo.get(this.activeId)?.length,
    }
    this.listeners.forEach((listener) => listener())
  }
  async init() {
    try {
      try {
        this.database = await LocalDatabase.open()
      } catch (error) {
        this.unpersisted = true
        this.emit({
          snapshot: freshSnapshot(),
          status: 'error',
          error: `本地数据库不可用，当前为内存编辑：${message(error)}`,
        })
        return
      }
      let snapshot = await this.database.load()
      const previousSession = !!snapshot
      if (!snapshot) {
        snapshot = freshSnapshot()
        try {
          await this.database.save(snapshot)
        } catch (error) {
          this.unpersisted = true
          this.emit({ snapshot, status: 'error', error: message(error) })
          return
        }
      }
      const recovered = clone(snapshot)
      recovered.outbox.forEach((op) => {
        if (op.state === 'sending') op.state = 'retry'
      })
      if (recovered.editorDraft) {
        const draft = recovered.editorDraft
        try {
          assert(
            draft.text.length <= LIMITS.text &&
              recovered.space.maps[draft.mapId]?.nodes[draft.nodeId]?.text === draft.original,
            '原节点已变化',
          )
          const next = execute(
            recovered.space,
            draft.mapId,
            { type: 'text', nodeId: draft.nodeId, text: draft.text },
            { now: draft.at, id: uuid },
          ).space
          const changes = diffSpace(recovered.space, next)
          if (changes.length) {
            recovered.deviceSeq++
            recovered.outbox.push({
              schemaVersion: 1,
              opId: uuid(),
              stamp: {
                deviceId: recovered.deviceId,
                deviceSeq: recovered.deviceSeq,
                at: draft.at,
                uncertainty: 86400000,
              },
              baseRevision: recovered.serverSeq,
              changes,
              state: 'pending',
              attempts: 0,
            })
            recovered.space = next
          }
        } catch {
          recovered.drafts.push({
            id: uuid(),
            opId: 'recovered-editor-draft',
            at: draft.at,
            reason: '上次未完成的文字编辑，请复制后找回',
            text: draft.text,
          })
        }
        delete recovered.editorDraft
        await this.database.save(recovered)
      }
      this.emit({ snapshot: recovered, status: 'saved' })
      if (previousSession) await this.flushHistory(true)
    } catch (error) {
      this.emit({ status: 'error', error: message(error) })
    }
  }
  setActive(id: string) {
    this.activeId = id
    this.emit({})
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    this.pendingTasks++
    this.emit({ pendingTasks: this.pendingTasks })
    const promise = this.queue.then(action).finally(() => {
      this.pendingTasks--
      this.emit({ pendingTasks: this.pendingTasks })
    })
    this.queue = promise.catch(() => undefined)
    return promise
  }
  private async persist(snapshot: LocalSnapshot, atomic = false, applied?: () => void) {
    const previous = this.view.snapshot
    this.emit({ ...(atomic ? {} : { snapshot }), status: 'saving', error: '' })
    // 选中和键盘输入跟随内存内容发布，不等待 IndexedDB 的保存确认。
    if (!atomic) applied?.()
    try {
      assert(this.database, '本地数据库尚未就绪')
      await this.database.save(snapshot)
      // 保存期间可能已有更新的内存快照发布；旧保存完成时不能把新编辑回滚。
      if (atomic ? this.view.snapshot === previous : this.view.snapshot === snapshot) {
        this.unpersisted = false
        this.emit({ snapshot, status: 'saved' })
      }
      if (atomic) applied?.()
    } catch (error) {
      if (this.view.snapshot === snapshot) {
        this.unpersisted = !atomic || this.unpersisted
        this.emit({
          snapshot: atomic ? previous : snapshot,
          status: 'error',
          error: message(error),
        })
      }
      throw error
    }
  }
  transform(
    transform: (space: Space) => Space,
    mapId?: string,
    trackUndo = true,
    atomic = false,
    intent: Operation['intent'] = 'edit',
    applied?: () => void,
  ): Promise<void> {
    return this.serial(async () => {
      const snapshot = clone(this.view.snapshot)
      assert(snapshot, '本地数据尚未就绪')
      const next = transform(clone(snapshot.space))
      validateSpace(next)
      const changes = diffSpace(snapshot.space, next)
      if (!changes.length) return
      snapshot.localTabs ??= {}
      for (const change of changes)
        if (change.field === 'tab:open' || change.field === '$tab') {
          const tab = next.tabs[change.mapId]
          if (tab) snapshot.localTabs[change.mapId] = tab.open
          else delete snapshot.localTabs[change.mapId]
        }
      if (trackUndo && mapId && !atomic) {
        this.undo.set(mapId, [...(this.undo.get(mapId) ?? []), undoEntry(changes)].slice(-100))
        this.redo.delete(mapId)
      }
      snapshot.deviceSeq++
      const operation: Operation = {
        schemaVersion: 1,
        opId: uuid(),
        stamp: this.stamp(snapshot.deviceId, snapshot.deviceSeq),
        baseRevision: snapshot.serverSeq,
        intent,
        changes,
        state: 'pending',
        attempts: 0,
      }
      snapshot.space = next
      snapshot.outbox.push(operation)
      await this.persist(snapshot, atomic, applied)
      if (trackUndo && mapId && atomic) {
        this.undo.set(mapId, [...(this.undo.get(mapId) ?? []), undoEntry(changes)].slice(-100))
        this.redo.delete(mapId)
      }
    })
  }
  command(
    mapId: string,
    command: Command,
    applied?: (selectedId: string | undefined) => void,
  ): Promise<string | undefined> {
    let selectedId: string | undefined
    return this.transform(
      (space) => {
        const result = execute(space, mapId, command, context())
        selectedId = result.selectedId
        if (command.type === 'purge') {
          this.undo.delete(mapId)
          this.redo.delete(mapId)
        }
        return result.space
      },
      mapId,
      command.type !== 'purge',
      ['restore', 'purge'].includes(command.type),
      command.type === 'restore' ? 'restore' : 'edit',
      () => applied?.(selectedId),
    ).then(() => selectedId)
  }
  history(mapId: string, direction: 'undo' | 'redo') {
    return this.serial(async () => {
      const snapshot = clone(this.view.snapshot)
      assert(snapshot, '本地数据尚未就绪')
      const source = direction === 'undo' ? this.undo : this.redo,
        destination = direction === 'undo' ? this.redo : this.undo
      const entry = source.get(mapId)?.at(-1)
      if (!entry) return
      const changes = guardedChanges(
        snapshot.space,
        direction === 'undo' ? entry.inverse : entry.forward,
      )
      assert(changes.length > 0, '这些字段已由另一设备修改，不能覆盖撤销')
      const next = applyChanges(snapshot.space, changes, Date.now())
      const map = next.maps[mapId]
      if (map) map.historyDirtySince ??= Date.now()
      snapshot.space = next
      snapshot.deviceSeq++
      snapshot.outbox.push({
        schemaVersion: 1,
        opId: uuid(),
        stamp: this.stamp(snapshot.deviceId, snapshot.deviceSeq),
        baseRevision: snapshot.serverSeq,
        intent: 'undo',
        changes,
        state: 'pending',
        attempts: 0,
      })
      source.get(mapId)!.pop()
      destination.set(mapId, [...(destination.get(mapId) ?? []), entry])
      await this.persist(snapshot)
    })
  }
  editorDraft(draft: LocalSnapshot['editorDraft'] | null) {
    return this.serial(async () => {
      const snapshot = clone(this.view.snapshot)
      assert(snapshot, '本地数据尚未就绪')
      if (draft) snapshot.editorDraft = draft
      else delete snapshot.editorDraft
      await this.persist(snapshot)
    })
  }
  commitTextEdit(mapId: string, nodeId: string, text: string, original: string) {
    let prepared: LocalSnapshot
    try {
      const snapshot = clone(this.view.snapshot)
      assert(snapshot, '本地数据尚未就绪')
      const map = snapshot.space.maps[mapId],
        node = map?.nodes[nodeId]
      assert(map && node, '节点不存在')
      assert(node.text === original, '编辑期间另一设备修改了文字，请复制草稿后重新编辑')
      const next = clone(snapshot.space)
      next.maps[mapId].nodes[nodeId].text = text
      next.maps[mapId].updatedAt = Date.now()
      if (nodeId === next.maps[mapId].rootId) next.maps[mapId].title = text.trim()
      validateSpace(next)
      const changes = diffSpace(snapshot.space, next)
      if (!changes.length) {
        delete snapshot.editorDraft
        return this.serial(() => this.persist(snapshot))
      }
      snapshot.deviceSeq++
      snapshot.space = next
      snapshot.outbox.push({
        schemaVersion: 1,
        opId: uuid(),
        stamp: this.stamp(snapshot.deviceId, snapshot.deviceSeq),
        baseRevision: snapshot.serverSeq,
        intent: 'edit',
        changes,
        state: 'pending',
        attempts: 0,
      })
      delete snapshot.editorDraft
      prepared = snapshot
    } catch (error) {
      return Promise.reject(error)
    }

    // 先更新内存状态，再排队等待之前的编辑草稿保存完成；避免回车确认被旧草稿保存阻塞。
    this.undo.set(
      mapId,
      [...(this.undo.get(mapId) ?? []), undoEntry(prepared.outbox.at(-1)!.changes)].slice(-100),
    )
    this.redo.delete(mapId)
    this.emit({ snapshot: prepared, status: 'saving', error: '' })
    return this.serial(async () => {
      const snapshot = clone(this.view.snapshot)
      assert(snapshot, '本地数据尚未就绪')
      delete snapshot.editorDraft
      await this.persist(snapshot)
    })
  }

  flushHistory(leave = false) {
    return this.transform((space) => maintenance(space, context(), leave), undefined, false)
  }
  retrySave() {
    return this.serial(async () => {
      assert(this.view.snapshot, '没有可重试的本地快照，请刷新后重试打开数据库')
      if (!this.database) this.database = await LocalDatabase.open()
      await this.persist(clone(this.view.snapshot))
    })
  }
  get hasUnpersisted() {
    return this.unpersisted || this.pendingTasks > 0 || this.view.status !== 'saved'
  }
  private clock = new EstimatedClock()
  private stamp(deviceId: string, deviceSeq: number) {
    return { deviceId, deviceSeq, ...this.clock.read(Date.now(), performance.now()) }
  }
  calibrate(serverTime: number, start: number, end: number) {
    this.clock.calibrate(serverTime, start, end, performance.now())
  }
  acknowledge(response: SyncResponse, sentIds: string[]) {
    return this.serial(async () => {
      const snapshot = clone(this.view.snapshot)
      assert(snapshot, '本地数据尚未就绪')
      assert(
        snapshot.ownerSub === null || snapshot.ownerSub === response.subject,
        '本地空间属于其他账号，请先备份并切换浏览器配置',
      )
      if (response.seq < snapshot.serverSeq) return
      assert(
        response.schemaVersion === 1 &&
          Number.isSafeInteger(response.seq) &&
          response.seq >= 0 &&
          Array.isArray(response.results) &&
          typeof response.subject === 'string',
        '云端返回了不支持的同步数据',
      )
      const confirmedSpace =
        response.space ??
        (() => {
          assert(
            snapshot.serverSpace &&
              response.baseSeq === snapshot.serverSeq &&
              Array.isArray(response.changes),
            '同步基线缺失，需要重新连接',
          )
          return applyChanges(snapshot.serverSpace, response.changes, response.serverTime)
        })()
      validateSpace(confirmedSpace)
      snapshot.serverSpace = clone(confirmedSpace)
      if (
        snapshot.ownerSub === null &&
        snapshot.outbox.length === 1 &&
        snapshot.outbox[0].intent === 'bootstrap' &&
        Object.keys(confirmedSpace.maps).length > 0
      )
        snapshot.outbox = []
      snapshot.ownerSub = response.subject
      const results = new Map(response.results.map((result) => [result.opId, result]))
      let space = clone(confirmedSpace)
      for (const op of snapshot.outbox) {
        const result = results.get(op.opId)
        if (result && result.status !== 'accepted' && sentIds.includes(op.opId)) {
          op.state = 'attention'
          if (!snapshot.drafts.some((draft) => draft.opId === op.opId))
            snapshot.drafts.push({
              id: uuid(),
              opId: op.opId,
              at: Date.now(),
              reason: result.reason ?? '云端未接受修改',
              text: JSON.stringify(op.changes, null, 2),
            })
        }
      }
      snapshot.outbox = snapshot.outbox.filter(
        (op) => !(results.get(op.opId)?.status === 'accepted' && sentIds.includes(op.opId)),
      )
      for (const op of snapshot.outbox.filter((op) =>
        ['pending', 'retry', 'sending'].includes(op.state),
      )) {
        try {
          space = applyChanges(space, op.changes, Date.now())
        } catch (error) {
          op.state = 'attention'
          if (!snapshot.drafts.some((draft) => draft.opId === op.opId))
            snapshot.drafts.push({
              id: uuid(),
              opId: op.opId,
              at: Date.now(),
              reason:
                error instanceof Error && error.message === '脑图字段不合法'
                  ? '本地版本与云端协议不兼容，请保留并重新编辑'
                  : '远端结构发生变化，无法自动重放本地修改',
              text: JSON.stringify(op.changes, null, 2),
            })
        }
      }
      // 同步不强制关闭当前设备已打开的标签；恢复列表与会话状态分别处理。
      for (const tab of Object.values(snapshot.space.tabs))
        if (tab.open && space.maps[tab.mapId]?.deletedAt === null)
          space.tabs[tab.mapId] = { ...space.tabs[tab.mapId], open: true }
      for (const [mapId, open] of Object.entries(snapshot.localTabs ?? {}))
        if (space.tabs[mapId] && space.maps[mapId]?.deletedAt === null)
          space.tabs[mapId].open = open
      snapshot.space = space
      snapshot.serverSeq = response.seq
      if (!equal(snapshot, this.view.snapshot)) await this.persist(snapshot)
    })
  }
  outboxState(ids: string[], state: Operation['state'], reason?: string) {
    return this.serial(async () => {
      const snapshot = clone(this.view.snapshot)
      assert(snapshot, '本地数据尚未就绪')
      for (const op of snapshot.outbox)
        if (ids.includes(op.opId)) {
          op.state = state
          if (state === 'sending') op.attempts++
          if (state === 'attention' && !snapshot.drafts.some((draft) => draft.opId === op.opId))
            snapshot.drafts.push({
              id: uuid(),
              opId: op.opId,
              at: Date.now(),
              reason: reason ?? '服务端拒绝操作，请检查内容',
              text: JSON.stringify(op.changes, null, 2),
            })
        }
      await this.persist(snapshot)
    })
  }
  rekeyRejected(ids: string[]) {
    return this.serial(async () => {
      const snapshot = clone(this.view.snapshot)
      assert(snapshot, '本地数据尚未就绪')
      for (const op of snapshot.outbox)
        if (ids.includes(op.opId) && op.state === 'sending') {
          op.opId = uuid()
          op.state = 'retry'
        }
      await this.persist(snapshot)
    })
  }
  discardDraft(id: string) {
    return this.serial(async () => {
      const snapshot = clone(this.view.snapshot)
      assert(snapshot, '没有本地数据')
      const draft = snapshot.drafts.find((draft) => draft.id === id)
      snapshot.drafts = snapshot.drafts.filter((draft) => draft.id !== id)
      if (draft) snapshot.outbox = snapshot.outbox.filter((op) => op.opId !== draft.opId)
      await this.persist(snapshot)
    })
  }
}
export const message = (error: unknown) =>
  error instanceof Error ? error.message : '操作失败，请重试'
export const appStore = new AppStore()
