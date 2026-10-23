import { useEffect, useRef, useState } from 'react'
import {
  type ClipboardEvent,
  type CSSProperties,
  type DragEvent,
  type PointerEvent,
  type ReactNode,
} from 'react'
import { Columns2, Rows2, X } from 'lucide-react'
import type { Command } from '../domain/commands'
import type { MindMap, Space } from '../domain/types'
import type { ImportDraft } from '../importers/outline'
import { Canvas } from '../editor/Canvas'
import { singleSelection, type NodeSelection } from '../editor/selection'
import {
  clampRatio,
  type SplitDirection,
  type WorkspaceNode,
  type WorkspacePane,
  type WorkspaceState,
} from '../persistence/workspace-state'

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
function nodeOptions(map: MindMap) {
  return Object.values(map.nodes).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
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
function PaneHeader({
  pane,
  map,
  maps,
  onChange,
  active,
}: {
  pane: WorkspacePane
  map?: MindMap
  maps: MindMap[]
  onChange: (patch: Partial<WorkspacePane>) => void
  active: boolean
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const effectiveScopeId = map && pane.scopeNodeId !== map.rootId ? pane.scopeNodeId : null
  const scopeText = map && effectiveScopeId ? map.nodes[effectiveScopeId]?.text : ''
  const summary = map ? `${map.title} · ${scopeText || '整张脑图'}` : '空白分区'
  const breadcrumbs = map ? scopePath(map, effectiveScopeId) : []
  useEffect(() => {
    if (!menuOpen) return
    const close = (event: globalThis.PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false)
    }
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('pointerdown', close)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [menuOpen])
  return (
    <div className={`workspace-pane-header ${active ? 'active' : ''}`} ref={menuRef}>
      <div
        className="workspace-pane-summary"
        role="button"
        tabIndex={0}
        aria-label={`当前分区：${summary}`}
        onClick={() => setMenuOpen((open) => !open)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            setMenuOpen((open) => !open)
          }
        }}
      >
        {map && pane.scopeNodeId ? (
          <span className="workspace-pane-breadcrumbs" aria-label="下钻路径">
            {breadcrumbs.map((item, index) => (
              <span className="workspace-pane-breadcrumb" key={`${item.id ?? 'map'}-${index}`}>
                {index > 0 && <span className="workspace-pane-breadcrumb-separator">/</span>}
                {index < breadcrumbs.length - 1 ? (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation()
                      onChange({ scopeNodeId: item.id })
                    }}
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
      {menuOpen && (
        <div className="workspace-pane-menu" role="menu" aria-label="分区操作">
          <div className="workspace-pane-menu-title">分区内容</div>
          <select
            aria-label="替换分区脑图"
            value={pane.mapId}
            onChange={(event) => {
              onChange({ mapId: event.target.value, scopeNodeId: null })
              setMenuOpen(false)
            }}
          >
            <option value="">空白分区</option>
            {maps.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
          <select
            aria-label="选择分区节点范围"
            value={effectiveScopeId ?? ''}
            disabled={!map}
            onChange={(event) => {
              onChange({
                scopeNodeId:
                  event.target.value && event.target.value !== map?.rootId
                    ? event.target.value
                    : null,
              })
              setMenuOpen(false)
            }}
          >
            <option value="">整张脑图</option>
            {map &&
              nodeOptions(map).map((node) => (
                <option key={node.id} value={node.id}>
                  {node.text}
                </option>
              ))}
          </select>
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
}: {
  paneId: string
  paneCount: number
  onSplit: (direction: SplitDirection) => void
  onRemove: () => void
}) {
  return (
    <div className="workspace-pane-actions" aria-label={`画布 ${paneId} 操作`}>
      <button aria-label="左右拆分画布" title="左右拆分画布" onClick={() => onSplit('row')}>
        <Columns2 size={15} />
      </button>
      <button aria-label="上下拆分画布" title="上下拆分画布" onClick={() => onSplit('column')}>
        <Rows2 size={15} />
      </button>
      {paneCount > 1 && (
        <button aria-label="关闭当前画布" title="关闭当前画布" onClick={onRemove}>
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
}: Props) {
  const resizing = useRef<{ id: string; direction: SplitDirection; rect: DOMRect } | null>(null)
  const [dropTarget, setDropTarget] = useState<{
    paneId: string
    direction: SplitDirection
    placement: 'first' | 'second'
  } | null>(null)
  const pendingDrop = useRef<{
    mapId: string
    target: { paneId: string; direction: SplitDirection; placement: 'first' | 'second' }
  } | null>(null)
  const panes = workspace.panes
  const maps = Object.values(space.maps).filter((map) => map.deletedAt === null)
  const updatePane = (paneId: string, patch: Partial<WorkspacePane>) => {
    const pane = panes[paneId]
    if (pane)
      onWorkspaceChange({ ...workspace, panes: { ...panes, [paneId]: { ...pane, ...patch } } })
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
    id: string,
    direction: SplitDirection,
  ) => {
    const rect = event.currentTarget.parentElement!.getBoundingClientRect()
    resizing.current = { id, direction, rect }
    const move = (moveEvent: globalThis.PointerEvent) => {
      const state = resizing.current
      if (!state) return
      const ratio =
        state.direction === 'row'
          ? (moveEvent.clientX - state.rect.left) / state.rect.width
          : (moveEvent.clientY - state.rect.top) / state.rect.height
      onWorkspaceChange({ ...workspace, root: updateSplit(workspace.root, state.id, ratio) })
    }
    const end = () => {
      resizing.current = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    event.preventDefault()
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
    if (!event.dataTransfer.types.includes('text/x-mindme-map')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setDropTarget(dropPlacement(event, paneId))
  }
  const handleDrop = (event: DragEvent<HTMLElement>, paneId: string) => {
    event.preventDefault()
    const mapId = event.dataTransfer.getData('text/x-mindme-map')
    const target = dropPlacement(event, paneId)
    setDropTarget(null)
    if (!mapId || !space.maps[mapId] || !target) return
    // drop 只代表浏览器接受了目标；等拖动源的 dragend 才提交布局，避免拖动尚未结束时重排 DOM。
    pendingDrop.current = { mapId, target }
  }
  useEffect(() => {
    return () => {
      pendingDrop.current = null
    }
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
  const render = (node: WorkspaceNode): ReactNode => {
    if (node.type === 'split')
      return (
        <div
          className={`workspace-split ${node.direction}`}
          style={
            {
              '--workspace-first': `${node.ratio * 100}%`,
              '--workspace-second': `${(1 - node.ratio) * 100}%`,
            } as CSSProperties
          }
        >
          <div className="workspace-child">{render(node.first)}</div>
          <div
            className="workspace-divider"
            role="separator"
            aria-orientation={node.direction === 'row' ? 'vertical' : 'horizontal'}
            onPointerDown={(event) => beginResize(event, node.id, node.direction)}
          />
          <div className="workspace-child">{render(node.second)}</div>
        </div>
      )
    const pane = panes[node.paneId],
      map = pane ? space.maps[pane.mapId] : undefined
    if (!pane) return null
    const selection = workspace.activePaneId === pane.id ? activeSelection : pane.selection
    return (
      <section
        className={`workspace-pane ${workspace.activePaneId === pane.id ? 'active' : ''} ${dropTarget?.paneId === pane.id ? `drop-${dropTarget.placement}-${dropTarget.direction}` : ''}`}
        onPointerDownCapture={() => onActivate(pane.id)}
        onDragOver={(event) => handleDragOver(event, pane.id)}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null)
        }}
        onDrop={(event) => handleDrop(event, pane.id)}
      >
        <PaneHeader
          pane={pane}
          map={map}
          maps={maps}
          onChange={(patch) => updatePane(pane.id, patch)}
          active={workspace.activePaneId === pane.id}
        />
        <div className="workspace-pane-content">
          <PaneActions
            paneId={pane.id}
            paneCount={leafCount(workspace.root)}
            onSplit={(direction) => split(pane.id, direction, { type: 'copy' })}
            onRemove={() => close(pane.id)}
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
            />
          ) : (
            <div className="workspace-pane-empty">请选择脑图</div>
          )}
        </div>
      </section>
    )
  }
  return (
    <div className="workspace-layout" data-testid="workspace-layout">
      {render(workspace.root)}
    </div>
  )
}
