import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SyncClient } from '../../src/sync/client'
import type { AppStore } from '../../src/app/store'
import type { Operation } from '../../src/domain/types'
import { emptySpace } from '../../src/domain/types'
import { edit, first, operation, seed } from '../helpers'
class SocketStub {
  readyState = 1
  onmessage = null
  onerror = null
  onclose = null
  close() {}
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('navigator', { onLine: true })
  vi.stubGlobal('document', { visibilityState: 'visible' })
  vi.stubGlobal('location', new URL('https://mindme.example'))
  vi.stubGlobal('WebSocket', SocketStub)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
function fixture() {
  const op = operation(emptySpace(), seed()),
    state = {
      schemaVersion: 1,
      space: seed(),
      outbox: [op],
      drafts: [],
      serverSeq: 1,
      ownerSub: 'subject',
    }
  const store = {
    hasUnpersisted: false,
    subscribe: vi.fn(() => () => undefined),
    calibrate: vi.fn(),
    getSnapshot: () => ({ snapshot: state }),
    outboxState: vi.fn(async (ids: string[], status: Operation['state']) => {
      for (const item of state.outbox) if (ids.includes(item.opId)) item.state = status
    }),
    rekeyRejected: vi.fn(async (ids: string[]) => {
      for (const item of state.outbox)
        if (ids.includes(item.opId)) {
          item.opId = '重新排队的操作'
          item.state = 'retry'
        }
    }),
    acknowledge: vi.fn(async () => {
      state.outbox = []
    }),
  }
  const notify = vi.fn(),
    client = new SyncClient(store as unknown as AppStore, notify)
  client.session = {
    authenticated: true,
    configured: true,
    subject: 'subject',
    serverTime: 1000,
    csrf: 'csrf',
  }
  return { client, store, state, notify }
}
describe('同步客户端错误与重试', () => {
  it('旧服务端不支持样式字段时保留队列，不发送同步请求', async () => {
    const { client, state, store, notify } = fixture()
    const before = seed(),
      map = first(before)
    const after = edit(before, {
      type: 'style-many',
      nodeIds: [map.rootId],
      style: { fontSize: 28 },
    })
    state.outbox = [operation(before, after)]
    const fetch = vi.fn(async () => Response.json({ ok: true, version: '0.1.6' }))
    vi.stubGlobal('fetch', fetch)
    client.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch.mock.calls[0][0]).toBe('/api/health')
    expect(store.outboxState).not.toHaveBeenCalled()
    expect(store.acknowledge).not.toHaveBeenCalled()
    expect(state.outbox[0].state).toBe('pending')
    expect(notify).toHaveBeenLastCalledWith('error', expect.stringContaining('修改保留在本机'))
    client.stop()
  })
  it('能力检查后服务回滚并拒绝样式时，重置操作 ID 并保留待同步内容', async () => {
    const { client, state, store, notify } = fixture()
    const before = seed(),
      map = first(before)
    const after = edit(before, {
      type: 'style-many',
      nodeIds: [map.rootId],
      style: { fontSize: 28 },
    })
    state.space = after
    const op = operation(before, after)
    const oldId = op.opId
    state.outbox = [op]
    store.acknowledge.mockImplementation(async () => undefined)
    const fetch = vi.fn(async (url: string) =>
      url === '/api/health'
        ? Response.json({ capabilities: { nodeStyleFields: true } })
        : Response.json({
            schemaVersion: 1,
            seq: 1,
            space: before,
            results: [{ opId: oldId, status: 'rejected', seq: 1 }],
            serverTime: Date.now(),
            subject: 'subject',
          }),
    )
    vi.stubGlobal('fetch', fetch)
    client.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(store.rekeyRejected).toHaveBeenCalledWith([oldId])
    expect(store.acknowledge).toHaveBeenCalledOnce()
    expect(state.outbox[0].opId).toBe('重新排队的操作')
    expect(state.outbox[0].state).toBe('retry')
    expect(first(state.space).nodes[map.rootId].fontSize).toBe(28)
    expect(notify).toHaveBeenLastCalledWith('error', expect.stringContaining('待同步队列已保留'))
    client.stop()
  })
  it('先持久化提交中状态，确认后才移除队列并显示已同步', async () => {
    const { client, store, notify } = fixture()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          schemaVersion: 1,
          seq: 2,
          space: seed(),
          results: [],
          serverTime: Date.now(),
          subject: 'subject',
        }),
      ),
    )
    client.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(store.outboxState).toHaveBeenCalledWith(expect.any(Array), 'sending')
    expect(store.acknowledge).toHaveBeenCalledOnce()
    expect(notify).toHaveBeenLastCalledWith('synced')
    client.stop()
  })
  it('发现本地空间与当前登录账号不一致时暂停同步并提示先备份', async () => {
    const { client, store, notify } = fixture()
    client.session = {
      authenticated: true,
      configured: true,
      subject: 'another-subject',
      serverTime: 1000,
      csrf: 'csrf',
    }
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    client.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).not.toHaveBeenCalled()
    expect(store.acknowledge).not.toHaveBeenCalled()
    expect(notify).toHaveBeenLastCalledWith(
      'account-mismatch',
      expect.stringContaining('导出本地可用脑图备份'),
    )
    await vi.advanceTimersByTimeAsync(30000)
    client.retry()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).not.toHaveBeenCalled()
    client.stop()
  })
  it('账号恢复匹配后可手动继续原空间同步', async () => {
    const { client, store, state } = fixture(),
      fetch = vi.fn(async () =>
        Response.json({
          schemaVersion: 1,
          seq: 2,
          space: state.space,
          results: [],
          serverTime: Date.now(),
          subject: 'subject',
        }),
      )
    client.session = {
      authenticated: true,
      configured: true,
      subject: 'another-subject',
      serverTime: 1000,
      csrf: 'csrf',
    }
    vi.stubGlobal('fetch', fetch)
    client.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).not.toHaveBeenCalled()
    client.session.subject = 'subject'
    client.retry()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledOnce()
    expect(store.acknowledge).toHaveBeenCalledOnce()
    client.stop()
  })
  it('服务端确认身份与本地空间不一致时不接受响应为同步成功', async () => {
    const { client, store, state, notify } = fixture()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          schemaVersion: 1,
          seq: 2,
          space: seed(),
          results: [],
          serverTime: Date.now(),
          subject: 'another-subject',
        }),
      ),
    )
    client.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(store.acknowledge).not.toHaveBeenCalled()
    expect(state.outbox).toHaveLength(1)
    expect(store.outboxState).toHaveBeenLastCalledWith(expect.any(Array), 'retry')
    expect(notify).toHaveBeenLastCalledWith(
      'account-mismatch',
      expect.stringContaining('无法确认待同步操作是否已到达云端'),
    )
    client.retry()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledOnce()
    client.stop()
  })
  it('请求超时时显示中文提示并保留本地队列', async () => {
    const { client, store, notify } = fixture()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('signal timed out', 'TimeoutError')
      }),
    )
    client.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(store.outboxState).toHaveBeenLastCalledWith(expect.any(Array), 'retry')
    expect(notify).toHaveBeenLastCalledWith('error', '云端响应超时，修改已保留在本机；请稍后重试。')
    client.stop()
  })
  it('429 遵守 Retry-After，失败后队列可重试且不显示已同步', async () => {
    const { client, store, notify } = fixture(),
      fetch = vi.fn(async () => new Response('', { status: 429, headers: { 'Retry-After': '60' } }))
    vi.stubGlobal('fetch', fetch)
    client.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(store.outboxState).toHaveBeenLastCalledWith(expect.any(Array), 'retry')
    expect(notify).toHaveBeenLastCalledWith('error', expect.any(String))
    await vi.advanceTimersByTimeAsync(59000)
    expect(fetch).toHaveBeenCalledOnce()
    client.stop()
  })
  it('401 暂停请求并保留队列，400 转为需处理而非无限重试', async () => {
    const first = fixture()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 401 })),
    )
    first.client.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(first.notify).toHaveBeenLastCalledWith('unauthorized', expect.any(String))
    expect(first.state.outbox).toHaveLength(1)
    expect(first.client.session).toMatchObject({ authenticated: false, configured: true })
    first.client.stop()
    const second = fixture()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 400 })),
    )
    second.client.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(second.store.outboxState).toHaveBeenLastCalledWith(
      expect.any(Array),
      'attention',
      expect.any(String),
    )
    expect(second.notify).toHaveBeenLastCalledWith('attention')
    second.client.stop()
  })
  it('本地写失败和断网时禁止提交，网络异常保留重试操作', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('网络断开')
    })
    vi.stubGlobal('fetch', fetch)
    const a = fixture()
    a.store.hasUnpersisted = true
    a.client.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).not.toHaveBeenCalled()
    a.client.stop()
    const b = fixture()
    vi.stubGlobal('navigator', { onLine: false })
    b.client.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).not.toHaveBeenCalled()
    expect(b.notify).toHaveBeenLastCalledWith('offline')
    b.client.stop()
    const c = fixture()
    vi.stubGlobal('navigator', { onLine: true })
    c.client.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(c.store.outboxState).toHaveBeenLastCalledWith(expect.any(Array), 'retry')
    c.client.stop()
  })
})

describe('认证检查与断网重连恢复', () => {
  const authenticated = () => ({
    authenticated: true,
    configured: true,
    subject: 'subject',
    csrf: 'new-csrf',
    serverTime: Date.now(),
  })
  it('离线打开页面后，网络事件早于服务恢复也会持续重试认证并最终同步', async () => {
    const { client, store, state, notify } = fixture()
    client.session = null
    vi.stubGlobal('navigator', { onLine: false })
    const fetch = vi.fn(async (url: string) => {
      if (url === '/auth/session') {
        if (fetch.mock.calls.filter(([path]) => path === '/auth/session').length <= 2)
          throw new TypeError('网络尚不可达')
        return Response.json(authenticated())
      }
      return Response.json({
        schemaVersion: 1,
        seq: 2,
        space: state.space,
        results: [],
        serverTime: Date.now(),
        subject: 'subject',
      })
    })
    vi.stubGlobal('fetch', fetch)
    client.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(notify).toHaveBeenLastCalledWith('offline')
    expect(fetch).not.toHaveBeenCalled()
    vi.stubGlobal('navigator', { onLine: true })
    client.retry()
    await vi.advanceTimersByTimeAsync(0)
    expect(notify).toHaveBeenLastCalledWith('error', expect.stringContaining('网络'))
    await vi.advanceTimersByTimeAsync(10000)
    expect(fetch.mock.calls.filter(([path]) => path === '/auth/session')).toHaveLength(3)
    expect(store.acknowledge).toHaveBeenCalled()
    expect(notify).toHaveBeenLastCalledWith('synced')
    expect(state.outbox).toHaveLength(0)
    client.stop()
  })
  it('会话接口 503 和非 JSON 不会被误报成未配置，保留已有会话', async () => {
    const { client, notify } = fixture(),
      before = client.session
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('服务暂时不可用', { status: 503 })),
    )
    await expect(client.inspect()).rejects.toThrow('503')
    expect(client.session).toBe(before)
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<html>fallback</html>', { headers: { 'content-type': 'text/html' } }),
      ),
    )
    await expect(client.inspect()).rejects.toThrow('返回异常')
    expect(client.session).toBe(before)
    expect(notify.mock.calls.some(([status]) => status === 'local')).toBe(false)
  })
  it('认证状态格式异常持续重试，仅明确 configured=false 时显示本地空间', async () => {
    const { client, state, notify } = fixture()
    client.session = null
    const fetch = vi.fn(async () =>
      Response.json({ authenticated: false, configured: false, serverTime: Date.now() }),
    )
    vi.stubGlobal('fetch', fetch)
    client.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(client.session?.configured).toBe(false)
    expect(notify).toHaveBeenLastCalledWith('local')
    await vi.advanceTimersByTimeAsync(30000)
    expect(fetch).toHaveBeenCalledOnce()
    expect(state.outbox).toHaveLength(1)
    client.stop()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: '临时错误' })),
    )
    await expect(client.inspect()).rejects.toThrow('格式异常')
  })
  it('会话过期时自动刷新并继续提交原队列', async () => {
    const { store, state, notify } = fixture(),
      sessionChanged = vi.fn()
    const client = new SyncClient(store as unknown as AppStore, notify, sessionChanged)
    client.session = authenticated()
    let unauthorized = true,
      refreshReady = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, options?: RequestInit) => {
        if (url === '/auth/session')
          return Response.json(
            refreshReady
              ? authenticated()
              : { authenticated: false, configured: true, serverTime: Date.now() },
          )
        if (url === '/auth/refresh') {
          refreshReady = true
          return new Response('', { status: 200 })
        }
        if (unauthorized) {
          unauthorized = false
          return new Response('', { status: 401 })
        }
        expect((options?.headers as Record<string, string>)['X-CSRF-Token']).toBe('new-csrf')
        return Response.json({
          schemaVersion: 1,
          seq: 2,
          space: state.space,
          results: [],
          serverTime: Date.now(),
          subject: 'subject',
        })
      }),
    )
    client.start()
    await vi.advanceTimersByTimeAsync(1000)
    expect(sessionChanged).toHaveBeenLastCalledWith(
      expect.objectContaining({ authenticated: true }),
    )
    expect(store.acknowledge).toHaveBeenCalledOnce()
    expect(notify).toHaveBeenLastCalledWith('synced')
    expect(state.outbox).toHaveLength(0)
    client.stop()
  })
  it('已登录会话缺少身份 subject 时拒绝启动同步', async () => {
    const { client, notify } = fixture()
    client.session = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          authenticated: true,
          configured: true,
          csrf: 'csrf',
          serverTime: Date.now(),
        }),
      ),
    )
    await expect(client.inspect()).rejects.toThrow('云端登录状态格式异常')
    expect(notify).not.toHaveBeenCalledWith('synced')
    client.stop()
  })
  it('仅本地开发允许 HTML 回退为本地空间', async () => {
    const { store, notify } = fixture(),
      changed = vi.fn()
    const client = new SyncClient(store as unknown as AppStore, notify, changed, true)
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response('<html>vite</html>', { headers: { 'content-type': 'text/html' } }),
      ),
    )
    expect(await client.inspect()).toBeNull()
    expect(notify).toHaveBeenLastCalledWith('local', expect.stringContaining('开发服务器'))
  })
})
it('停止连接后的迟到会话响应不会重新改变登录状态或启动同步', async () => {
  const { client, store, notify } = fixture()
  client.session = null
  let finish: (response: Response) => void = () => undefined
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve
        }),
    ),
  )
  client.start()
  await vi.advanceTimersByTimeAsync(0)
  client.stop()
  finish(
    Response.json({
      authenticated: true,
      configured: true,
      subject: 'subject',
      csrf: 'csrf',
      serverTime: Date.now(),
    }),
  )
  await vi.advanceTimersByTimeAsync(30000)
  expect(client.session).toBeNull()
  expect(store.acknowledge).not.toHaveBeenCalled()
  expect(notify).not.toHaveBeenCalled()
})
it('WebSocket 已连接时，新本地操作立即唤醒提交，不等待十五秒兜底轮询', async () => {
  const { client, store, state } = fixture()
  let changed = () => undefined
  store.subscribe.mockImplementation((callback) => {
    changed = callback
    return () => undefined
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        schemaVersion: 1,
        seq: 2,
        space: state.space,
        results: [],
        serverTime: Date.now(),
        subject: 'subject',
      }),
    ),
  )
  client.start()
  await vi.advanceTimersByTimeAsync(0)
  expect(store.acknowledge).toHaveBeenCalledOnce()
  state.outbox.push(operation(emptySpace(), seed()))
  changed()
  await vi.advanceTimersByTimeAsync(0)
  expect(store.acknowledge).toHaveBeenCalledTimes(2)
  client.stop()
})
it('编辑草稿清理暂时阻塞提交后，本地事务完成会立即重新唤醒相同队列', async () => {
  const { client, store, state } = fixture()
  let changed = () => undefined
  store.subscribe.mockImplementation((callback) => {
    changed = callback
    return () => undefined
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        schemaVersion: 1,
        seq: 2,
        space: state.space,
        results: [],
        serverTime: Date.now(),
        subject: 'subject',
      }),
    ),
  )
  client.start()
  await vi.advanceTimersByTimeAsync(0)
  state.outbox.push(operation(emptySpace(), seed()))
  changed()
  store.hasUnpersisted = true
  await vi.advanceTimersByTimeAsync(0)
  expect(store.acknowledge).toHaveBeenCalledOnce()
  store.hasUnpersisted = false
  changed()
  await vi.advanceTimersByTimeAsync(0)
  expect(store.acknowledge).toHaveBeenCalledTimes(2)
  client.stop()
})
