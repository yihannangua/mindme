import { CloudResponseError, responseError } from '../api/errors'
import type { AppStore } from '../app/store'
import { errorClass, retryDelay, type SyncResponse } from './protocol'
export interface SessionInfo {
  authenticated: boolean
  configured: boolean
  googleClientId?: string
  authMode?: 'google' | 'passkey'
  passkeyReady?: boolean
  setupAvailable?: boolean
  subject?: string
  csrf?: string
  serverTime: number
}
export type ConnectionStatus =
  | 'local'
  | 'connecting'
  | 'synced'
  | 'pending'
  | 'offline'
  | 'unauthorized'
  | 'error'
  | 'attention'
  | 'account-mismatch'
export const ACCOUNT_MISMATCH_DETAIL =
  '此浏览器的本地空间与当前账号不匹配，已暂停同步。若刚切换过账号或点过重试，仅凭此提示无法确认待同步操作是否已到达云端；请勿继续重试或清除原浏览器配置。先导出本地可用脑图备份并保留原配置。'
const syncTimeoutDetail = '云端响应超时，修改已保留在本机；请稍后重试。'
const syncTimeoutMs = 30000
const styleFields = new Set(['fontFamily', 'fontSize', 'backgroundColor'])
const hasStyleChanges = (op: { changes: { field: string }[] }) =>
  op.changes.some((change) => styleFields.has(change.field))
const errorDetail = (error: unknown) =>
  error instanceof DOMException && error.name === 'TimeoutError'
    ? syncTimeoutDetail
    : error instanceof Error && error.name === 'AbortError'
      ? syncTimeoutDetail
      : error instanceof Error
        ? error.message
        : '同步连接失败，将自动重试'
export class SyncClient {
  private timer: ReturnType<typeof setTimeout> | null = null
  private socket: WebSocket | null = null
  private stopped = true
  private busy = false
  private attempts = 0
  private generation = 0
  private retryRequested = false
  private unsubscribe: (() => void) | null = null
  private observedOutbox = ''
  private waitingForSave = false
  private identityMismatchPaused = false
  private serverIdentityMismatchPaused = false
  private refreshPromise: Promise<boolean> | null = null
  session: SessionInfo | null = null
  constructor(
    private store: AppStore,
    private notify: (status: ConnectionStatus, detail?: string) => void,
    private sessionChanged: (session: SessionInfo | null) => void = () => undefined,
    private allowLocalOnly = false,
  ) {}
  private updateSession(session: SessionInfo | null) {
    this.session = session
    this.sessionChanged(session)
  }
  private async refresh() {
    if (this.refreshPromise) return this.refreshPromise
    const refresh = async () => {
      const run = async () => {
        // 多标签页共享同一个 Cookie。拿到跨标签锁后先检查一次，避免重复轮换同一令牌。
        const current = await fetch('/auth/session', {
          credentials: 'same-origin',
          cache: 'no-store',
          signal: AbortSignal.timeout(10000),
        })
        if (current.ok && (await current.json()).authenticated) return true
        const response = await fetch('/auth/refresh', {
          method: 'POST',
          credentials: 'same-origin',
          signal: AbortSignal.timeout(10000),
        })
        return response.ok
      }
      const locks = 'locks' in navigator ? navigator.locks : undefined
      if (locks)
        return new Promise<boolean>((resolve, reject) => {
          void locks.request('mindme-auth-refresh', async () => {
            try {
              resolve(await run())
            } catch (error) {
              reject(error)
            }
          })
        })
      return run()
    }
    this.refreshPromise = refresh().finally(() => {
      this.refreshPromise = null
    })
    try {
      if (!(await this.refreshPromise)) return false
      return !!(await this.inspect(false))?.authenticated
    } finally {
      this.refreshPromise = null
    }
  }
  async inspect(allowRefresh = true) {
    const generation = this.generation
    const start = Date.now(),
      response = await fetch('/auth/session', {
        credentials: 'same-origin',
        cache: 'no-store',
        signal: AbortSignal.timeout(10000),
      })
    if (generation !== this.generation) throw new Error('连接已停止')
    if (!response.ok)
      throw await responseError(
        response,
        `暂时无法确认云端登录状态（${response.status}），将自动重试`,
      )
    if (!response.headers.get('content-type')?.includes('application/json')) {
      if (!this.allowLocalOnly) throw new Error('云端登录接口返回异常，将自动重试')
      this.updateSession(null)
      this.notify('local', '当前本地开发服务器未提供云端接口，修改保存在此浏览器中。')
      return null
    }
    const info = (await response.json()) as SessionInfo
    if (generation !== this.generation) throw new Error('连接已停止')
    if (
      !info ||
      typeof info.authenticated !== 'boolean' ||
      typeof info.configured !== 'boolean' ||
      !Number.isFinite(info.serverTime) ||
      (info.authenticated &&
        (!info.configured ||
          typeof info.csrf !== 'string' ||
          !info.csrf ||
          typeof info.subject !== 'string' ||
          !info.subject))
    ) {
      throw new Error('云端登录状态格式异常，将自动重试')
    }
    if (!info.authenticated && allowRefresh && info.configured) {
      try {
        if (await this.refresh()) return this.session
      } catch {
        // 刷新失败时继续展示未登录状态，由后续同步退避重试。
      }
    }
    this.store.calibrate(info.serverTime, start, Date.now())
    this.updateSession(info)
    this.notify(info.authenticated ? 'connecting' : info.configured ? 'unauthorized' : 'local')
    return info
  }
  async login(credential: string) {
    const response = await fetch('/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credential }),
      signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) throw await responseError(response, `登录暂不可用（${response.status}）`)
    await this.inspect()
    this.identityMismatchPaused = false
    this.serverIdentityMismatchPaused = false
    this.start()
  }
  async completeExternalLogin() {
    await this.inspect()
    this.identityMismatchPaused = false
    this.serverIdentityMismatchPaused = false
    this.start()
  }
  async logout() {
    const response = await fetch('/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-CSRF-Token': this.session?.csrf ?? '' },
    })
    if (!response.ok) throw new Error('退出登录未完成，请检查网络后重试')
    this.stop()
    this.updateSession(
      this.session
        ? { ...this.session, authenticated: false, csrf: undefined, subject: undefined }
        : null,
    )
    this.notify('unauthorized')
  }
  private listen() {
    if (this.unsubscribe) return
    this.unsubscribe = this.store.subscribe(() => {
      if (this.stopped || this.store.hasUnpersisted) return
      const pending =
        this.store
          .getSnapshot()
          .snapshot?.outbox.filter((op) => ['pending', 'retry', 'sending'].includes(op.state)) ?? []
      const signature = pending.map((op) => op.opId).join(',')
      if (signature === this.observedOutbox && !this.waitingForSave) return
      this.waitingForSave = false
      this.observedOutbox = signature
      if (this.identityMismatchPaused || !pending.length) return
      if (this.busy) this.retryRequested = true
      else this.schedule(0)
    })
  }
  start() {
    this.stopped = false
    this.listen()
    this.schedule(0)
    this.connectSocket()
  }
  stop() {
    this.identityMismatchPaused = false
    this.serverIdentityMismatchPaused = false
    this.unsubscribe?.()
    this.unsubscribe = null
    this.generation++
    this.retryRequested = false
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.socket?.close()
    this.socket = null
  }
  retry() {
    this.stopped = false
    this.listen()
    this.retryRequested = this.busy
    this.attempts = 0
    this.schedule(0)
  }
  private schedule(delay: number) {
    if (this.timer) clearTimeout(this.timer)
    if (!this.stopped) this.timer = setTimeout(() => void this.tick(), delay)
  }
  private connectSocket() {
    if (!this.session?.authenticated || this.stopped || (this.socket && this.socket.readyState < 2))
      return
    const url = new URL('/api/ws', location.href)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    this.socket = new WebSocket(url)
    this.socket.onmessage = () => this.schedule(0)
    this.socket.onerror = () => this.socket?.close()
    this.socket.onclose = () => {
      this.socket = null
    }
  }
  async tick() {
    if (this.busy || this.stopped) return
    if (!navigator.onLine) {
      this.notify('offline')
      this.schedule(3000)
      return
    }
    if (this.store.hasUnpersisted) {
      this.waitingForSave = true
      this.notify('error', '本地保存尚未成功，已暂停云端提交')
      this.schedule(2000)
      return
    }
    const generation = this.generation
    this.busy = true
    let sentIds: string[] = []
    let delay: number | null =
      document.visibilityState === 'hidden' || this.socket?.readyState === 1 ? 15000 : 1000
    try {
      if (this.serverIdentityMismatchPaused) {
        delay = null
        return
      }
      if (this.identityMismatchPaused) {
        const snapshot = this.store.getSnapshot().snapshot!
        if (!this.session?.authenticated || snapshot.ownerSub !== this.session.subject) {
          delay = null
          return
        }
        this.identityMismatchPaused = false
      }
      // 会话检查也是重连状态机的一部分，网络尚未真正恢复时持续退避重试。
      if (!this.session?.authenticated) {
        const info = await this.inspect()
        if (!info?.authenticated) {
          delay = null
          return
        }
      }
      if (this.stopped || generation !== this.generation) return
      const snapshot = this.store.getSnapshot().snapshot!
      if (snapshot.ownerSub !== null && snapshot.ownerSub !== this.session?.subject) {
        delay = null
        this.identityMismatchPaused = true
        this.notify('account-mismatch', ACCOUNT_MISMATCH_DETAIL)
        return
      }
      const pending = (snapshot.ownerSub === null ? [] : snapshot.outbox).filter((op) =>
        ['pending', 'retry', 'sending'].includes(op.state),
      )
      const batch = []
      let bytes = 0
      for (const op of pending) {
        const size = JSON.stringify(op).length
        if (batch.length && (batch.length >= 100 || bytes + size > 256 * 1024)) break
        batch.push(op)
        bytes += size
      }
      if (batch.some(hasStyleChanges)) {
        const health = await fetch('/api/health', {
          cache: 'no-store',
          signal: AbortSignal.timeout(10000),
        })
        if (!health.ok) throw new Error('无法确认服务器版本，节点样式仍保存在本机，暂不提交。')
        const status = (await health.json()) as { capabilities?: { nodeStyleFields?: boolean } }
        if (status.capabilities?.nodeStyleFields !== true) {
          delay = 15000
          this.retryRequested = false
          this.notify(
            'error',
            '服务器版本不支持节点样式，修改保留在本机，升级服务器后将重试；请勿清除站点数据。',
          )
          return
        }
      }
      sentIds = batch.map((op) => op.opId)
      if (sentIds.length) await this.store.outboxState(sentIds, 'sending')
      if (batch.length) this.notify('pending')
      const start = Date.now(),
        response = await fetch('/api/sync', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', 'X-CSRF-Token': this.session?.csrf ?? '' },
          body: JSON.stringify({
            schemaVersion: 1,
            since: snapshot.serverSpace ? snapshot.serverSeq : 0,
            operations: batch,
          }),
          signal: AbortSignal.timeout(syncTimeoutMs),
        })
      if (this.stopped || generation !== this.generation) return
      if (response.status === 401 || response.status === 403) {
        try {
          if (await this.refresh()) {
            delay = 0
            return
          }
        } catch {
          // 继续按未授权处理。
        }
        this.updateSession(
          this.session
            ? { ...this.session, authenticated: false, csrf: undefined, subject: undefined }
            : null,
        )
        this.socket?.close()
        this.socket = null
        delay = null
        this.notify('unauthorized', '登录已失效或请求未获授权，请重新登录；本地修改仍保留。')
        return
      }
      if (!response.ok && errorClass(response.status) === 'attention') {
        await this.store.outboxState(
          sentIds,
          'attention',
          `云端拒绝请求（${response.status}），请检查内容或版本`,
        )
        this.notify('attention')
        return
      }
      if (!response.ok)
        throw await responseError(response, `云端暂不可用（${response.status}），稍后重试`)
      const result = (await response.json()) as SyncResponse
      if (snapshot.ownerSub !== null && snapshot.ownerSub !== result.subject) {
        delay = null
        this.identityMismatchPaused = true
        this.serverIdentityMismatchPaused = true
        if (sentIds.length) await this.store.outboxState(sentIds, 'retry')
        this.notify('account-mismatch', ACCOUNT_MISMATCH_DETAIL)
        return
      }
      const rejectedStyleIds = batch
        .filter(
          (op) =>
            hasStyleChanges(op) &&
            result.results.some((item) => item.opId === op.opId && item.status === 'rejected'),
        )
        .map((op) => op.opId)
      if (rejectedStyleIds.length) {
        // 旧服务端可能在能力检查后接管请求，并永久记住拒绝的 opId；新 ID 才能安全重试。
        await this.store.rekeyRejected(rejectedStyleIds)
        await this.store.acknowledge(result, sentIds)
        this.retryRequested = false
        delay = 15000
        this.notify(
          'error',
          '服务器拒绝节点样式修改，原内容和待同步队列已保留，请确认服务器版本后重试。',
        )
        return
      }
      this.store.calibrate(result.serverTime, start, Date.now())
      await this.store.acknowledge(
        result,
        batch.map((op) => op.opId),
      )
      this.attempts = 0
      const latest = this.store.getSnapshot().snapshot!
      this.notify(
        latest.drafts.length
          ? 'attention'
          : latest.outbox.some((op) => ['pending', 'retry', 'sending'].includes(op.state))
            ? 'pending'
            : 'synced',
      )
      this.connectSocket()
    } catch (error) {
      if (this.stopped || generation !== this.generation) return
      if (sentIds.length) await this.store.outboxState(sentIds, 'retry').catch(() => undefined)
      delay = Math.max(
        delay ?? 0,
        retryDelay(this.attempts++),
        error instanceof CloudResponseError ? error.retryAfterMs : 0,
      )
      this.notify(
        navigator.onLine ? 'error' : 'offline',
        navigator.onLine ? errorDetail(error) : '当前离线，修改已保留在本机；恢复联网后自动重试。',
      )
    } finally {
      this.busy = false
      if (generation === this.generation) {
        if (this.retryRequested) {
          this.retryRequested = false
          this.schedule(0)
        } else if (delay !== null) this.schedule(delay)
      }
    }
  }
}
