import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ClipboardEvent,
} from 'react'
import {
  Plus,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Undo2,
  Redo2,
  Upload,
  Download,
  Trash2,
  History,
  Keyboard,
  FileText,
  Pin,
  X,
  ChevronRight,
  Cloud,
  RefreshCw,
  LogOut,
  Search,
  Copy,
  CornerDownRight,
} from 'lucide-react'
import { appStore, context, message } from './app/store'
import type { Command } from './domain/commands'
import { createMap, uniqueName } from './domain/model'
import { clone, MARKERS, type MarkerCategory, type Space } from './domain/types'
import { editorState } from './persistence/editor-state'
import { restoreSelection, retainSelection, singleSelection } from './editor/selection'
import { Workspace } from './workspace/Workspace'
import {
  defaultWorkspace,
  loadWorkspace,
  normalizeWorkspace,
  saveWorkspace,
  type WorkspaceState,
} from './persistence/workspace-state'
import {
  BRANCHES_MIME,
  branchText,
  copyBranches,
  exportBackup,
  importBackup,
  importDrafts,
  type Backup,
} from './importers/backup'
import { parseOutline, type ImportDraft, type ImportResult } from './importers/outline'
import { parseXmindContent } from './importers/xmind'
import { SyncClient, type ConnectionStatus, type SessionInfo } from './sync/client'
import { MarkerIcon } from './components/MarkerIcon'
import { Dialog } from './components/Dialog'
import { ImportDialog } from './workspace/ImportDialog'
import { shortcuts } from './workspace/Shortcuts'
import { startAuthentication, startRegistration } from '@simplewebauthn/browser'
import { APP_VERSION } from './version'

const date = (at: number) =>
  new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(at)
async function authPost<T>(path: string, body: unknown, csrf?: string): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  })
  const result = (await response.json().catch(() => ({}))) as T & { error?: string }
  if (!response.ok) throw new Error(result.error || `认证请求失败（${response.status}）`)
  return result
}
export default function App() {
  const state = useSyncExternalStore(appStore.subscribe, appStore.getSnapshot),
    space = state.snapshot?.space
  const initialWorkspace = useRef(loadWorkspace())
  const [activeId, changeActiveId] = useState(() => editorState.activeMap()),
    [selection, setSelection] = useState(() => restoreSelection(editorState.map(activeId))),
    [workspace, setWorkspace] = useState<WorkspaceState>(
      () => initialWorkspace.current ?? defaultWorkspace(activeId),
    ),
    [left, setLeft] = useState(true),
    [right, setRight] = useState(true)
  const selectedId = selection.activeId
  const setSelectedId = useCallback((id: string | null) => setSelection(singleSelection(id)), [])
  const setActiveId = useCallback((id: string) => {
    setWorkspace((current) => {
      const pane = current.panes[current.activePaneId]
      if (!pane) return current
      if (pane.mapId === id) {
        changeActiveId(id)
        setSelection(pane.selection)
        return current
      }
      const nextSelection = restoreSelection(editorState.map(id))
      const next = {
        ...current,
        panes: {
          ...current.panes,
          [pane.id]: { ...pane, mapId: id, scopeNodeId: null, selection: nextSelection },
        },
      }
      saveWorkspace(next)
      changeActiveId(id)
      setSelection(nextSelection)
      return next
    })
  }, [])
  const [dialog, setDialog] = useState(''),
    [toast, setToast] = useState(''),
    [editRequest, setEditRequest] = useState(0),
    [focusRequest, setFocusRequest] = useState(0),
    [fitRequests, setFitRequests] = useState<Record<string, number>>({}),
    [filter, setFilter] = useState('')
  const [syncStatus, setSyncStatus] = useState<ConnectionStatus>('local'),
    [syncDetail, setSyncDetail] = useState(''),
    [session, setSession] = useState<SessionInfo | null>(null)
  const [name, setName] = useState(''),
    [dialogError, setDialogError] = useState(''),
    [recoveryNotice, setRecoveryNotice] = useState(''),
    [setupToken, setSetupToken] = useState(''),
    [recoveryCode, setRecoveryCode] = useState(''),
    [recoveryCodes, setRecoveryCodes] = useState<string[]>([]),
    [deleteId, setDeleteId] = useState(''),
    [purgeConfirmed, setPurgeConfirmed] = useState(false)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null),
    sync = useRef<SyncClient | null>(null),
    draggedTab = useRef<string | null>(null),
    loginContainer = useRef<HTMLDivElement>(null)
  const notify = useCallback((text: string) => {
    setToast(text)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 5000)
  }, [])
  const guard = useCallback(
    async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await action()
      } catch (error) {
        notify(message(error))
        return undefined
      }
    },
    [notify],
  )
  useEffect(() => {
    void appStore.init()
  }, [])
  useEffect(() => {
    if (!state.snapshot) return
    const client = new SyncClient(
      appStore,
      (status, detail) => {
        setSyncStatus(status)
        setSyncDetail(detail ?? '')
      },
      setSession,
      import.meta.env.DEV,
    )
    sync.current = client
    client.start()
    const reconnect = () => {
      if (!navigator.onLine) setSyncStatus('offline')
      // online 只表示网络连接变化，不保证认证接口此时已可达；由客户端继续重试。
      client.retry()
    }
    const leave = () => {
      if (document.visibilityState === 'hidden') void guard(() => appStore.flushHistory(true))
      else reconnect()
    }
    const pagehide = () => void appStore.flushHistory(true).catch(() => undefined)
    const timer = setInterval(() => void guard(() => appStore.flushHistory()), 15000)
    window.addEventListener('online', reconnect)
    window.addEventListener('offline', reconnect)
    document.addEventListener('visibilitychange', leave)
    window.addEventListener('pagehide', pagehide)
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (appStore.hasUnpersisted) event.preventDefault()
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => {
      client.stop()
      clearInterval(timer)
      window.removeEventListener('online', reconnect)
      window.removeEventListener('offline', reconnect)
      document.removeEventListener('visibilitychange', leave)
      window.removeEventListener('pagehide', pagehide)
      window.removeEventListener('beforeunload', beforeUnload)
    }
  }, [!!state.snapshot, guard])
  const tabs = Object.values(space?.tabs ?? {})
    .filter((tab) => tab.open && space?.maps[tab.mapId]?.deletedAt === null)
    .sort((a, b) => a.order - b.order)
  const map =
    space?.tabs[activeId]?.open && space.maps[activeId]?.deletedAt === null
      ? space.maps[activeId]
      : undefined
  const node = selectedId ? map?.nodes[selectedId] : undefined
  const activePane = workspace.panes[workspace.activePaneId]
  useEffect(() => {
    const activePane = workspace.panes[workspace.activePaneId]
    if (
      space &&
      !map &&
      (activePane?.mapId !== '' || (!initialWorkspace.current && activePane?.mapId === ''))
    )
      setActiveId(tabs[0]?.mapId ?? '')
  }, [
    !!space,
    map?.id,
    tabs.map((t) => t.mapId).join(','),
    workspace.activePaneId,
    workspace.panes,
  ])
  useEffect(() => {
    if (!space) return
    const fallback = tabs[0]?.mapId ?? activeId
    const next = normalizeWorkspace(workspace, new Set(Object.keys(space.maps)), fallback)
    if (JSON.stringify(next) !== JSON.stringify(workspace)) setWorkspace(next)
    const activePane = next.panes[next.activePaneId]
    if (activePane && activePane.mapId !== activeId) setActiveId(activePane.mapId)
  }, [
    !!space,
    Object.keys(space?.maps ?? {}).join(','),
    workspace.activePaneId,
    workspace.panes[workspace.activePaneId]?.mapId,
  ])
  const changeWorkspace = useCallback((next: WorkspaceState) => {
    initialWorkspace.current = next
    setWorkspace(next)
    saveWorkspace(next)
    const activePane = next.panes[next.activePaneId]
    if (activePane) {
      changeActiveId(activePane.mapId)
      setSelection(activePane.selection)
    }
  }, [])
  const activatePane = useCallback((paneId: string) => {
    setWorkspace((current) => {
      const pane = current.panes[paneId]
      if (!pane || current.activePaneId === paneId) return current
      const next = { ...current, activePaneId: paneId }
      saveWorkspace(next)
      changeActiveId(pane.mapId)
      setSelection(pane.selection)
      return next
    })
  }, [])
  const paneSelection = useCallback(
    (paneId: string, nextSelection: ReturnType<typeof singleSelection>) => {
      setWorkspace((current) => {
        const pane = current.panes[paneId]
        if (!pane) return current
        const next = {
          ...current,
          panes: { ...current.panes, [paneId]: { ...pane, selection: nextSelection } },
        }
        saveWorkspace(next)
        if (current.activePaneId === paneId) setSelection(nextSelection)
        return next
      })
    },
    [],
  )
  const commandForMap = useCallback(
    async (mapId: string, action: Command) => {
      try {
        const selected = await appStore.command(mapId, action)
        return selected
      } catch (error) {
        notify(message(error))
        throw error
      }
    },
    [notify],
  )
  useEffect(() => {
    appStore.setActive(activeId)
  }, [activeId])
  useEffect(() => {
    if (map) setSelection((old) => retainSelection(old, new Set(Object.keys(map.nodes))))
  }, [map])
  useLayoutEffect(() => {
    if (!space || (!map && tabs.length)) return
    editorState.saveActiveMap(map?.id ?? '')
    if (map)
      editorState.updateMap(map.id, {
        selectedId: node?.id ?? null,
        selectedIds: selection.ids.filter((id) => !!map.nodes[id]),
        anchorId: selection.anchorId && map.nodes[selection.anchorId] ? selection.anchorId : null,
      })
  }, [!!space, map?.id, selection, !!node, tabs.length])
  const command = useCallback(
    async (command: Command) => {
      if (
        selection.ids.length > 1 &&
        !['delete-many', 'fold', 'layout', 'reparent-many', 'marker-many'].includes(command.type)
      )
        setSelectedId(selectedId)
      try {
        const selected = await appStore.command(activeId, command)
        if (selected) setSelectedId(selected)
        return selected
      } catch (error) {
        notify(message(error))
        throw error
      }
    },
    [activeId, notify, selection.ids.length, selectedId, setSelectedId],
  )
  // 适应请求按分区独立递增，切换活动分区不改变其他画布收到的请求。
  const requestFit = useCallback((paneId: string) => {
    setFitRequests((current) => ({ ...current, [paneId]: (current[paneId] ?? 0) + 1 }))
  }, [])
  const autoLayout = () => {
    if (!map) return
    void guard(async () => {
      await command({ type: 'layout' })
      requestFit(workspace.activePaneId)
      notify('已均衡布局')
    })
  }
  const drillDown = () => {
    if (!map || !node || !node.parentId || activePane?.scopeNodeId === node.id) return
    setWorkspace((current) => {
      const pane = current.panes[current.activePaneId]
      if (!pane || pane.mapId !== map.id) return current
      const next = {
        ...current,
        panes: {
          ...current.panes,
          [pane.id]: { ...pane, scopeNodeId: node.id, selection: singleSelection(node.id) },
        },
      }
      initialWorkspace.current = next
      saveWorkspace(next)
      setSelection(singleSelection(node.id))
      return next
    })
    requestFit(workspace.activePaneId)
  }
  const run = (command: Command) => {
    void commandSafe(command)
  }
  const commandSafe = async (action: Command) => {
    try {
      return await command(action)
    } catch {
      return undefined
    }
  }
  const tabChange = (id: string, change: Partial<Space['tabs'][string]>) =>
    guard(() =>
      appStore.transform(
        (space) => {
          const next = clone(space)
          next.tabs[id] = {
            ...(next.tabs[id] ?? {
              mapId: id,
              order: Object.keys(next.tabs).length,
              open: false,
              pinned: false,
            }),
            ...change,
          }
          return next
        },
        undefined,
        false,
      ),
    )
  const openMap = async (id: string) => {
    await tabChange(id, { open: true })
    setActiveId(id)
  }
  const closeTab = async (id: string) => {
    await guard(() => appStore.flushHistory(true))
    await tabChange(id, { open: false })
    if (id === activeId) setActiveId(tabs.find((tab) => tab.mapId !== id)?.mapId ?? '')
  }
  const openDialog = (kind: string) => {
    setDialogError('')
    setPurgeConfirmed(false)
    if (kind === 'new') setName('')
    if (kind === 'rename') setName(map?.title ?? '')
    setDialog(kind)
  }
  const newMap = async () => {
    try {
      let id = ''
      await appStore.transform(
        (space) => {
          const next = createMap(space, name || uniqueName(space, '未命名脑图'), context())
          id = Object.keys(next.maps).find((id) => !space.maps[id])!
          return next
        },
        undefined,
        false,
      )
      setActiveId(id)
      setDialog('')
    } catch (error) {
      setDialogError(message(error))
    }
  }
  const importResult = useCallback(
    async (result: ImportResult, intoSelection: boolean) => {
      let last = activeId
      await appStore.transform(
        (space) => {
          const next = importDrafts(
            space,
            result,
            context(),
            intoSelection && selectedId && space.maps[activeId]?.nodes[selectedId]
              ? { mapId: activeId, nodeId: selectedId }
              : undefined,
          )
          last =
            Object.keys(next.maps)
              .filter((id) => !space.maps[id])
              .at(-1) ?? activeId
          return next
        },
        intoSelection && selectedId ? activeId : undefined,
        true,
        true,
      )
      setActiveId(last)
      requestFit(workspace.activePaneId)
    },
    [activeId, selectedId, workspace.activePaneId, requestFit],
  )
  const importJson = async (backup: Backup) => {
    let active = activeId
    await appStore.transform(
      (space) => {
        const next = importBackup(space, backup, context())
        active =
          Object.values(next.tabs)
            .filter((tab) => tab.open && !space.maps[tab.mapId])
            .sort((a, b) => a.order - b.order)
            .at(-1)?.mapId ?? activeId
        return next
      },
      undefined,
      false,
      true,
    )
    setActiveId(active)
    requestFit(workspace.activePaneId)
  }
  const branchClipboard = useRef<{ drafts: ImportDraft[]; text: string } | null>(null)
  const copySelected = () => {
    if (!map || !node) return
    const drafts = copyBranches(map, selection.ids.length > 1 ? selection.ids : [node.id]),
      text = branchText(drafts)
    branchClipboard.current = { drafts, text }
    void guard(async () => {
      await navigator.clipboard.writeText(text)
      notify('已复制分支')
    })
  }
  const pasteSelected = () => {
    setSelectedId(selectedId)
    void guard(async () => {
      const text = await navigator.clipboard.readText()
      const internal = branchClipboard.current
      const result =
        internal?.text === text ? { drafts: internal.drafts, warnings: [] } : parseOutline(text)
      await importResult(result, true)
      notify('已粘贴内容')
    })
  }
  const paste = (event: ClipboardEvent) => {
    event.preventDefault()
    setSelectedId(selectedId)
    const data = event.clipboardData,
      internal = data.getData('application/x-mindme-branch+json'),
      internals = data.getData(BRANCHES_MIME),
      xml = ['application/x-xmind', 'application/x-xmind-xml', 'application/xml', 'text/xml']
        .map((type) => data.getData(type))
        .find((value) => value.includes('xmap-content'))
    void guard(async () => {
      let result: ImportResult
      if (internals) {
        if (internals.length > 16 * 1024 * 1024) throw new Error('剪贴板内容过大')
        const value = JSON.parse(internals) as { drafts?: ImportDraft[] }
        if (
          !value ||
          !Array.isArray(value.drafts) ||
          !value.drafts.every((draft) => Array.isArray(draft.nodes))
        )
          throw new Error('多分支剪贴板格式损坏')
        result = { drafts: value.drafts, warnings: [] }
      } else if (internal) {
        if (internal.length > 16 * 1024 * 1024) throw new Error('剪贴板内容过大')
        const draft = JSON.parse(internal) as ImportDraft
        if (!draft || !Array.isArray(draft.nodes)) throw new Error('分支剪贴板格式损坏')
        result = { drafts: [draft], warnings: [] }
      } else if (branchClipboard.current?.text === data.getData('text/plain'))
        result = { drafts: branchClipboard.current.drafts, warnings: [] }
      else if (xml) result = parseXmindContent(xml)
      else {
        result = parseOutline(data.getData('text/plain'))
        result.warnings.push('剪贴板仅提供纯文字，外部标记无法保留；XMind 文件导入可保留可识别标记')
      }
      await importResult(result, true)
      notify(result.warnings.join('；') || '已粘贴分支')
    })
  }
  const download = (single = false) => {
    if (!space) return
    const backup = exportBackup(space, Date.now(), single ? activeId : undefined),
      url = URL.createObjectURL(
        new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }),
      ),
      anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `mindme-${single ? (map?.title.replace(/[/\\:*?"<>|]/g, '_').slice(0, 70) ?? '脑图') : '全空间'}-${new Date().toISOString().slice(0, 10)}.json`
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 10000)
  }
  useEffect(() => {
    if (
      dialog !== 'login' ||
      session?.authMode === 'passkey' ||
      !session?.googleClientId ||
      !session.configured
    )
      return
    let cancelled = false
    const setup = () => {
      const google = (
        window as unknown as {
          google?: {
            accounts: {
              id: {
                initialize: (options: object) => void
                renderButton: (element: HTMLElement, options: object) => void
              }
            }
          }
        }
      ).google
      if (cancelled || !google || !loginContainer.current) return
      google.accounts.id.initialize({
        client_id: session.googleClientId,
        callback: ({ credential }: { credential: string }) => {
          void guard(async () => {
            await sync.current!.login(credential)
            setSession(sync.current!.session)
            setDialog('')
          })
        },
      })
      google.accounts.id.renderButton(loginContainer.current, {
        theme: 'outline',
        size: 'large',
        text: 'signin_with',
      })
    }
    const existing = document.querySelector<HTMLScriptElement>('script[data-google-identity]')
    if (existing) {
      setup()
      existing.addEventListener('load', setup, { once: true })
    } else {
      const script = document.createElement('script')
      script.src = 'https://accounts.google.com/gsi/client'
      script.async = true
      script.dataset.googleIdentity = 'true'
      script.onload = setup
      script.onerror = () => setDialogError('无法加载 Google 登录，请检查网络后重试')
      document.head.append(script)
    }
    return () => {
      cancelled = true
      existing?.removeEventListener('load', setup)
    }
  }, [dialog, session?.googleClientId, guard])
  const passkeyLogin = () =>
    void guard(async () => {
      const { flowId, options } = await authPost<{
        flowId: string
        options: Parameters<typeof startAuthentication>[0]['optionsJSON']
      }>('/auth/passkey/login/options', {})
      const response = await startAuthentication({ optionsJSON: options })
      await authPost('/auth/passkey/login/verify', { flowId, response })
      await sync.current!.completeExternalLogin()
      setSession(sync.current!.session)
      setRecoveryCode('')
      setRecoveryNotice('')
      setDialogError('')
    })
  const registerPasskey = () =>
    void guard(async () => {
      const csrf = session?.authenticated ? session.csrf : undefined
      const request = await authPost<{
        flowId: string
        options: Parameters<typeof startRegistration>[0]['optionsJSON']
      }>(
        '/auth/passkey/register/options',
        !session?.authenticated || (session.setupAvailable && !session.passkeyReady)
          ? { setupToken }
          : {},
        csrf,
      )
      const response = await startRegistration({ optionsJSON: request.options })
      const result = await authPost<{ recoveryCodes?: string[] }>(
        '/auth/passkey/register/verify',
        { flowId: request.flowId, response, ...(setupToken ? { setupToken } : {}) },
        csrf,
      )
      if (result.recoveryCodes) setRecoveryCodes(result.recoveryCodes)
      setSetupToken('')
      await sync.current!.completeExternalLogin()
      setSession(sync.current!.session)
      setDialogError('')
      notify('Passkey 已添加')
    })
  const recoverLogin = () =>
    void guard(async () => {
      await authPost('/auth/recovery/login', {
        code: recoveryCode,
      })
      setRecoveryCode('')
      await sync.current!.completeExternalLogin()
      setSession(sync.current!.session)
      setRecoveryNotice('此恢复码已使用。请添加新的 Passkey，并随后更换剩余恢复码。')
      notify('已通过离线恢复码登录')
    })
  const rotateRecoveryCodes = () =>
    void guard(async () => {
      const result = await authPost<{ recoveryCodes: string[] }>(
        '/auth/recovery/rotate',
        {},
        session?.csrf,
      )
      setRecoveryCodes(result.recoveryCodes)
    })
  const save = () => {
    void guard(async () => {
      await appStore.retrySave()
      sync.current?.retry()
      notify('已保存到本机')
    })
  }
  useEffect(() => {
    const onSave = (event: globalThis.KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === 's' &&
        !event.isComposing
      ) {
        event.preventDefault()
        event.stopPropagation()
        void guard(async () => {
          await appStore.retrySave()
          sync.current?.retry()
          notify('已保存到本机')
        })
      }
    }
    window.addEventListener('keydown', onSave, true)
    return () => window.removeEventListener('keydown', onSave, true)
  }, [guard, notify])
  if (!state.snapshot)
    return (
      <main className="boot">
        <div className="brand">
          <i />
          mindme
          <span className="app-version" aria-label={`当前版本 v${APP_VERSION}`}>
            v{APP_VERSION}
          </span>
        </div>
        <h1>{state.status === 'error' ? '暂时无法读取本地空间' : '正在打开你的脑图…'}</h1>
        {state.error && <p role="alert">{state.error}</p>}
        <p>内容保存在此浏览器的本地数据库中。</p>
        {state.status === 'error' && (
          <button className="primary" onClick={() => location.reload()}>
            重新打开
          </button>
        )}
      </main>
    )
  const visibleSyncStatus: ConnectionStatus =
    syncStatus === 'synced' &&
    (state.pendingTasks > 0 ||
      state.status !== 'saved' ||
      state.snapshot.outbox.some((op) => ['pending', 'retry', 'sending'].includes(op.state)))
      ? 'pending'
      : syncStatus
  const statusLabels: Record<ConnectionStatus, string> = {
    local: '本地空间',
    connecting: '连接云端',
    synced: '已同步',
    pending: '待同步',
    offline: '离线 · 本地保存',
    unauthorized: '登录以同步',
    error: '同步失败',
    attention: '有冲突草稿',
    'account-mismatch': '本地账号不匹配',
  }
  const accountMismatch = visibleSyncStatus === 'account-mismatch'
  const maps = Object.values(space!.maps).filter((map) => map.deletedAt === null),
    trash = Object.values(space!.maps).filter((map) => map.deletedAt !== null)
  return (
    <div className="application">
      <header className="top">
        <div className="brand">
          <i />
          mindme
          <span className="app-version" aria-label={`当前版本 v${APP_VERSION}`}>
            v{APP_VERSION}
          </span>
        </div>
        <span className="space-label">
          个人空间 <ChevronRight size={12} />
        </span>
        <div className="top-right">
          <span className={`save-state ${state.status === 'error' ? 'danger' : ''}`}>
            {state.status !== 'error' && (state.status === 'saving' || state.pendingTasks > 0)
              ? '正在本地保存…'
              : state.status === 'error'
                ? '本地未保存'
                : '本地已保存'}
          </span>
          <button
            className={`sync-status ${['error', 'attention', 'account-mismatch'].includes(visibleSyncStatus) ? 'warn' : ''}`}
            title={syncDetail || '查看同步与账号'}
            onClick={() => openDialog('login')}
          >
            <Cloud size={14} />
            {statusLabels[visibleSyncStatus]}
          </button>
          <button className="avatar" aria-label="账号与同步" onClick={() => openDialog('login')}>
            我
          </button>
        </div>
      </header>
      {state.status === 'error' && (
        <div className="save-error" role="alert">
          {state.error}。内存中的内容仍保留，可重试保存或导出备份。
          <button onClick={save}>重试保存</button>
          <button onClick={() => download()}>导出应急备份</button>
        </div>
      )}
      <div
        className="layout"
        style={
          {
            '--left-width': left ? '200px' : '0px',
            '--right-width': right ? '248px' : '0px',
          } as React.CSSProperties
        }
      >
        <aside className={`sidebar ${left ? '' : 'hidden'}`} aria-label="脑图列表">
          <button className="new-map" onClick={() => openDialog('new')}>
            <Plus size={15} />
            新建脑图
          </button>
          <div className="section-label">
            我的脑图 <span>· {maps.length}</span>
          </div>
          <label className="map-search">
            <Search size={13} />
            <input
              aria-label="按名称筛选脑图"
              placeholder="查找脑图"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          </label>
          <nav className="files">
            {maps
              .filter((map) => map.title.includes(filter))
              .sort((a, b) => b.updatedAt - a.updatedAt)
              .map((item) => (
                <button
                  key={item.id}
                  title={item.title}
                  className={`file ${item.id === activeId ? 'active' : ''}`}
                  onClick={() => void openMap(item.id)}
                >
                  <FileText size={15} />
                  <span>{item.title}</span>
                </button>
              ))}
            {!maps.length && <p className="muted">新建一张，开始整理想法。</p>}
          </nav>
          <div className="side-bottom">
            <button onClick={() => openDialog('import')}>
              <Upload size={14} />
              导入内容
            </button>
            <button onClick={() => openDialog('backup')}>
              <Download size={14} />
              备份与恢复
            </button>
            <button onClick={() => openDialog('trash')}>
              <Trash2 size={14} />
              回收站 <span>{trash.length || ''}</span>
            </button>
            <button onClick={() => openDialog('shortcuts')}>
              <Keyboard size={14} />
              快捷键
            </button>
            {!!state.snapshot.drafts.length && (
              <button className="danger" onClick={() => openDialog('drafts')}>
                冲突草稿 · {state.snapshot.drafts.length}
              </button>
            )}
            <p className="sidehint">Mac · 个人使用</p>
          </div>
        </aside>
        <main className="editor">
          <div className="tabs" role="tablist" aria-label="已打开脑图">
            {tabs.map((tab) => (
              <div
                key={tab.mapId}
                className={`tab ${tab.mapId === activeId ? 'active' : ''}`}
                draggable
                onDragStart={(event) => {
                  draggedTab.current = tab.mapId
                  event.dataTransfer.effectAllowed = 'copy'
                  event.dataTransfer.setData('text/x-mindme-map', tab.mapId)
                }}
                onDragEnd={() => {
                  draggedTab.current = null
                  window.dispatchEvent(
                    new CustomEvent('mindme-tab-dragend', { detail: { mapId: tab.mapId } }),
                  )
                }}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault()
                  const from = draggedTab.current
                  if (!from || from === tab.mapId) return
                  void guard(() =>
                    appStore.transform(
                      (space) => {
                        const next = clone(space),
                          ordered = Object.values(next.tabs)
                            .sort((a, b) => a.order - b.order)
                            .map((t) => t.mapId),
                          source = ordered.indexOf(from)
                        ordered.splice(source, 1)
                        ordered.splice(ordered.indexOf(tab.mapId), 0, from)
                        ordered.forEach((id, index) => {
                          next.tabs[id].order = index
                        })
                        return next
                      },
                      undefined,
                      false,
                    ),
                  )
                }}
              >
                <button
                  className="tab-pin"
                  aria-label={`${tab.pinned ? '取消固定' : '固定'} ${space!.maps[tab.mapId].title}`}
                  onClick={() => void tabChange(tab.mapId, { pinned: !tab.pinned })}
                >
                  {tab.pinned ? <Pin size={11} /> : <span>◇</span>}
                </button>
                <button
                  role="tab"
                  aria-selected={tab.mapId === activeId}
                  className="tab-title"
                  onClick={() => setActiveId(tab.mapId)}
                >
                  {space!.maps[tab.mapId].title}
                </button>
                <button
                  className="tab-close"
                  aria-label={`关闭 ${space!.maps[tab.mapId].title}`}
                  onClick={() => void closeTab(tab.mapId)}
                >
                  <X size={13} />
                </button>
              </div>
            ))}
            <button aria-label="新建脑图标签" onClick={() => openDialog('new')}>
              <Plus size={18} />
            </button>
          </div>
          <div className="toolbar">
            <button
              aria-label={left ? '收起脑图列表' : '展开脑图列表'}
              title="脑图列表"
              onClick={() => setLeft(!left)}
            >
              {left ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
            </button>
            <span className="tool-title">脑图</span>
            <button
              disabled={!node}
              onClick={() => node && run({ type: 'add', nodeId: node.id, kind: 'child' })}
            >
              ＋ 子主题 <kbd>Tab</kbd>
            </button>
            <button
              disabled={!node?.parentId}
              onClick={() => node && run({ type: 'add', nodeId: node.id, kind: 'sibling' })}
            >
              ＋ 同级主题
            </button>
            <i />
            <button disabled={!node} onClick={() => node && run({ type: 'fold', nodeId: node.id })}>
              折叠 / 展开
            </button>
            <button
              disabled={!node || !node.parentId || activePane?.scopeNodeId === node.id}
              title="以下方选中节点为中心，只显示它下面的内容"
              onClick={drillDown}
            >
              <CornerDownRight size={14} />
              下钻
            </button>
            <button disabled={!map} title="均衡分配左右分支并整理整张脑图" onClick={autoLayout}>
              自动布局
            </button>
            <button
              aria-label="撤销"
              title="撤销 ⌘Z"
              disabled={!state.canUndo}
              onClick={() => void guard(() => appStore.history(activeId, 'undo'))}
            >
              <Undo2 size={15} />
            </button>
            <button
              aria-label="重做"
              title="重做 ⇧⌘Z"
              disabled={!state.canRedo}
              onClick={() => void guard(() => appStore.history(activeId, 'redo'))}
            >
              <Redo2 size={15} />
            </button>
            <div className="toolbar-right">
              <button onClick={() => openDialog('import')}>导入</button>
              <button disabled={!map} onClick={() => openDialog('history')}>
                <History size={13} />
                历史版本
              </button>
              <button disabled={!map} onClick={() => openDialog('map-menu')}>
                •••
              </button>
              <i />
              <button
                aria-label={right ? '收起节点面板' : '展开节点面板'}
                onClick={() => setRight(!right)}
              >
                {right ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
              </button>
            </div>
          </div>
          {space && tabs.length ? (
            <Workspace
              space={space!}
              workspace={workspace}
              activeSelection={selection}
              onWorkspaceChange={changeWorkspace}
              onActivate={activatePane}
              onSelection={paneSelection}
              onCommand={commandForMap}
              onHistory={(mapId, direction) => void guard(() => appStore.history(mapId, direction))}
              paste={paste}
              save={save}
              notify={notify}
              copied={(draft, text) => {
                branchClipboard.current = { drafts: draft, text }
              }}
              editRequest={editRequest}
              focusRequest={focusRequest}
              fitRequests={fitRequests}
            />
          ) : (
            <div className="empty-canvas">
              <div className="empty-mark">＋</div>
              <h1>给想法一个起点</h1>
              <p>打开左侧脑图，或从一张空白脑图开始。</p>
              <button className="primary" onClick={() => openDialog('new')}>
                新建脑图
              </button>
            </div>
          )}
        </main>
        <aside className={`properties ${right ? '' : 'hidden'}`} aria-label="节点属性">
          <div className="panel-heading">
            {selection.ids.length > 1 ? `已选 ${selection.ids.length} 个节点` : '节点'}
          </div>
          {selection.ids.length > 1 && (
            <p className="muted small selection-note">
              可拖动任一已选节点整批挂接。下方显示当前节点，编辑和新增会收为当前节点；图标对全部所选节点生效；复制、剪切、删除对全部所选分支生效。
            </p>
          )}
          <section>
            <label className="field-label">主题文字</label>
            <div className="node-text-preview">{node?.text || '选择一个节点'}</div>
            <div className="property-meta">
              <span>层级</span>
              <b>
                {!node
                  ? '—'
                  : !node.parentId
                    ? '中心主题'
                    : node.parentId === map?.rootId
                      ? '一级分支'
                      : '子主题'}
              </b>
            </div>
            <div className="button-row">
              <button disabled={!node} onClick={() => setEditRequest((v) => v + 1)}>
                编辑
              </button>
              <button
                className="danger"
                disabled={
                  !node ||
                  (selection.ids.length > 1
                    ? !map || selection.ids.includes(map.rootId)
                    : !node.parentId)
                }
                onClick={() =>
                  node &&
                  run(
                    selection.ids.length > 1
                      ? { type: 'delete-many', nodeIds: selection.ids }
                      : { type: 'delete', nodeId: node.id },
                  )
                }
              >
                删除分支
              </button>
            </div>
            <p className="muted small">
              {node && !node.parentId
                ? '中心主题与脑图名称同步更新。'
                : selection.ids.length > 1
                  ? '删除所选分支时包含各自子分支，可撤销。'
                  : '删除节点时包含整个子分支，可撤销。'}
            </p>
          </section>
          <section>
            <h3>
              常用标记 <span>兼容 XMind 8</span>
            </h3>
            {(Object.keys(MARKERS) as MarkerCategory[]).map((category) => (
              <div className="marker-group" key={category}>
                <span>
                  {category === 'priority'
                    ? '优先级'
                    : category === 'progress'
                      ? '任务进度'
                      : '旗子'}
                </span>
                <div>
                  {MARKERS[category].map((value, index) => (
                    <button
                      key={value}
                      aria-label={`${category === 'priority' ? '优先级' : category === 'progress' ? '进度' : '旗子'} ${category === 'progress' ? `${index}/8` : value}`}
                      aria-pressed={
                        selection.ids.length > 0 &&
                        selection.ids.every((id) => map?.nodes[id]?.markers[category] === value)
                      }
                      disabled={!node}
                      onClick={(event) => {
                        if (!node) return
                        run(
                          selection.ids.length > 1
                            ? { type: 'marker-many', nodeIds: selection.ids, category, value }
                            : { type: 'marker', nodeId: node.id, category, value },
                        )
                        // 鼠标点选后回到画布，键盘激活按钮时保留按钮焦点。
                        if (event.detail > 0) setFocusRequest((request) => request + 1)
                      }}
                    >
                      <svg width="20" height="20">
                        <MarkerIcon category={category} value={value} />
                      </svg>
                    </button>
                  ))}
                </div>
              </div>
            ))}
            <p className="muted small">
              同类替换，不同类别可并存；多选时统一设置，全部已有该标记时再点统一移除。
            </p>
          </section>
          <section>
            <h3>分支操作</h3>
            <div className="branch-actions">
              <div>
                <button disabled={!node} onClick={copySelected}>
                  复制分支
                </button>
                <button onClick={pasteSelected}>粘贴内容</button>
              </div>
              <button
                disabled={!node?.parentId}
                onClick={() => node && run({ type: 'add', nodeId: node.id, kind: 'parent' })}
              >
                新增父主题 <kbd>⌘ ↵</kbd>
              </button>
              <button
                disabled={!node}
                onClick={() => node && run({ type: 'fold', nodeId: node.id, recursive: true })}
              >
                子树全部折叠 / 展开
              </button>
              <div>
                <button
                  disabled={!node?.parentId}
                  onClick={() => node && run({ type: 'sort', nodeId: node.id, delta: -1 })}
                >
                  同级上移
                </button>
                <button
                  disabled={!node?.parentId}
                  onClick={() => node && run({ type: 'sort', nodeId: node.id, delta: 1 })}
                >
                  同级下移
                </button>
              </div>
            </div>
          </section>
          <div className="panel-foot">
            <span className="status-dot" />
            {state.status === 'saved' ? '本地自动保存已开启' : '正在保留你的修改'}
            <button onClick={save}>立即保存</button>
            <p>滚轮缩放，按住空白处左键拖动画布。</p>
          </div>
        </aside>
      </div>
      {!!toast && (
        <div className="toast" role="status">
          {toast}
          <button aria-label="关闭提示" onClick={() => setToast('')}>
            <X size={12} />
          </button>
        </div>
      )}
      {dialog === 'import' && (
        <ImportDialog
          close={() => setDialog('')}
          target={!!node}
          importResult={importResult}
          importJson={importJson}
        />
      )}
      {['new', 'rename'].includes(dialog) && (
        <Dialog title={dialog === 'new' ? '新建脑图' : '重命名脑图'} close={() => setDialog('')}>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              if (dialog === 'new') void newMap()
              else if (map)
                void appStore
                  .command(map.id, { type: 'text', nodeId: map.rootId, text: name })
                  .then(() => setDialog(''))
                  .catch((error) => setDialogError(message(error)))
            }}
          >
            <label className="field-label" htmlFor="map-name">
              脑图名称
            </label>
            <input
              id="map-name"
              autoFocus
              value={name}
              placeholder="未命名脑图"
              onChange={(event) => setName(event.target.value)}
            />
            <p className="muted">名称与中心主题文字保持一致，回收站中的名称仍然保留。</p>
            {dialogError && (
              <p role="alert" className="error-message">
                {dialogError}
              </p>
            )}
            <div className="dialog-actions">
              <button type="button" onClick={() => setDialog('')}>
                取消
              </button>
              <button className="primary">{dialog === 'new' ? '创建脑图' : '保存名称'}</button>
            </div>
          </form>
        </Dialog>
      )}
      {dialog === 'map-menu' && map && (
        <Dialog title={map.title} close={() => setDialog('')}>
          <div className="menu-actions">
            <button onClick={() => openDialog('rename')}>重命名脑图</button>
            <button
              onClick={() => {
                download(true)
                setDialog('')
              }}
            >
              导出当前脑图 JSON
            </button>
            <button
              className="danger"
              onClick={() =>
                void guard(async () => {
                  await appStore.command(map.id, { type: 'trash' })
                  setDialog('')
                  notify('已移入回收站，保留 30 天')
                })
              }
            >
              移入回收站
            </button>
          </div>
        </Dialog>
      )}
      {dialog === 'backup' && (
        <Dialog title="备份与恢复" close={() => setDialog('')}>
          <p className="muted">
            JSON 备份包含节点、标记、折叠与标签状态。不包含历史版本和回收站；恢复时创建新副本。
          </p>
          <div className="menu-actions">
            <button disabled={!map} onClick={() => download(true)}>
              <Download size={15} />
              导出当前脑图
            </button>
            <button onClick={() => download()}>
              <Download size={15} />
              导出全空间 · {maps.length} 张脑图
            </button>
            <button onClick={() => openDialog('import')}>
              <Upload size={15} />
              导入 JSON 备份
            </button>
          </div>
        </Dialog>
      )}
      {dialog === 'history' && map && (
        <Dialog title="历史版本" close={() => setDialog('')} wide>
          <p className="muted">
            连续编辑每 5 分钟保存一个版本，短会话离开时补存，最多保留 10 个。恢复前保存当前内容。
          </p>
          {map.history.length ? (
            [...map.history].reverse().map((version) => (
              <div className="record" key={version.id}>
                <div>
                  <b>{date(version.at)}</b>
                  <p>
                    {version.content.title} · {Object.keys(version.content.nodes).length} 个节点 ·{' '}
                    {version.reason === 'restore'
                      ? '恢复前保护版本'
                      : version.reason === 'leave'
                        ? '离开时补存'
                        : '自动版本'}
                  </p>
                </div>
                <button
                  onClick={() => {
                    setDeleteId(version.id)
                    openDialog('restore')
                  }}
                >
                  查看并恢复
                </button>
              </div>
            ))
          ) : (
            <div className="empty-record">尚未生成历史版本。内容会持续自动保存到本机。</div>
          )}
        </Dialog>
      )}
      {dialog === 'restore' && map && (
        <Dialog title="恢复历史版本" close={() => openDialog('history')} wide>
          {(() => {
            const version = map.history.find((v) => v.id === deleteId)
            return (
              version && (
                <>
                  <p>
                    {date(version.at)} · {Object.keys(version.content.nodes).length} 个节点
                  </p>
                  <div className="version-preview">
                    {Object.values(version.content.nodes)
                      .slice(0, 40)
                      .map((node) => (
                        <p key={node.id}>
                          {node.parentId ? '↳ ' : ''}
                          {node.text}
                        </p>
                      ))}
                  </div>
                  <p className="muted">
                    当前内容会先保存为保护版本。此恢复会作为新的修改参与同步。
                  </p>
                  <button
                    className="primary"
                    onClick={() =>
                      void guard(async () => {
                        await appStore.command(map.id, { type: 'restore', versionId: deleteId })
                        setDialog('')
                        setSelectedId(null)
                        requestFit(workspace.activePaneId)
                      })
                    }
                  >
                    确认恢复此版本
                  </button>
                </>
              )
            )
          })()}
        </Dialog>
      )}
      {dialog === 'trash' && (
        <Dialog title={`回收站 · ${trash.length}`} close={() => setDialog('')} wide>
          <p className="muted">删除后保留 30 天，到期自动清理；在永久删除前名称仍占用。</p>
          {trash.length ? (
            trash.map((item) => (
              <div className="record" key={item.id}>
                <div>
                  <b>{item.title}</b>
                  <p>
                    {date(item.deletedAt!)} ·{' '}
                    {Math.max(
                      0,
                      Math.ceil((item.deletedAt! + 30 * 86400000 - Date.now()) / 86400000),
                    )}{' '}
                    天后清理
                  </p>
                </div>
                <button
                  onClick={() =>
                    void guard(async () => {
                      await appStore.command(item.id, { type: 'untrash' })
                      setActiveId(item.id)
                      notify('脑图已恢复')
                    })
                  }
                >
                  恢复
                </button>
                <button
                  className="danger"
                  onClick={() => {
                    setDeleteId(item.id)
                    openDialog('purge')
                  }}
                >
                  永久删除
                </button>
              </div>
            ))
          ) : (
            <div className="empty-record">回收站是空的</div>
          )}
        </Dialog>
      )}
      {dialog === 'purge' && (
        <Dialog title="永久删除脑图" close={() => openDialog('trash')}>
          <p>「{space!.maps[deleteId]?.title}」的节点与历史版本将永久删除，无法恢复。</p>
          <label className="confirm-check">
            <input
              type="checkbox"
              checked={purgeConfirmed}
              onChange={(event) => setPurgeConfirmed(event.target.checked)}
            />
            我确认这张脑图不再需要，且理解无法恢复
          </label>
          <div className="dialog-actions">
            <button onClick={() => openDialog('trash')}>取消</button>
            <button
              className="danger-solid"
              disabled={!purgeConfirmed}
              onClick={() =>
                void guard(async () => {
                  await appStore.command(deleteId, { type: 'purge' })
                  openDialog('trash')
                })
              }
            >
              确认永久删除
            </button>
          </div>
        </Dialog>
      )}
      {dialog === 'shortcuts' && (
        <Dialog title="macOS 快捷键" close={() => setDialog('')} wide>
          <p className="muted">
            画布聚焦时使用。文字输入、中文输入法组合和系统文字剪贴板优先处理。
          </p>
          <div className="shortcuts">
            {shortcuts.map(([key, action]) => (
              <div key={key}>
                <span>{action}</span>
                <kbd>{key}</kbd>
              </div>
            ))}
          </div>
        </Dialog>
      )}
      {dialog === 'drafts' && (
        <Dialog title="冲突草稿" close={() => setDialog('')} wide>
          <p className="muted">以下修改没有覆盖云端内容。请复制需要的文字，再选择保留位置。</p>
          {state.snapshot.drafts.map((draft) => (
            <div className="draft" key={draft.id}>
              <b>{draft.reason}</b>
              <p className="muted">{date(draft.at)}</p>
              <textarea aria-label="冲突草稿内容" readOnly value={draft.text} />
              <div className="button-row">
                <button
                  onClick={() =>
                    void guard(async () => {
                      await navigator.clipboard.writeText(draft.text)
                      notify('已复制草稿')
                    })
                  }
                >
                  <Copy size={14} />
                  复制草稿
                </button>
                <button
                  className="danger"
                  onClick={() => void guard(() => appStore.discardDraft(draft.id))}
                >
                  已找回，移除此草稿
                </button>
              </div>
            </div>
          ))}
        </Dialog>
      )}
      {dialog === 'login' && (
        <Dialog
          title="账号与同步"
          close={() => {
            setDialog('')
            setRecoveryCodes([])
            setRecoveryCode('')
            setSetupToken('')
            setRecoveryNotice('')
          }}
        >
          <div className="account-summary">
            <Cloud size={30} />
            <h3>{statusLabels[visibleSyncStatus]}</h3>
            <p className="muted">
              {syncDetail ||
                (visibleSyncStatus === 'offline'
                  ? '当前离线，修改已保留在本机；恢复联网后自动重试。'
                  : session === null
                    ? '暂时无法确认云端登录状态，联网后会自动重试；本地修改仍保留。'
                    : session.configured
                      ? session.authenticated
                        ? '已登录，修改会在本地保存后自动同步。'
                        : session.authMode === 'passkey'
                          ? '使用 Passkey 验证身份后，同步本地保存的修改。'
                          : '指定 Google 账号登录后，同步本地保存的修改。'
                      : '云端尚未配置。当前可在本机编辑、保存和导出备份。')}
            </p>
          </div>
          <div className="record">
            <span>本地保存</span>
            <b>{state.status === 'saved' ? '已完成' : '等待保存'}</b>
          </div>
          <div className="record">
            <span>待确认操作</span>
            <b>{state.snapshot.outbox.length}</b>
          </div>
          {accountMismatch && (
            <div className="save-error" role="alert">
              <p>
                此浏览器保存空间与当前登录账号不匹配。先下载当前可用脑图
                JSON，在新的浏览器配置登录目标账号后导入。JSON
                不含历史版本、回收站和冲突草稿；旧浏览器配置仍保留更完整的本地数据，请勿清除。若刚切换账号或点过重试，先别继续重试；单凭此提示无法确认待同步操作是否已到达云端。
              </p>
              <button className="primary" onClick={() => download()}>
                <Download size={14} />
                下载全空间 JSON 备份
              </button>
            </div>
          )}
          <div className="button-row">
            <button
              disabled={accountMismatch}
              onClick={() => {
                sync.current?.retry()
                notify('已重新尝试同步')
              }}
            >
              <RefreshCw size={14} />
              重试同步
            </button>
            {session?.authenticated && (
              <button
                onClick={() =>
                  void guard(async () => {
                    await sync.current?.logout()
                    setDialog('')
                    setRecoveryCodes([])
                  })
                }
              >
                <LogOut size={14} />
                退出登录
              </button>
            )}
          </div>
          {session?.authMode === 'passkey' && session.configured && !session.authenticated && (
            <div className="auth-actions">
              {session.passkeyReady && (
                <button className="primary" onClick={passkeyLogin}>
                  使用 Passkey 登录
                </button>
              )}
              {!session.passkeyReady && session.setupAvailable && (
                <div className="auth-setup">
                  <label htmlFor="passkey-setup-token">首次设置令牌</label>
                  <input
                    id="passkey-setup-token"
                    type="password"
                    autoComplete="off"
                    value={setupToken}
                    onChange={(event) => setSetupToken(event.target.value)}
                  />
                  <button onClick={registerPasskey} disabled={!setupToken.trim()}>
                    创建 Passkey 并显示恢复码
                  </button>
                </div>
              )}
              {!session.passkeyReady && !session.setupAvailable && (
                <p className="muted">Passkey 尚未初始化，请在服务器上生成一次性设置令牌。</p>
              )}
              {session.passkeyReady && (
                <div className="auth-setup">
                  <label htmlFor="recovery-code">离线恢复码</label>
                  <input
                    id="recovery-code"
                    type="password"
                    autoComplete="one-time-code"
                    value={recoveryCode}
                    onChange={(event) => setRecoveryCode(event.target.value)}
                    placeholder="输入一个未使用的恢复码"
                  />
                  <button onClick={recoverLogin} disabled={!recoveryCode.trim()}>
                    使用恢复码登录
                  </button>
                </div>
              )}
            </div>
          )}
          {session?.authMode !== 'passkey' && !session?.authenticated && (
            <div ref={loginContainer} className="google-login" />
          )}
          {session?.authMode === 'passkey' && session.authenticated && (
            <div className="auth-actions">
              {!session.passkeyReady && session.setupAvailable && (
                <div className="auth-setup">
                  <label htmlFor="passkey-setup-token-authenticated">首次设置令牌</label>
                  <input
                    id="passkey-setup-token-authenticated"
                    type="password"
                    autoComplete="off"
                    value={setupToken}
                    onChange={(event) => setSetupToken(event.target.value)}
                  />
                  <button onClick={registerPasskey} disabled={!setupToken.trim()}>
                    设置 Passkey 并生成恢复码
                  </button>
                </div>
              )}
              {(session.passkeyReady || !session.setupAvailable) && (
                <button onClick={registerPasskey}>添加 Passkey</button>
              )}
              <button onClick={rotateRecoveryCodes}>更换离线恢复码</button>
              {recoveryNotice && <p className="muted">{recoveryNotice}</p>}
            </div>
          )}
          {recoveryCodes.length > 0 && (
            <section className="recovery-codes" aria-live="polite">
              <h4>请立即离线保存这组恢复码</h4>
              <p>每个恢复码只能使用一次。关闭此窗口后将无法再次查看。</p>
              <textarea readOnly value={recoveryCodes.join('\n')} rows={8} />
              <button
                onClick={() =>
                  void guard(async () => {
                    await navigator.clipboard.writeText(recoveryCodes.join('\n'))
                    notify('恢复码已复制')
                  })
                }
              >
                <Copy size={14} />
                复制恢复码
              </button>
            </section>
          )}
          {dialogError && <p className="error-message">{dialogError}</p>}
          <button onClick={() => openDialog('drafts')}>
            查看冲突草稿 · {state.snapshot.drafts.length}
          </button>
        </Dialog>
      )}
    </div>
  )
}
