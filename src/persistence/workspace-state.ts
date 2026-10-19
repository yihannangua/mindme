import type { NodeSelection } from '../editor/selection'
import type { CanvasView } from './editor-state'

export type SplitDirection = 'row' | 'column'

export interface WorkspacePane {
  id: string
  mapId: string
  scopeNodeId: string | null
  selection: NodeSelection
  view?: CanvasView
}

export interface WorkspaceLeaf {
  type: 'pane'
  paneId: string
}

export interface WorkspaceSplit {
  type: 'split'
  id: string
  direction: SplitDirection
  ratio: number
  first: WorkspaceNode
  second: WorkspaceNode
}

export type WorkspaceNode = WorkspaceLeaf | WorkspaceSplit

export interface WorkspaceState {
  version: 1
  activePaneId: string
  root: WorkspaceNode
  panes: Record<string, WorkspacePane>
}

const key = 'mindme.workspace.v1'
const clampRatio = (ratio: number) => Math.min(0.85, Math.max(0.15, ratio))
const isSelection = (value: unknown): value is NodeSelection => {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<NodeSelection>
  return (
    Array.isArray(item.ids) &&
    item.ids.every((id) => typeof id === 'string') &&
    (item.activeId === null || typeof item.activeId === 'string') &&
    (item.anchorId === null || typeof item.anchorId === 'string')
  )
}
function readNode(value: unknown): WorkspaceNode | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Partial<WorkspaceNode>
  if (item.type === 'pane' && typeof item.paneId === 'string')
    return { type: 'pane', paneId: item.paneId }
  if (
    item.type === 'split' &&
    typeof item.id === 'string' &&
    (item.direction === 'row' || item.direction === 'column')
  ) {
    const first = readNode(item.first),
      second = readNode(item.second)
    if (first && second)
      return {
        type: 'split',
        id: item.id,
        direction: item.direction,
        ratio: clampRatio(typeof item.ratio === 'number' ? item.ratio : 0.5),
        first,
        second,
      }
  }
  return null
}

export function defaultWorkspace(mapId: string): WorkspaceState {
  const paneId = `pane-${crypto.randomUUID()}`
  return {
    version: 1,
    activePaneId: paneId,
    root: { type: 'pane', paneId },
    panes: {
      [paneId]: {
        id: paneId,
        mapId,
        scopeNodeId: null,
        selection: { ids: [], activeId: null, anchorId: null },
      },
    },
  }
}

export function loadWorkspace(): WorkspaceState | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null') as Partial<WorkspaceState> | null
    if (!value || value.version !== 1 || typeof value.activePaneId !== 'string') return null
    const root = readNode(value.root)
    if (!root || !value.panes || typeof value.panes !== 'object') return null
    const panes: Record<string, WorkspacePane> = {}
    for (const [id, raw] of Object.entries(value.panes)) {
      if (!raw || typeof raw !== 'object') continue
      const pane = raw as Partial<WorkspacePane>
      if (pane.id !== id || typeof pane.mapId !== 'string' || !isSelection(pane.selection)) continue
      panes[id] = {
        id,
        mapId: pane.mapId,
        scopeNodeId: typeof pane.scopeNodeId === 'string' ? pane.scopeNodeId : null,
        selection: {
          ids: [...new Set(pane.selection.ids)].slice(0, 5000),
          activeId: pane.selection.activeId,
          anchorId: pane.selection.anchorId,
        },
        view:
          pane.view &&
          Number.isFinite(pane.view.x) &&
          Number.isFinite(pane.view.y) &&
          Number.isFinite(pane.view.zoom) &&
          pane.view.zoom >= 0.15 &&
          pane.view.zoom <= 2.5
            ? pane.view
            : undefined,
      }
    }
    return Object.keys(panes).length
      ? { version: 1, activePaneId: value.activePaneId, root, panes }
      : null
  } catch {
    return null
  }
}

export function saveWorkspace(state: WorkspaceState) {
  try {
    localStorage.setItem(key, JSON.stringify(state))
  } catch {
    // 工作区偏好不可用时仍允许继续编辑脑图内容。
  }
}

export const normalizeWorkspace = (
  state: WorkspaceState,
  mapIds: Set<string>,
  fallback: string,
) => {
  const validPanes = Object.fromEntries(
    Object.entries(state.panes).filter(([, pane]) => pane.mapId === '' || mapIds.has(pane.mapId)),
  )
  if (!Object.keys(validPanes).length) return defaultWorkspace(fallback)
  const leaves = new Set<string>()
  const visit = (node: WorkspaceNode): WorkspaceNode | null => {
    if (node.type === 'pane') {
      if (!validPanes[node.paneId]) return null
      leaves.add(node.paneId)
      return node
    }
    const first = visit(node.first),
      second = visit(node.second)
    if (!first) return second
    if (!second) return first
    return { ...node, first, second }
  }
  const root = visit(state.root)
  if (!root) return defaultWorkspace(fallback)
  for (const id of Object.keys(validPanes)) if (!leaves.has(id)) delete validPanes[id]
  return {
    version: 1 as const,
    activePaneId: validPanes[state.activePaneId] ? state.activePaneId : [...leaves][0],
    root,
    panes: validPanes,
  }
}

export { clampRatio }
