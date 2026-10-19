import {
  useCallback,
  useEffect,
  useMemo,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import { selectedForest } from '../domain/branches'
import type { Command } from '../domain/commands'
import { children } from '../domain/model'
import type { MapContent, MarkerCategory, MindMap } from '../domain/types'
import type { ImportDraft } from '../importers/outline'
import { BRANCHES_MIME, branchText, copyBranches } from '../importers/backup'
import { edgePath, layoutTree, type TextMeasure } from '../layout/tree'
import { appStore } from '../app/store'
import { MarkerIcon } from '../components/MarkerIcon'
import { nextDirectionalNode, type Direction } from './navigation'
import { editorState, type CanvasView } from '../persistence/editor-state'
import type { CanvasStyle } from './style'
import { pointerSelection, retainSelection, type NodeSelection } from './selection'

interface Props {
  map: MindMap
  paneId?: string
  scopeNodeId?: string | null
  selection: NodeSelection
  selectionChanged: (selection: NodeSelection) => void
  select: (id: string | null) => void
  command: (command: Command) => Promise<unknown>
  history: (direction: 'undo' | 'redo') => void
  paste: (event: ClipboardEvent) => void
  save: () => void
  notify: (text: string) => void
  copied: (drafts: ImportDraft[], text: string) => void
  editRequest: number
  focusRequest: number
  fitRequest: number
}
function scopedMap(map: MindMap, scopeNodeId: string | null | undefined): MapContent {
  if (!scopeNodeId || scopeNodeId === map.rootId || !map.nodes[scopeNodeId]) return map
  const nodes: Record<string, (typeof map.nodes)[string]> = {}
  const visit = (id: string) => {
    const node = map.nodes[id]
    if (!node) return
    nodes[id] = {
      ...node,
      ...(id === scopeNodeId ? { parentId: null, side: 0 } : {}),
      ...(node.parentId === scopeNodeId ? { side: 1 } : {}),
    }
    for (const child of Object.values(map.nodes)) if (child.parentId === id) visit(child.id)
  }
  visit(scopeNodeId)
  return { ...map, rootId: scopeNodeId, nodes }
}
interface Drag {
  mode: 'node' | 'pan'
  id: string | null
  nodeIds: string[]
  roots: string[]
  startX: number
  startY: number
  baseX: number
  baseY: number
  moved: boolean
  target: string | null
  pointerId: number
}
export function Canvas({
  map,
  paneId,
  scopeNodeId,
  selection,
  selectionChanged,
  select,
  command,
  history,
  paste,
  save,
  notify,
  copied,
  editRequest,
  focusRequest,
  fitRequest,
}: Props) {
  const selectedId = selection.activeId,
    selectedIds = useMemo(() => new Set(selection.ids), [selection.ids])
  const container = useRef<HTMLDivElement>(null),
    input = useRef<HTMLTextAreaElement>(null),
    styleMenu = useRef<HTMLDivElement>(null),
    composing = useRef(false),
    drag = useRef<Drag | null>(null)
  const captureInput = useCallback((element: HTMLTextAreaElement | null) => {
    const previous = input.current
    input.current = element
    if (!element && previous === document.activeElement)
      container.current?.focus({ preventScroll: true })
  }, [])
  const [savedState] = useState(() => {
    const mapState = editorState.map(map.id),
      paneState = paneId ? editorState.pane(paneId, map.id) : {}
    return { ...mapState, ...paneState }
  })
  const initializedView = useRef(!!savedState.view),
    handledFitRequest = useRef(fitRequest)
  const [size, setSize] = useState({ width: 0, height: 0 }),
    [view, setView] = useState<CanvasView>(() => savedState.view ?? { x: 0, y: 0, zoom: 1 }),
    [preview, setPreview] = useState<{
      roots: string[]
      x: number
      y: number
      target: string | null
    } | null>(null)
  const [canvasStyle, setCanvasStyle] = useState<CanvasStyle>(savedState.style ?? 'classic'),
    [styleMenuOpen, setStyleMenuOpen] = useState(false),
    [panning, setPanning] = useState(false)
  const [edit, setEdit] = useState<{ id: string; text: string; original: string } | null>(null)
  const finishing = useRef(false),
    selectTextOnEdit = useRef(true)
  const [editSize, setEditSize] = useState<{ id: string; text: string; height: number } | null>(
    null,
  )
  const measureText = useMemo<TextMeasure | undefined>(() => {
    const context = document.createElement('canvas').getContext('2d')
    if (!context) return
    const family = getComputedStyle(document.documentElement).fontFamily,
      widths = new Map<string, number>()
    return (text, node) => {
      const weight = node.parentId === null ? 600 : 400,
        fontSize = canvasStyle === 'compact' ? (node.parentId === null ? 16 : 11) : 14,
        key = `${weight}:${fontSize}:${text}`
      let width = widths.get(key)
      if (width === undefined) {
        context.font = `${weight} ${fontSize}px ${family}`
        width = context.measureText(text).width
        widths.set(key, width)
      }
      return width
    }
  }, [canvasStyle])
  const viewMap = useMemo(() => scopedMap(map, scopeNodeId), [map, scopeNodeId])
  const layout = useMemo(
    () =>
      layoutTree(viewMap, {
        measureText,
        style: canvasStyle,
        draft: edit
          ? {
              id: edit.id,
              text: edit.text,
              height:
                editSize?.id === edit.id && editSize.text === edit.text
                  ? editSize.height
                  : undefined,
            }
          : undefined,
      }),
    [viewMap, edit?.id, edit?.text, editSize, measureText, canvasStyle],
  )
  const changeCanvasStyle = (style: CanvasStyle) => {
    setCanvasStyle(style)
    setStyleMenuOpen(false)
    editorState.updateMap(map.id, { style })
    if (paneId) editorState.updatePane(paneId, map.id, { style })
  }
  useEffect(() => {
    const closeMenu = (event: globalThis.PointerEvent) => {
      if (styleMenu.current && !styleMenu.current.contains(event.target as Node))
        setStyleMenuOpen(false)
    }
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setStyleMenuOpen(false)
    }
    document.addEventListener('pointerdown', closeMenu)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeMenu)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [])
  useLayoutEffect(() => {
    const retained = retainSelection(selection, new Set(layout.nodes.map((item) => item.node.id)))
    if (retained !== selection) selectionChanged(retained)
  }, [layout, selection, selectionChanged])
  const editWidth = edit ? layout.byId.get(edit.id)?.textWidth : undefined
  useLayoutEffect(() => {
    const element = input.current
    if (!edit || !element) return
    // 用原生输入框测量实际行高，覆盖中文、长单词、组合表情及末尾空行。
    const previous = element.style.height
    element.style.height = '0px'
    const height = element.scrollHeight
    element.style.height = previous
    setEditSize((old) =>
      old?.id === edit.id && old.text === edit.text && old.height === height
        ? old
        : { id: edit.id, text: edit.text, height },
    )
  }, [edit?.id, edit?.text, editWidth])
  useEffect(() => {
    const element = container.current!
    const observer = new ResizeObserver(([entry]) =>
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height }),
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const fit = useCallback(() => {
    const zoom = Math.max(
      0.15,
      Math.min(
        1,
        (size.width - 100) / (layout.width + 20),
        (size.height - 120) / (layout.height + 20),
      ),
    )
    const minX = Math.min(...layout.nodes.map((n) => n.x - n.width / 2)),
      maxX = Math.max(...layout.nodes.map((n) => n.x + n.width / 2)),
      minY = Math.min(...layout.nodes.map((n) => n.y - n.height / 2)),
      maxY = Math.max(...layout.nodes.map((n) => n.y + n.height / 2))
    setView({ x: (-(minX + maxX) / 2) * zoom, y: (-(minY + maxY) / 2) * zoom, zoom })
  }, [size, layout])
  const fitRef = useRef(fit)
  fitRef.current = fit
  useLayoutEffect(() => {
    if (!size.width || !size.height) return
    if (!initializedView.current || handledFitRequest.current !== fitRequest) {
      initializedView.current = true
      handledFitRequest.current = fitRequest
      fitRef.current()
    }
  }, [fitRequest, size.width, size.height])
  useLayoutEffect(() => {
    if (initializedView.current && size.width && size.height)
      editorState.updateMap(map.id, { view })
    if (paneId) editorState.updatePane(paneId, map.id, { view })
  }, [map.id, paneId, view, size.width, size.height])
  const zoomAt = useCallback((factor: number, clientX?: number, clientY?: number) => {
    const rect = container.current!.getBoundingClientRect(),
      px = clientX === undefined ? 0 : clientX - rect.left - rect.width / 2,
      py = clientY === undefined ? 0 : clientY - rect.top - rect.height / 2
    setView((old) => {
      const zoom = Math.min(2.5, Math.max(0.15, old.zoom * factor)),
        ratio = zoom / old.zoom
      return { zoom, x: px - (px - old.x) * ratio, y: py - (py - old.y) * ratio }
    })
  }, [])
  useEffect(() => {
    const element = container.current!
    const wheel = (event: WheelEvent) => {
      if (event.target instanceof Element && event.target.closest('textarea,input,button')) return
      event.preventDefault()
      if (drag.current) return
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1,
        delta = (event.deltaY || event.deltaX) * unit
      if (delta) zoomAt(Math.exp(-delta * 0.0015), event.clientX, event.clientY)
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  }, [zoomAt])
  const cancelDrag = useCallback(() => {
    const state = drag.current
    drag.current = null
    setPreview(null)
    setPanning(false)
    if (!state) return
    if (state.mode === 'pan') setView((old) => ({ ...old, x: state.baseX, y: state.baseY }))
    if (container.current?.hasPointerCapture(state.pointerId))
      container.current.releasePointerCapture(state.pointerId)
  }, [selectionChanged])
  const startEdit = useCallback(
    (id: string) => {
      const node = map.nodes[id]
      if (!node) return
      finishing.current = false
      selectTextOnEdit.current = true
      setEdit({ id, text: node.text, original: node.text })
      select(id)
    },
    [map, select],
  )
  const handledFocusRequest = useRef(focusRequest)
  useLayoutEffect(() => {
    if (handledFocusRequest.current === focusRequest) return
    handledFocusRequest.current = focusRequest
    container.current?.focus({ preventScroll: true })
  }, [focusRequest])
  const handledEditRequest = useRef(editRequest)
  useEffect(() => {
    if (handledEditRequest.current === editRequest) return
    handledEditRequest.current = editRequest
    if (selectedId) startEdit(selectedId)
  }, [editRequest]) // 显式编辑请求才进入，避免切图或远端更新抢走焦点。
  useEffect(() => {
    if (edit) {
      input.current?.focus()
      if (selectTextOnEdit.current && !composing.current) input.current?.select()
    } else if (selectedId && container.current?.contains(document.activeElement)) {
      input.current?.focus({ preventScroll: true })
    }
  }, [edit?.id, selectedId])
  const finishEdit = useCallback(
    async (cancel = false) => {
      if (!edit || finishing.current || composing.current) return
      finishing.current = true
      let pending: Promise<unknown> | undefined
      if (!cancel && edit.text !== edit.original) {
        if (map.nodes[edit.id]?.text !== edit.original) {
          notify('编辑期间另一设备修改了文字，请复制草稿后重新编辑')
          finishing.current = false
          return
        }
        pending = appStore.commitTextEdit(map.id, edit.id, edit.text, edit.original)
      } else {
        pending = appStore.editorDraft(null)
      }
      setEdit(null)
      container.current?.focus()
      try {
        await pending
      } catch {
        finishing.current = false
        setEdit(edit)
        void appStore
          .editorDraft({
            mapId: map.id,
            nodeId: edit.id,
            text: edit.text,
            original: edit.original,
            at: Date.now(),
          })
          .catch(() => undefined)
      }
    },
    [edit, command, map, notify],
  )
  const moveSelection = useCallback(
    (direction: Direction) => {
      if (!selectedId) return
      const next = nextDirectionalNode(layout, selectedId, direction)
      if (!next) return
      select(next.node.id)
      const margin = 40
      setView((old) => {
        const left = next.x * old.zoom + old.x - (next.width * old.zoom) / 2,
          right = next.x * old.zoom + old.x + (next.width * old.zoom) / 2,
          top = next.y * old.zoom + old.y - (next.height * old.zoom) / 2,
          bottom = next.y * old.zoom + old.y + (next.height * old.zoom) / 2
        let x = old.x,
          y = old.y
        if (right - left > size.width - margin * 2) x = -next.x * old.zoom
        else if (left < -size.width / 2 + margin) x += -size.width / 2 + margin - left
        else if (right > size.width / 2 - margin) x -= right - (size.width / 2 - margin)
        if (bottom - top > size.height - margin * 2) y = -next.y * old.zoom
        else if (top < -size.height / 2 + margin) y += -size.height / 2 + margin - top
        else if (bottom > size.height / 2 - margin) y -= bottom - (size.height / 2 - margin)
        return { ...old, x, y }
      })
    },
    [layout, selectedId, select, size],
  )
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && drag.current) {
      event.preventDefault()
      cancelDrag()
      return
    }
    if (
      event.nativeEvent.isComposing ||
      composing.current ||
      (event.target instanceof HTMLTextAreaElement && (edit || event.target !== input.current)) ||
      event.target instanceof HTMLInputElement
    )
      return
    const mod = event.metaKey || event.ctrlKey,
      key = event.key.toLowerCase()
    if (mod && key === 'z') {
      event.preventDefault()
      history(event.shiftKey ? 'redo' : 'undo')
      return
    }
    if (mod && key === 's') {
      event.preventDefault()
      save()
      return
    }
    if (!selectedId || !map.nodes[selectedId]) return
    let action: Command | undefined
    if (key === 'tab') action = { type: 'add', kind: 'child', nodeId: selectedId }
    if (key === 'enter')
      action = { type: 'add', kind: mod ? 'parent' : 'sibling', nodeId: selectedId }
    if (key === 'f2') {
      event.preventDefault()
      startEdit(selectedId)
      return
    }
    if (key === 'backspace' || key === 'delete')
      action =
        selection.ids.length > 1
          ? { type: 'delete-many', nodeIds: selection.ids }
          : { type: 'delete', nodeId: selectedId }
    if (mod && (key === '/' || event.code === 'Slash'))
      action = { type: 'fold', nodeId: selectedId, recursive: event.altKey }
    if (event.altKey && ['arrowup', 'arrowdown'].includes(key))
      action = { type: 'sort', nodeId: selectedId, delta: key === 'arrowup' ? -1 : 1 }
    if (
      !mod &&
      !event.altKey &&
      !event.shiftKey &&
      ['arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)
    ) {
      event.preventDefault()
      moveSelection(key.slice(5) as Direction)
      return
    }
    if (key === 'escape') select(null)
    if (action) {
      event.preventDefault()
      void command(action).catch(() => undefined)
    }
  }
  const onCopy = (event: ClipboardEvent) => {
    if (
      (event.target instanceof HTMLTextAreaElement && (edit || event.target !== input.current)) ||
      event.target instanceof HTMLInputElement ||
      !selectedId
    )
      return
    const drafts = copyBranches(map, selection.ids.length > 1 ? selection.ids : [selectedId]),
      text = branchText(drafts)
    copied(drafts, text)
    if (drafts.length === 1)
      event.clipboardData.setData('application/x-mindme-branch+json', JSON.stringify(drafts[0]))
    else event.clipboardData.setData(BRANCHES_MIME, JSON.stringify({ drafts }))
    event.clipboardData.setData('text/plain', text)
    event.preventDefault()
    notify('已复制分支，可在画布或其他应用粘贴')
  }
  const onCut = (event: ClipboardEvent) => {
    if (
      (event.target instanceof HTMLTextAreaElement && (edit || event.target !== input.current)) ||
      event.target instanceof HTMLInputElement ||
      !selectedId
    )
      return
    event.preventDefault()
    if (selectedId === map.rootId) {
      notify('中心主题不能剪切')
      return
    }
    const drafts = copyBranches(map, selection.ids.length > 1 ? selection.ids : [selectedId]),
      text = branchText(drafts)
    copied(drafts, text)
    if (drafts.length === 1)
      event.clipboardData.setData('application/x-mindme-branch+json', JSON.stringify(drafts[0]))
    else event.clipboardData.setData(BRANCHES_MIME, JSON.stringify({ drafts }))
    event.clipboardData.setData('text/plain', text)
    void command(
      selection.ids.length > 1
        ? { type: 'delete-many', nodeIds: selection.ids }
        : { type: 'delete', nodeId: selectedId },
    )
      .then(() => notify('已剪切分支'))
      .catch(() => undefined)
  }
  const pointerDown = (event: PointerEvent, id: string | null) => {
    if (
      event.button !== 0 ||
      (event.target instanceof Element && event.target.closest('textarea,button,.fold-control'))
    )
      return
    const nodeIds =
      id && selectedIds.has(id) && selection.ids.length > 1 ? selection.ids : id ? [id] : []
    const mode = id ? 'node' : 'pan'
    if (id) event.stopPropagation()
    if (id) {
      if (event.shiftKey || event.altKey) {
        event.preventDefault()
        selectionChanged(
          pointerSelection(
            selection,
            id,
            event.altKey ? 'toggle' : 'range',
            layout.nodes.map((item) => item.node.id),
          ),
        )
        drag.current = null
        container.current?.focus({ preventScroll: true })
        return
      }
      if (nodeIds.length === 1) select(id)
    }
    event.preventDefault()
    container.current?.focus({ preventScroll: true })
    setPanning(false)
    drag.current = {
      mode,
      id: mode === 'node' ? id : null,
      nodeIds: mode === 'node' ? [...nodeIds] : [],
      roots: selectedForest(map, nodeIds).roots,
      startX: event.clientX,
      startY: event.clientY,
      baseX: view.x,
      baseY: view.y,
      moved: false,
      target: null,
      pointerId: event.pointerId,
    }
    if (mode === 'pan') {
      container.current?.setPointerCapture(event.pointerId)
      return
    }
  }
  const dragTarget = (state: Drag, clientX: number, clientY: number) => {
    if (!state.id || state.id === map.rootId || state.nodeIds.some((id) => !map.nodes[id]))
      return null
    const rect = container.current!.getBoundingClientRect(),
      x = (clientX - rect.left - size.width / 2 - view.x) / view.zoom,
      y = (clientY - rect.top - size.height / 2 - view.y) / view.zoom,
      excluded = selectedForest(map, state.nodeIds).ids
    return (
      layout.nodes.find(
        (node) =>
          !excluded.has(node.node.id) &&
          Math.abs(node.x - x) <= node.width / 2 + 15 &&
          Math.abs(node.y - y) <= node.height / 2 + 12,
      )?.node.id ?? null
    )
  }
  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current
    if (!state) return
    const dx = event.clientX - state.startX,
      dy = event.clientY - state.startY
    if (Math.hypot(dx, dy) < 5 && !state.moved) return
    if (
      !state.moved &&
      state.mode === 'node' &&
      state.nodeIds.length > 1 &&
      state.nodeIds.includes(map.rootId)
    ) {
      notify('中心主题不能参与批量挂接，请先取消中心主题的选择')
      cancelDrag()
      return
    }
    if (!state.moved) {
      state.moved = true
      event.currentTarget.setPointerCapture(event.pointerId)
    }
    if (state.mode === 'pan') {
      setPanning(true)
      setView((old) => ({ ...old, x: state.baseX + dx, y: state.baseY + dy }))
      return
    }
    state.target = dragTarget(state, event.clientX, event.clientY)
    setPreview({ roots: state.roots, x: dx / view.zoom, y: dy / view.zoom, target: state.target })
  }

  const pointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current
    if (!state) return
    if (state.moved && state.mode === 'node' && state.id) {
      const target = dragTarget(state, event.clientX, event.clientY)
      if (target)
        void command(
          state.nodeIds.length > 1
            ? { type: 'reparent-many', nodeIds: state.nodeIds, parentId: target }
            : { type: 'reparent', nodeId: state.id, parentId: target },
        ).catch(() => undefined)
      else if (state.nodeIds.length > 1)
        notify('未挂接：请将多个节点拖到有效目标并在提示出现后松手')
      else {
        const node = map.nodes[state.id]
        if (!node) {
          drag.current = null
          setPreview(null)
          return
        }
        void command({
          type: 'move',
          nodeId: state.id,
          position: {
            x: (node.position?.x ?? 0) + (event.clientX - state.startX) / view.zoom,
            y: (node.position?.y ?? 0) + (event.clientY - state.startY) / view.zoom,
          },
        }).catch(() => undefined)
      }
    } else if (!state.moved && state.mode === 'node') select(state.id)
    else if (!state.moved && state.mode === 'pan') select(null)
    drag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
    setPreview(null)
    setPanning(false)
  }
  const movedIds = useMemo(
    () => selectedForest(map, preview?.roots ?? []).ids,
    [map, preview?.roots],
  )
  const displayNodes = layout.nodes.map((item) =>
    movedIds.has(item.node.id) && preview
      ? { ...item, x: item.x + preview.x, y: item.y + preview.y }
      : item,
  )
  const displayById = new Map(displayNodes.map((item) => [item.node.id, item]))
  const visible = displayNodes.filter(
    (item) =>
      item.node.id === edit?.id ||
      selectedIds.has(item.node.id) ||
      (Math.abs(item.x * view.zoom + view.x) < size.width / 2 + item.width * view.zoom &&
        Math.abs(item.y * view.zoom + view.y) < size.height / 2 + item.height * view.zoom),
  )
  const visibleIds = new Set(visible.map((item) => item.node.id))
  return (
    <div
      className={`canvas${panning ? ' panning' : ''}`}
      data-style={canvasStyle}
      ref={container}
      tabIndex={0}
      aria-label="脑图画布"
      onFocus={(event) => {
        if (event.target === event.currentTarget && selectedId && !edit)
          input.current?.focus({ preventScroll: true })
      }}
      onKeyDown={onKeyDown}
      onCopy={onCopy}
      onCut={onCut}
      onPaste={(event) => {
        if (
          !(event.target instanceof HTMLInputElement) &&
          !(event.target instanceof HTMLTextAreaElement && (edit || event.target !== input.current))
        )
          paste(event)
      }}
      onPointerDown={(event) => pointerDown(event, null)}
      onPointerMove={pointerMove}
      onPointerUp={pointerUp}
      onPointerCancel={cancelDrag}
      onLostPointerCapture={() => {
        if (drag.current) cancelDrag()
      }}
    >
      <div className="canvas-caption">
        {map.title} <span>顺时针平衡图</span>
      </div>
      <svg className="graph" width="100%" height="100%" aria-label="脑图节点与连线">
        <g
          transform={`translate(${size.width / 2 + view.x} ${size.height / 2 + view.y}) scale(${view.zoom})`}
        >
          {displayNodes
            .filter(
              (item) =>
                item.node.parentId &&
                (visibleIds.has(item.node.id) || visibleIds.has(item.node.parentId)),
            )
            .map((item) => (
              <path
                key={`edge-${item.node.id}`}
                className="edge"
                stroke={canvasStyle === 'compact' ? 'var(--compact-ink)' : item.color}
                d={edgePath(displayById.get(item.node.parentId!)!, item, canvasStyle)}
              />
            ))}
          {visible.map((item) => {
            const { node, width, height, lines, textLeft, textWidth, lineHeight } = item,
              root = node.parentId === null,
              editing = edit?.id === node.id,
              markerCount = Object.keys(node.markers).length,
              compactInset = 7,
              markerStart = canvasStyle === 'compact' ? compactInset : 14,
              labelX = canvasStyle === 'compact' && !markerCount && root ? width / 2 : textLeft,
              editorX =
                canvasStyle === 'compact' && !markerCount && root
                  ? (width - textWidth) / 2
                  : textLeft
            return (
              <g
                key={node.id}
                className={`mind-node ${root ? 'root-node' : ''} ${selectedIds.has(node.id) ? 'selected' : ''} ${preview?.target === node.id ? 'drop-target' : ''}`}
                data-node-id={node.id}
                data-parent-id={node.parentId ?? ''}
                role="button"
                aria-label={`节点 ${node.text}`}
                aria-pressed={selectedIds.has(node.id)}
                onPointerDown={(event) => pointerDown(event, node.id)}
                onDoubleClick={(event) => {
                  event.stopPropagation()
                  if (event.shiftKey || event.altKey) return
                  startEdit(node.id)
                }}
                transform={`translate(${item.x - width / 2} ${item.y - height / 2})`}
              >
                <rect
                  width={width}
                  height={height}
                  rx={root ? 10 : 7}
                  style={
                    root
                      ? undefined
                      : { stroke: selectedIds.has(node.id) ? '#4b88b3' : `${item.color}99` }
                  }
                />
                {Object.entries(node.markers).map(([category, value], i) => (
                  <MarkerIcon
                    key={category}
                    category={category as MarkerCategory}
                    value={value!}
                    x={markerStart + i * 22}
                    y={height / 2 - 9.5}
                  />
                ))}
                {!editing && (
                  <text
                    className="node-label"
                    textAnchor={
                      canvasStyle === 'compact' && !markerCount && root ? 'middle' : 'start'
                    }
                    dominantBaseline="central"
                    xmlSpace="preserve"
                  >
                    {lines.map((line, i) => (
                      <tspan
                        key={i}
                        x={labelX}
                        y={height / 2 + (i - (lines.length - 1) / 2) * lineHeight}
                      >
                        {line || '\u200b'}
                      </tspan>
                    ))}
                  </text>
                )}
                {/* 保留选中节点的输入目标，让首字符和中文组合输入直接进入原位编辑。 */}
                {(editing || selectedId === node.id) && (
                  <foreignObject
                    x={editorX}
                    y={canvasStyle === 'compact' ? 3 : 10}
                    width={textWidth}
                    height={height - (canvasStyle === 'compact' ? 6 : 20)}
                  >
                    <textarea
                      ref={captureInput}
                      className={editing ? 'inline-editor' : 'node-input-capture'}
                      aria-label={editing ? '编辑节点文字' : '输入所选节点文字'}
                      spellCheck={false}
                      value={editing ? edit.text : ''}
                      onChange={(event) => {
                        const text = event.target.value,
                          draft = editing
                            ? { ...edit, text }
                            : { id: node.id, text, original: node.text }
                        if (!editing) {
                          select(node.id)
                          finishing.current = false
                          selectTextOnEdit.current = false
                        }
                        setEdit(draft)
                        void appStore
                          .editorDraft({
                            mapId: map.id,
                            nodeId: draft.id,
                            text,
                            original: draft.original,
                            at: Date.now(),
                          })
                          .catch(() => undefined)
                      }}
                      onCompositionStart={() => {
                        composing.current = true
                        if (!editing) {
                          select(node.id)
                          finishing.current = false
                          selectTextOnEdit.current = false
                          setEdit({ id: node.id, text: '', original: node.text })
                        }
                      }}
                      onCompositionEnd={() => {
                        composing.current = false
                      }}
                      onBlur={() => void finishEdit()}
                      onPointerDown={(event) => event.stopPropagation()}
                      onKeyDown={(event) => {
                        if (!editing) {
                          if (event.key === ' ') {
                            event.preventDefault()
                            event.stopPropagation()
                            startEdit(node.id)
                          }
                          return
                        }
                        event.stopPropagation()
                        if (event.nativeEvent.isComposing || composing.current) return
                        if (event.key === 'Escape') {
                          event.preventDefault()
                          void finishEdit(true)
                        } else if (event.key === 'Enter' && !event.shiftKey) {
                          event.preventDefault()
                          void finishEdit()
                        }
                      }}
                    />
                  </foreignObject>
                )}
                {!!children(map, node.id).length && (
                  <g
                    className="fold-control"
                    role="button"
                    aria-label={`${node.collapsed ? '展开' : '折叠'} ${node.text}`}
                    transform={`translate(${item.side === -1 ? -21 : width + 5},${height / 2 - 8})`}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation()
                      void command({ type: 'fold', nodeId: node.id }).catch(() => undefined)
                    }}
                  >
                    <rect width="16" height="16" rx="6" />
                    <text x="8" y="11.5" textAnchor="middle">
                      {node.collapsed ? '+' : '−'}
                    </text>
                  </g>
                )}
              </g>
            )
          })}
        </g>
      </svg>
      {preview?.target && (
        <div className="attach-hint">
          松手后
          {drag.current && drag.current.nodeIds.length > 1
            ? `将 ${drag.current.roots.length} 个分支`
            : ''}
          挂接到「{map.nodes[preview.target]?.text}」
        </div>
      )}
      <div className="canvas-bottom">
        <span>
          {Object.keys(map.nodes).length} 个节点 · {layout.nodes.length} 个可见
          {selection.ids.length > 1 ? ` · 已选 ${selection.ids.length} 个` : ''}
        </span>
        <div>
          <button aria-label="缩小" onClick={() => zoomAt(1 / 1.15)}>
            −
          </button>
          <span>{Math.round(view.zoom * 100)}%</span>
          <button aria-label="放大" onClick={() => zoomAt(1.15)}>
            ＋
          </button>
          <i />
          <button onClick={fit}>适应画布</button>
          <i />
          <div className="canvas-style-menu" ref={styleMenu}>
            <button
              className="canvas-style-current"
              aria-label={`当前画布风格：${canvasStyle === 'classic' ? '经典' : '紧凑'}`}
              aria-haspopup="listbox"
              aria-expanded={styleMenuOpen}
              onClick={() => setStyleMenuOpen((open) => !open)}
            >
              {canvasStyle === 'classic' ? '经典' : '紧凑'}
              <span className="canvas-style-chevron" aria-hidden="true" />
            </button>
            {styleMenuOpen && (
              <div className="canvas-style-options" role="listbox" aria-label="选择画布风格">
                {(['classic', 'compact'] as CanvasStyle[]).map((style) => (
                  <button
                    key={style}
                    role="option"
                    aria-selected={canvasStyle === style}
                    onClick={() => changeCanvasStyle(style)}
                  >
                    {style === 'classic' ? '经典' : '紧凑'}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="canvas-tip">双击 / F2 编辑 · 滚轮缩放 · 空白处按住左键拖动画布</div>
    </div>
  )
}
