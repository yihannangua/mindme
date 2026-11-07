import { useEffect, useRef, useState } from 'react'
import {
  type ClipboardEvent,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react'
import {
  Columns2,
  CornerDownRight,
  GripVertical,
  Maximize2,
  Minimize2,
  Redo2,
  Rows2,
  Undo2,
  X,
} from 'lucide-react'
import type { ViewState } from '../app/store'
import type { Command } from '../domain/commands'
import type { MarkerCategory, MindMap, Space } from '../domain/types'
import type { ImportDraft } from '../importers/outline'
import { MarkerIcon } from '../components/MarkerIcon'
import { Canvas } from '../editor/Canvas'
import { singleSelection, type NodeSelection } from '../editor/selection'
import { frequentMarkers, markerLabel, type MarkerUsage } from '../persistence/marker-usage'
import {
  clampRatio,
  swapPanePositions,
  type SplitDirection,
  type WorkspaceNode,
  type WorkspacePane,
  type WorkspaceState,
} from '../persistence/workspace-state'
import { MAP_TAB_DRAG_TYPE, PANE_MAP_DRAG_TYPE } from './drag-types'

interface Props {
  space: Space
  workspace: WorkspaceState
  activeSelection: NodeSelection
  onWorkspaceChange: (workspace: WorkspaceState) => void
  onActivate: (paneId: string) => void
  onSelection: (paneId: string, selection: NodeSelection) => void
  onCommand: (
    mapId: string,
    command: Command,
    applied?: (selectedId: string | undefined) => void,
  ) => Promise<unknown>
  onHistory: (mapId: string, direction: 'undo' | 'redo') => void
  paste: (event: ClipboardEvent) => void
  save: () => void
  notify: (text: string) => void
  copied: (drafts: ImportDraft[], text: string) => void
  editRequest: number
  focusRequest: number
  fitRequests: Record<string, number>
  saveState: Pick<ViewState, 'status' | 'pendingTasks' | 'error'>
  notification: string
  closeNotification: () => void
  canUndo: boolean
  canRedo: boolean
  markerUsage: MarkerUsage[]
  onMarker: (category: MarkerCategory, value: string) => void
  onFit: (paneId: string) => void
}

function replacePane(
  root: WorkspaceNode,
  paneId: string,
  replacement: WorkspaceNode,
): WorkspaceNode {
  if (root.type === 'pane') return root.paneId === paneId ? replacement : root
  return {
    ...root,
    first: replacePane(root.first, paneId, replacement),
    second: replacePane(root.second, paneId, replacement),
  }
}
function updateSplit(root: WorkspaceNode, id: string, ratio: number): WorkspaceNode {
  if (root.type === 'pane') return root
  if (root.id === id) return { ...root, ratio: clampRatio(ratio) }
  return {
    ...root,
    first: updateSplit(root.first, id, ratio),
    second: updateSplit(root.second, id, ratio),
  }
}
function removePane(root: WorkspaceNode, paneId: string): WorkspaceNode | null {
  if (root.type === 'pane') return root.paneId === paneId ? null : root
  if (root.first.type === 'pane' && root.first.paneId === paneId) return root.second
  if (root.second.type === 'pane' && root.second.paneId === paneId) return root.first
  const first = removePane(root.first, paneId),
    second = removePane(root.second, paneId)
  if (!first) return second
  if (!second) return first
  return { ...root, first, second }
}
function leafCount(node: WorkspaceNode): number {
  return node.type === 'pane' ? 1 : leafCount(node.first) + leafCount(node.second)
}
function scopePath(
  map: MindMap,
  scopeNodeId: string | null,
): { id: string | null; text: string }[] {
  if (!scopeNodeId || !map.nodes[scopeNodeId]) return [{ id: null, text: map.title }]
  const path: { id: string; text: string }[] = []
  let current: string | null = scopeNodeId
  while (current && map.nodes[current]) {
    const node: MindMap['nodes'][string] = map.nodes[current]
    if (node.id !== map.rootId || node.text !== map.title)
      path.unshift({ id: node.id, text: node.text })
    current = node.parentId
  }
  return [{ id: null, text: map.title }, ...path]
}
type SplitPreset =
  | { type: 'copy' }
  | { type: 'selection'; nodeId: string | null }
  | { type: 'blank' }
  | { type: 'map'; mapId: string }
type PaneDirection = 'left' | 'right' | 'up' | 'down'
type DropTarget =
  | { type: 'map'; paneId: string; direction: SplitDirection; placement: 'first' | 'second' }
  | { type: 'pane'; paneId: string }
  | { type: 'pane-map'; paneId: string }
type PaneFullscreen = { paneId: string; mode: 'native' | 'viewport' }
const PANE_DRAG_TYPE = 'text/x-mindme-pane'
function PaneHeader({
  pane,
  map,
  onChange,
  active,
  canReorder,
  onDragStart,
  onDragEnd,
  onGripPointerDown,
  onMove,
  fullscreenMode,
  saveState,
  retrySave,
}: {
  pane: WorkspacePane
  map?: MindMap
  onChange: (patch: Partial<WorkspacePane>) => void
  active: boolean
  canReorder: boolean
  onDragStart: (event: DragEvent<HTMLButtonElement>) => void
  onDragEnd: () => void
  onGripPointerDown: (event: PointerEvent<HTMLButtonElement>) => void
  onMove: (direction: PaneDirection) => void
  fullscreenMode?: PaneFullscreen['mode']
  saveState: Pick<ViewState, 'status' | 'pendingTasks' | 'error'>
  retrySave: () => void
}) {
  const effectiveScopeId = map && pane.scopeNodeId !== map.rootId ? pane.scopeNodeId : null
  const scopeText = map && effectiveScopeId ? map.nodes[effectiveScopeId]?.text : ''
  const summary = map ? `${map.title} · ${scopeText || '整张脑图'}` : '空白分区'
  const breadcrumbs = map ? scopePath(map, effectiveScopeId) : []
  return (
    <div className={`workspace-pane-header ${active ? 'active' : ''}`}>
      {canReorder && (
        <button
          type="button"
          className="workspace-pane-grip"
          draggable
          aria-label="拖动画布调整位置"
          aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown"
          title="拖动到另一画布交换位置，也可使用方向键"
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onPointerDown={onGripPointerDown}
          onKeyDown={(event) => {
            const direction = {
              ArrowLeft: 'left',
              ArrowRight: 'right',
              ArrowUp: 'up',
              ArrowDown: 'down',
            }[event.key] as PaneDirection | undefined
            if (!direction) return
            event.preventDefault()
            event.stopPropagation()
            onMove(direction)
          }}
        >
          <GripVertical size={15} />
        </button>
      )}
      <div className="workspace-pane-summary" aria-label={`当前分区：${summary}`}>
        {map && pane.scopeNodeId ? (
          <span className="workspace-pane-breadcrumbs" aria-label="下钻路径">
            {breadcrumbs.map((item, index) => (
              <span className="workspace-pane-breadcrumb" key={`${item.id ?? 'map'}-${index}`}>
                {index > 0 && <span className="workspace-pane-breadcrumb-separator">/</span>}
                {index < breadcrumbs.length - 1 ? (
                  <button
                    type="button"
                    onClick={() => onChange({ scopeNodeId: item.id })}
                    aria-label={`返回到${item.text}`}
                    title={`返回到${item.text}`}
                  >
                    {item.text}
                  </button>
                ) : (
                  <span className="workspace-pane-breadcrumb-current">{item.text}</span>
                )}
              </span>
            ))}
          </span>
        ) : (
          <span>{summary}</span>
        )}
      </div>
      {fullscreenMode && (
        <div
          className={`workspace-fullscreen-save ${saveState.status === 'error' ? 'error' : ''}`}
          role={saveState.status === 'error' ? 'alert' : 'status'}
          title={saveState.error || undefined}
        >
          <span>
            {saveState.status === 'error'
              ? '本地未保存'
              : saveState.status === 'saving' || saveState.pendingTasks > 0
                ? '正在本地保存…'
                : '本地已保存'}
          </span>
          {saveState.status === 'error' && (
            <button onPointerDown={(event) => event.preventDefault()} onClick={retrySave}>
              重试保存
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function PaneActions({
  paneId,
  paneCount,
  onSplit,
  onRemove,
  fullscreen,
  fullscreenMode,
  canFullscreen,
  onFullscreen,
}: {
  paneId: string
  paneCount: number
  onSplit: (direction: SplitDirection) => void
  onRemove: () => void
  fullscreen: boolean
  fullscreenMode?: PaneFullscreen['mode']
  canFullscreen: boolean
  onFullscreen: () => void
}) {
  return (
    <div className="workspace-pane-actions" aria-label={`画布 ${paneId} 操作`}>
      {fullscreenMode === 'viewport' && (
        <span className="workspace-fullscreen-mode">窗口内全屏</span>
      )}
      {!fullscreen && (
        <>
          <button aria-label="左右拆分画布" title="左右拆分画布" onClick={() => onSplit('row')}>
            <Columns2 size={15} />
          </button>
          <button aria-label="上下拆分画布" title="上下拆分画布" onClick={() => onSplit('column')}>
            <Rows2 size={15} />
          </button>
        </>
      )}
      <button
        className={fullscreen ? 'workspace-fullscreen-exit' : undefined}
        aria-label={fullscreen ? '退出画布全屏' : '全屏显示当前画布'}
        title={fullscreen ? '退出画布全屏' : '全屏显示当前画布'}
        disabled={!canFullscreen}
        onClick={onFullscreen}
      >
        {fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        {fullscreen && <span>退出全屏</span>}
      </button>
      {paneCount > 1 && !fullscreen && (
        <button
          className="workspace-pane-close"
          aria-label="关闭当前画布"
          title="关闭当前画布"
          onClick={onRemove}
        >
          <X size={15} />
        </button>
      )}
    </div>
  )
}

export function Workspace({
  space,
  workspace,
  activeSelection,
  onWorkspaceChange,
  onActivate,
  onSelection,
  onCommand,
  onHistory,
  paste,
  save,
  notify,
  copied,
  editRequest,
  focusRequest,
  fitRequests,
  saveState,
  notification,
  closeNotification,
  canUndo,
  canRedo,
  markerUsage,
  onMarker,
  onFit,
}: Props) {
  const workspaceRef = useRef(workspace),
    saveStateRef = useRef(saveState),
    rootRef = useRef<HTMLDivElement>(null),
    resizeCleanup = useRef<(() => void) | null>(null),
    touchDragCleanup = useRef<(() => void) | null>(null),
    draggingPane = useRef<string | null>(null),
    pendingPaneDrop = useRef<{ source: string; target: string } | null>(null)
  workspaceRef.current = workspace
  saveStateRef.current = saveState
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null),
    [fullscreen, setFullscreen] = useState<PaneFullscreen | null>(null)
  const pendingDrop = useRef<{
    mapId: string
    target: { paneId: string; direction: SplitDirection; placement: 'first' | 'second' }
  } | null>(null)
  const panes = workspace.panes
  const findPane = (id: string) =>
    Array.from(
      rootRef.current?.querySelectorAll<HTMLElement>('.workspace-pane[data-pane-id]') ?? [],
    ).find((element) => element.dataset.paneId === id)
  const applyWorkspace = (next: WorkspaceState) => {
    workspaceRef.current = next
    onWorkspaceChange(next)
  }
  useEffect(() => {
    const changed = () => {
      const element = document.fullscreenElement as HTMLElement | null,
        paneId = element?.dataset.paneId
      if (element && paneId && rootRef.current?.contains(element))
        setFullscreen({ paneId, mode: 'native' })
      else setFullscreen((current) => (current?.mode === 'native' ? null : current))
    }
    document.addEventListener('fullscreenchange', changed)
    return () => document.removeEventListener('fullscreenchange', changed)
  }, [])
  useEffect(() => {
    if (!fullscreen) return
    const escape = (event: globalThis.KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        event.isComposing ||
        document.querySelector('dialog[open]') ||
        (event.target instanceof Element && event.target.closest('.canvas'))
      )
        return
      event.preventDefault()
      event.stopPropagation()
      if (fullscreen.mode === 'native' && document.fullscreenElement)
        void document.exitFullscreen().catch(() => notify('无法退出系统全屏，请使用浏览器退出全屏'))
      else setFullscreen(null)
    }
    window.addEventListener('keydown', escape, true)
    return () => window.removeEventListener('keydown', escape, true)
  }, [fullscreen, notify])
  useEffect(() => {
    if (fullscreen && !panes[fullscreen.paneId]) setFullscreen(null)
  }, [fullscreen, panes])
  useEffect(
    () => () => {
      resizeCleanup.current?.()
      touchDragCleanup.current?.()
    },
    [],
  )
  const focusPaneCanvas = (paneId: string) => {
    findPane(paneId)?.querySelector<HTMLElement>('.canvas')?.focus({ preventScroll: true })
  }
  const toggleFullscreen = async (paneId: string) => {
    if (fullscreen?.paneId === paneId) {
      if (fullscreen.mode === 'native' && document.fullscreenElement) {
        try {
          await document.exitFullscreen()
          focusPaneCanvas(paneId)
        } catch {
          notify('无法退出系统全屏，请使用浏览器退出全屏')
        }
      } else {
        setFullscreen(null)
        focusPaneCanvas(paneId)
      }
      return
    }
    const element = findPane(paneId)
    if (!element) return
    if (document.fullscreenElement && !document.fullscreenElement.contains(element)) {
      notify('请先退出当前全屏')
      return
    }
    onActivate(paneId)
    if (document.fullscreenEnabled && element.requestFullscreen) {
      try {
        await element.requestFullscreen()
        if (document.fullscreenElement === element) {
          setFullscreen({ paneId, mode: 'native' })
          focusPaneCanvas(paneId)
        }
        return
      } catch {
        // 系统全屏不可用时仅放大到当前浏览器窗口，不改变分区布局。
      }
    }
    setFullscreen({ paneId, mode: 'viewport' })
    focusPaneCanvas(paneId)
    notify('浏览器未允许系统全屏，已放大到当前窗口')
  }
  useEffect(() => {
    const onHome = (event: globalThis.KeyboardEvent) => {
      if (
        event.key !== 'Home' ||
        event.repeat ||
        event.isComposing ||
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        document.querySelector('dialog[open]')
      )
        return
      const target = event.target
      if (
        target instanceof HTMLElement &&
        target.closest(
          'input, select, textarea:not(.node-input-capture), button, a, [contenteditable]:not([contenteditable="false"]), [role="separator"]',
        )
      )
        return
      const paneId = workspace.activePaneId
      if (!panes[paneId]) return
      event.preventDefault()
      event.stopPropagation()
      void toggleFullscreen(paneId)
    }
    window.addEventListener('keydown', onHome, true)
    return () => window.removeEventListener('keydown', onHome, true)
  }, [fullscreen, panes, toggleFullscreen, workspace.activePaneId])
  const swapPanes = (source: string, target: string) => {
    if (saveStateRef.current.status === 'error') {
      notify('请先恢复本地保存，再调整画布位置')
      return false
    }
    if ([source, target].some((id) => findPane(id)?.querySelector('.inline-editor'))) {
      notify('请先完成当前文字编辑，再调整画布位置')
      return false
    }
    const current = workspaceRef.current,
      root = swapPanePositions(current.root, source, target)
    if (root === current.root) return false
    applyWorkspace({ ...current, root })
    return true
  }
  const beginTouchPaneDrag = (event: PointerEvent<HTMLButtonElement>, paneId: string) => {
    if (
      !['touch', 'pen'].includes(event.pointerType) ||
      !event.isPrimary ||
      event.button !== 0 ||
      fullscreen ||
      touchDragCleanup.current
    )
      return
    const grip = event.currentTarget,
      pointerId = event.pointerId,
      startX = event.clientX,
      startY = event.clientY
    let moved = false,
      target: string | null = null
    const move = (moveEvent: globalThis.PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return
      if (!moved && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 8) return
      moved = true
      moveEvent.preventDefault()
      const element = document
        .elementFromPoint(moveEvent.clientX, moveEvent.clientY)
        ?.closest<HTMLElement>('.workspace-pane[data-pane-id]')
      target =
        element && rootRef.current?.contains(element) && element.dataset.paneId !== paneId
          ? (element.dataset.paneId ?? null)
          : null
      setDropTarget(target ? { type: 'pane', paneId: target } : null)
    }
    const cleanup = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('blur', cleanup)
      grip.removeEventListener('lostpointercapture', cancel)
      touchDragCleanup.current = null
      setDropTarget(null)
      if (grip.hasPointerCapture?.(pointerId)) grip.releasePointerCapture?.(pointerId)
    }
    const end = (endEvent: globalThis.PointerEvent) => {
      if (endEvent.pointerId !== pointerId) return
      const selected = moved ? target : null
      cleanup()
      if (selected) swapPanes(paneId, selected)
    }
    const cancel = (cancelEvent: globalThis.PointerEvent) => {
      if (cancelEvent.pointerId === pointerId) cleanup()
    }
    touchDragCleanup.current = cleanup
    window.addEventListener('pointermove', move, { passive: false })
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('blur', cleanup)
    grip.addEventListener('lostpointercapture', cancel)
    try {
      grip.setPointerCapture(pointerId)
    } catch {
      // 没有指针捕获时仍由窗口监听完成或取消拖动。
    }
    event.preventDefault()
  }
  const movePane = (paneId: string, direction: PaneDirection) => {
    const source = findPane(paneId)
    if (!source) return
    const bounds = source.getBoundingClientRect(),
      x = bounds.left + bounds.width / 2,
      y = bounds.top + bounds.height / 2
    const candidates = Array.from(
      rootRef.current?.querySelectorAll<HTMLElement>('.workspace-pane[data-pane-id]') ?? [],
    )
      .filter((element) => element !== source)
      .map((element) => {
        const rect = element.getBoundingClientRect(),
          dx = rect.left + rect.width / 2 - x,
          dy = rect.top + rect.height / 2 - y,
          primary =
            direction === 'left' ? -dx : direction === 'right' ? dx : direction === 'up' ? -dy : dy,
          cross = direction === 'left' || direction === 'right' ? Math.abs(dy) : Math.abs(dx)
        return { id: element.dataset.paneId, primary, score: primary + 2 * cross }
      })
      .filter((item) => item.id && item.primary > 1)
      .sort((a, b) => a.score - b.score)
    const target = candidates[0]?.id
    if (!target) return
    if (swapPanes(paneId, target))
      requestAnimationFrame(() =>
        findPane(paneId)?.querySelector<HTMLButtonElement>('.workspace-pane-grip')?.focus(),
      )
  }
  const updatePane = (paneId: string, patch: Partial<WorkspacePane>) => {
    const pane = panes[paneId]
    if (pane)
      onWorkspaceChange({ ...workspace, panes: { ...panes, [paneId]: { ...pane, ...patch } } })
  }
  const assignMapToPane = (paneId: string, mapId: string) => {
    const current = workspaceRef.current,
      pane = current.panes[paneId],
      nextMap = space.maps[mapId]
    if (!pane || !nextMap || nextMap.deletedAt !== null) return
    if (pane.mapId === mapId) {
      notify('这个分区已经显示该脑图')
      return
    }
    applyWorkspace({
      ...current,
      activePaneId: paneId,
      panes: {
        ...current.panes,
        [paneId]: { ...pane, mapId, scopeNodeId: null, selection: singleSelection(null) },
      },
    })
    onFit(paneId)
    notify(`已切换为「${nextMap.title}」`)
  }
  const split = (
    paneId: string,
    direction: SplitDirection,
    preset: SplitPreset,
    placement: 'first' | 'second' = 'second',
    activateNew = false,
  ) => {
    const source = panes[paneId]
    if (!source) return
    const newId = `pane-${crypto.randomUUID()}`
    const selectedNodeId = preset.type === 'selection' ? preset.nodeId : null
    const mapId = preset.type === 'blank' ? '' : preset.type === 'map' ? preset.mapId : source.mapId
    const replacement: WorkspaceNode = {
      type: 'split',
      id: `split-${crypto.randomUUID()}`,
      direction,
      ratio: 0.5,
      first: placement === 'first' ? { type: 'pane', paneId: newId } : { type: 'pane', paneId },
      second: placement === 'first' ? { type: 'pane', paneId } : { type: 'pane', paneId: newId },
    }
    onWorkspaceChange({
      ...workspace,
      activePaneId: activateNew ? newId : workspace.activePaneId,
      panes: {
        ...panes,
        [newId]: {
          id: newId,
          mapId,
          scopeNodeId:
            preset.type === 'selection'
              ? selectedNodeId
              : preset.type === 'copy'
                ? source.scopeNodeId
                : null,
          selection: selectedNodeId ? singleSelection(selectedNodeId) : singleSelection(null),
        },
      },
      root: replacePane(workspace.root, paneId, replacement),
    })
  }
  const close = (paneId: string) => {
    const root = removePane(workspace.root, paneId)
    if (!root || root === workspace.root) return
    const nextPanes = { ...panes }
    delete nextPanes[paneId]
    const activePaneId =
      workspace.activePaneId === paneId ? Object.keys(nextPanes)[0] : workspace.activePaneId
    onWorkspaceChange({ ...workspace, root, panes: nextPanes, activePaneId })
    if (activePaneId !== workspace.activePaneId) onActivate(activePaneId)
  }
  const beginResize = (
    event: PointerEvent<HTMLDivElement>,
    node: Extract<WorkspaceNode, { type: 'split' }>,
  ) => {
    if (event.button !== 0 || !event.isPrimary || resizeCleanup.current) return
    const divider = event.currentTarget,
      parent = divider.parentElement!,
      rect = parent.getBoundingClientRect(),
      dividerRect = divider.getBoundingClientRect(),
      gap = Number.parseFloat(getComputedStyle(parent).gap) || 0,
      extent =
        (node.direction === 'row'
          ? rect.width - dividerRect.width
          : rect.height - dividerRect.height) -
        2 * gap,
      start = node.direction === 'row' ? event.clientX : event.clientY,
      pointerId = event.pointerId,
      initialRatio = node.ratio
    if (extent <= 0) return
    const move = (moveEvent: globalThis.PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return
      const current = workspaceRef.current,
        coordinate = node.direction === 'row' ? moveEvent.clientX : moveEvent.clientY,
        ratio = initialRatio + (coordinate - start) / extent
      applyWorkspace({ ...current, root: updateSplit(current.root, node.id, ratio) })
    }
    const cleanup = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      window.removeEventListener('blur', cleanup)
      divider.removeEventListener('lostpointercapture', end)
      resizeCleanup.current = null
      if (divider.hasPointerCapture?.(pointerId)) divider.releasePointerCapture?.(pointerId)
    }
    const end = (endEvent: globalThis.PointerEvent) => {
      if (endEvent.pointerId === pointerId) cleanup()
    }
    resizeCleanup.current = cleanup
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    window.addEventListener('blur', cleanup)
    divider.addEventListener('lostpointercapture', end)
    try {
      divider.setPointerCapture(pointerId)
    } catch {
      // 窗口级监听仍可在不支持指针捕获的浏览器中处理拖动。
    }
    event.preventDefault()
  }
  const resizeByKey = (
    event: KeyboardEvent<HTMLDivElement>,
    node: Extract<WorkspaceNode, { type: 'split' }>,
  ) => {
    const backward = node.direction === 'row' ? 'ArrowLeft' : 'ArrowUp',
      forward = node.direction === 'row' ? 'ArrowRight' : 'ArrowDown'
    if (![backward, forward, 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    event.stopPropagation()
    const current = workspaceRef.current,
      ratio =
        event.key === 'Home'
          ? 0.15
          : event.key === 'End'
            ? 0.85
            : node.ratio + (event.key === forward ? 1 : -1) * (event.shiftKey ? 0.1 : 0.02)
    applyWorkspace({ ...current, root: updateSplit(current.root, node.id, ratio) })
  }
  const dropPlacement = (event: DragEvent<HTMLElement>, paneId: string) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    const horizontal = Math.min(x / rect.width, 1 - x / rect.width)
    const vertical = Math.min(y / rect.height, 1 - y / rect.height)
    if (horizontal < vertical)
      return {
        paneId,
        direction: 'row' as const,
        placement: x < rect.width / 2 ? ('first' as const) : ('second' as const),
      }
    return {
      paneId,
      direction: 'column' as const,
      placement: y < rect.height / 2 ? ('first' as const) : ('second' as const),
    }
  }
  const handleDragOver = (event: DragEvent<HTMLElement>, paneId: string) => {
    if (event.dataTransfer.types.includes(PANE_MAP_DRAG_TYPE)) {
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
      setDropTarget({ type: 'pane-map', paneId })
      return
    }
    if (event.dataTransfer.types.includes(PANE_DRAG_TYPE)) {
      if (!draggingPane.current || draggingPane.current === paneId || fullscreen) {
        setDropTarget(null)
        return
      }
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      setDropTarget({ type: 'pane', paneId })
      return
    }
    if (!event.dataTransfer.types.includes(MAP_TAB_DRAG_TYPE)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setDropTarget({ type: 'map', ...dropPlacement(event, paneId) })
  }
  const handleDrop = (event: DragEvent<HTMLElement>, paneId: string) => {
    event.preventDefault()
    if (event.dataTransfer.types.includes(PANE_MAP_DRAG_TYPE)) {
      const mapId = event.dataTransfer.getData(PANE_MAP_DRAG_TYPE)
      setDropTarget(null)
      if (mapId) assignMapToPane(paneId, mapId)
      return
    }
    if (event.dataTransfer.types.includes(PANE_DRAG_TYPE)) {
      const source = event.dataTransfer.getData(PANE_DRAG_TYPE)
      setDropTarget(null)
      if (source && source === draggingPane.current && source !== paneId && !fullscreen)
        pendingPaneDrop.current = { source, target: paneId }
      return
    }
    if (!event.dataTransfer.types.includes(MAP_TAB_DRAG_TYPE)) return
    const mapId = event.dataTransfer.getData(MAP_TAB_DRAG_TYPE)
    const target = dropPlacement(event, paneId)
    setDropTarget(null)
    if (!mapId || !space.maps[mapId] || !target) return
    // drop 只代表浏览器接受了目标；等拖动源的 dragend 才提交布局，避免拖动尚未结束时重排 DOM。
    pendingDrop.current = { mapId, target }
  }
  useEffect(() => {
    return () => {
      pendingDrop.current = null
      pendingPaneDrop.current = null
      draggingPane.current = null
    }
  }, [])
  useEffect(() => {
    const clear = () => setDropTarget(null)
    window.addEventListener('dragend', clear)
    return () => window.removeEventListener('dragend', clear)
  }, [])
  useEffect(() => {
    const finishDrop = (event: Event) => {
      const mapId = (event as CustomEvent<{ mapId?: string }>).detail?.mapId
      if (!mapId) return
      const pending = pendingDrop.current
      if (!pending || pending.mapId !== mapId) return
      pendingDrop.current = null
      if (!space.maps[mapId]) return
      split(
        pending.target.paneId,
        pending.target.direction,
        { type: 'map', mapId },
        pending.target.placement,
        true,
      )
    }
    window.addEventListener('mindme-tab-dragend', finishDrop)
    return () => window.removeEventListener('mindme-tab-dragend', finishDrop)
  }, [space, workspace, onWorkspaceChange])
  const runPaneCommand = (
    paneId: string,
    mapId: string,
    action: Command,
    selection: NodeSelection,
  ) => {
    if (
      selection.ids.length > 1 &&
      ![
        'delete-many',
        'fold',
        'fold-all',
        'layout',
        'reparent-many',
        'marker-many',
        'style-many',
      ].includes(action.type)
    )
      onSelection(paneId, singleSelection(selection.activeId))
    return onCommand(mapId, action, (id) => {
      if (id) onSelection(paneId, singleSelection(id))
    })
  }
  const render = (node: WorkspaceNode): ReactNode => {
    if (node.type === 'split')
      return (
        <div
          className={`workspace-split ${node.direction}`}
          style={
            {
              '--workspace-first': `${node.ratio}fr`,
              '--workspace-second': `${1 - node.ratio}fr`,
            } as CSSProperties
          }
        >
          <div className="workspace-child">{render(node.first)}</div>
          <div
            className="workspace-divider"
            role="separator"
            tabIndex={0}
            aria-label={node.direction === 'row' ? '左右分区大小' : '上下分区大小'}
            aria-orientation={node.direction === 'row' ? 'vertical' : 'horizontal'}
            aria-valuemin={15}
            aria-valuemax={85}
            aria-valuenow={Math.round(node.ratio * 100)}
            aria-valuetext={`${Math.round(node.ratio * 100)}%`}
            onPointerDown={(event) => beginResize(event, node)}
            onKeyDown={(event) => resizeByKey(event, node)}
          />
          <div className="workspace-child">{render(node.second)}</div>
        </div>
      )
    const pane = panes[node.paneId],
      map = pane ? space.maps[pane.mapId] : undefined
    if (!pane) return null
    const selection = workspace.activePaneId === pane.id ? activeSelection : pane.selection
    const activeNode = selection.activeId ? map?.nodes[selection.activeId] : undefined
    const fullscreenActive = fullscreen?.paneId === pane.id
    const fullscreenMarkers = frequentMarkers(markerUsage)
    return (
      <section
        className={`workspace-pane ${workspace.activePaneId === pane.id ? 'active' : ''} ${dropTarget?.paneId === pane.id ? (dropTarget.type === 'pane' ? 'drop-swap' : dropTarget.type === 'pane-map' ? 'drop-map' : `drop-${dropTarget.placement}-${dropTarget.direction}`) : ''} ${fullscreen?.paneId === pane.id && fullscreen.mode === 'viewport' ? 'viewport-fullscreen' : ''}`}
        data-pane-id={pane.id}
        onPointerDownCapture={() => onActivate(pane.id)}
        onDragOver={(event) => handleDragOver(event, pane.id)}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null)
        }}
        onDrop={(event) => handleDrop(event, pane.id)}
      >
        <PaneHeader
          key={pane.id}
          pane={pane}
          map={map}
          onChange={(patch) => updatePane(pane.id, patch)}
          active={workspace.activePaneId === pane.id}
          canReorder={leafCount(workspace.root) > 1 && !fullscreen}
          onDragStart={(event) => {
            if (touchDragCleanup.current) {
              event.preventDefault()
              return
            }
            draggingPane.current = pane.id
            pendingPaneDrop.current = null
            event.dataTransfer.setData(PANE_DRAG_TYPE, pane.id)
            event.dataTransfer.effectAllowed = 'move'
          }}
          onDragEnd={() => {
            const pending = pendingPaneDrop.current
            pendingPaneDrop.current = null
            draggingPane.current = null
            setDropTarget(null)
            if (pending) swapPanes(pending.source, pending.target)
          }}
          onGripPointerDown={(event) => beginTouchPaneDrag(event, pane.id)}
          onMove={(direction) => movePane(pane.id, direction)}
          fullscreenMode={fullscreen?.paneId === pane.id ? fullscreen.mode : undefined}
          saveState={saveState}
          retrySave={save}
        />
        {fullscreenActive && map && (
          <div className="workspace-fullscreen-toolbar" role="toolbar" aria-label="全屏画布操作">
            <button
              disabled={!activeNode}
              onClick={() => {
                if (!activeNode) return
                void runPaneCommand(
                  pane.id,
                  map.id,
                  { type: 'add', nodeId: activeNode.id, kind: 'child' },
                  selection,
                ).catch(() => undefined)
              }}
            >
              ＋ 子主题
            </button>
            <button
              disabled={!activeNode?.parentId}
              onClick={() => {
                if (!activeNode) return
                void runPaneCommand(
                  pane.id,
                  map.id,
                  { type: 'add', nodeId: activeNode.id, kind: 'sibling' },
                  selection,
                ).catch(() => undefined)
              }}
            >
              ＋ 同级主题
            </button>
            <i />
            <button
              disabled={!activeNode}
              onClick={() => {
                if (!activeNode) return
                void runPaneCommand(
                  pane.id,
                  map.id,
                  { type: 'fold', nodeId: activeNode.id },
                  selection,
                ).catch(() => undefined)
              }}
            >
              折叠 / 展开
            </button>
            <button
              disabled={!map}
              title={activeNode ? '折叠或展开选中节点的整个子树' : '未选中节点时折叠或展开整张脑图'}
              onClick={() => {
                const action: Command = activeNode
                  ? { type: 'fold', nodeId: activeNode.id, recursive: true }
                  : { type: 'fold-all' }
                void runPaneCommand(pane.id, map.id, action, selection)
                  .then(() => onFit(pane.id))
                  .catch(() => undefined)
              }}
            >
              全部折叠 / 展开
            </button>
            <button
              disabled={!activeNode?.parentId || pane.scopeNodeId === activeNode.id}
              onClick={() => {
                if (!activeNode?.parentId) return
                updatePane(pane.id, {
                  scopeNodeId: activeNode.id,
                  selection: singleSelection(activeNode.id),
                })
                onFit(pane.id)
              }}
            >
              <CornerDownRight size={14} />
              下钻
            </button>
            <button
              disabled={!map}
              onClick={() => {
                void runPaneCommand(pane.id, map.id, { type: 'layout' }, selection)
                  .then(() => {
                    onFit(pane.id)
                    notify('已均衡布局')
                  })
                  .catch(() => undefined)
              }}
            >
              自动布局
            </button>
            <i />
            <button
              aria-label="撤销"
              title="撤销 ⌘Z"
              disabled={!canUndo}
              onClick={() => onHistory(map.id, 'undo')}
            >
              <Undo2 size={15} />
            </button>
            <button
              aria-label="重做"
              title="重做 ⇧⌘Z"
              disabled={!canRedo}
              onClick={() => onHistory(map.id, 'redo')}
            >
              <Redo2 size={15} />
            </button>
            {fullscreenMarkers.length > 0 && (
              <div className="frequent-markers" role="group" aria-label="常用图标">
                <i aria-hidden="true" />
                {fullscreenMarkers.map(({ category, value, count }) => {
                  const pressed =
                    selection.ids.length > 0 &&
                    selection.ids.every((id) => map.nodes[id]?.markers[category] === value)
                  return (
                    <button
                      key={`${category}:${value}`}
                      aria-label={`常用图标：${markerLabel(category, value)}`}
                      title={`${markerLabel(category, value)} · 已使用 ${count} 次`}
                      aria-pressed={pressed}
                      disabled={!activeNode}
                      onClick={() => onMarker(category, value)}
                    >
                      <svg width="20" height="20">
                        <MarkerIcon category={category} value={value} />
                      </svg>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}
        <div className="workspace-pane-content">
          <PaneActions
            paneId={pane.id}
            paneCount={leafCount(workspace.root)}
            onSplit={(direction) => split(pane.id, direction, { type: 'copy' })}
            onRemove={() => close(pane.id)}
            fullscreen={fullscreen?.paneId === pane.id}
            fullscreenMode={fullscreen?.paneId === pane.id ? fullscreen.mode : undefined}
            canFullscreen={!!map || fullscreen?.paneId === pane.id}
            onFullscreen={() => void toggleFullscreen(pane.id)}
          />
          {map ? (
            <Canvas
              key={`${pane.id}:${pane.mapId}:${pane.scopeNodeId ?? 'all'}`}
              paneId={pane.id}
              scopeNodeId={pane.scopeNodeId}
              map={map}
              selection={selection}
              selectionChanged={(next) => onSelection(pane.id, next)}
              select={(id) => onSelection(pane.id, singleSelection(id))}
              command={async (command) => {
                if (
                  selection.ids.length > 1 &&
                  !['delete-many', 'fold', 'layout', 'reparent-many'].includes(command.type)
                )
                  onSelection(pane.id, singleSelection(selection.activeId))
                const selected = await onCommand(map.id, command, (id) => {
                  if (id) onSelection(pane.id, singleSelection(id))
                })
                return selected
              }}
              history={(direction) => onHistory(map.id, direction)}
              paste={paste}
              save={save}
              notify={notify}
              copied={copied}
              editRequest={workspace.activePaneId === pane.id ? editRequest : 0}
              focusRequest={workspace.activePaneId === pane.id ? focusRequest : 0}
              fitRequest={fitRequests[pane.id] ?? 0}
              exitFullscreen={
                fullscreen?.paneId === pane.id ? () => void toggleFullscreen(pane.id) : undefined
              }
            />
          ) : (
            <div className="workspace-pane-empty">请选择脑图</div>
          )}
          {fullscreen?.paneId === pane.id && notification && (
            <div className="workspace-fullscreen-toast" role="status">
              <span>{notification}</span>
              <button aria-label="关闭提示" onClick={closeNotification}>
                <X size={12} />
              </button>
            </div>
          )}
        </div>
      </section>
    )
  }
  return (
    <div className="workspace-layout" data-testid="workspace-layout" ref={rootRef}>
      {render(workspace.root)}
    </div>
  )
}
