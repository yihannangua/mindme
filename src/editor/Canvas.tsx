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
import { summaryRangeIds } from '../domain/annotations'
import type { Command } from '../domain/commands'
import { children } from '../domain/model'
import {
  visibleMarkerValues,
  type MapContent,
  type MarkerCategory,
  type MindMap,
  type MindNode,
} from '../domain/types'
import type { ImportDraft } from '../importers/outline'
import { BRANCHES_MIME, branchText, copyBranches } from '../importers/backup'
import {
  edgePath,
  layoutTree,
  measureNode,
  type LayoutNode,
  type TextMeasure,
} from '../layout/tree'
import { linkGeometry, summaryGeometry } from './annotation-layout'
import { appStore } from '../app/store'
import { MarkerIcon } from '../components/MarkerIcon'
import { markerCategoryLabel, markerLabel } from '../persistence/marker-usage'
import { nextDirectionalNode, type Direction } from './navigation'
import { editorState, type CanvasView } from '../persistence/editor-state'
import type { CanvasStyle } from './style'
import { pointerSelection, retainSelection, type NodeSelection } from './selection'
import { backgroundTextColor, nodeFont } from './node-style'

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
  exitFullscreen?: () => void
  linkSource?: string | null
  onLinkTarget?: (id: string) => void
  onLinkCancel?: () => void
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
  exitFullscreen,
  linkSource,
  onLinkTarget,
  onLinkCancel,
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
  const [markerEditor, setMarkerEditor] = useState<{
    nodeId: string
    category: MarkerCategory
    x: number
    y: number
  } | null>(null)
  const markerEditorRef = useRef<HTMLDivElement>(null)
  const [canvasStyle, setCanvasStyle] = useState<CanvasStyle>(savedState.style ?? 'classic'),
    [styleMenuOpen, setStyleMenuOpen] = useState(false),
    [panning, setPanning] = useState(false)
  const [edit, setEdit] = useState<{ id: string; text: string; original: string } | null>(null)
  const [selectedLinkId, setSelectedLinkId] = useState<string | null>(null)
  const [selectedSummaryId, setSelectedSummaryId] = useState<string | null>(null)
  const [annotationEditor, setAnnotationEditor] = useState<{
    kind: 'link' | 'summary'
    id: string
    text: string
    original: string
  } | null>(null)
  const cancelAnnotation = useRef(false)
  useEffect(() => {
    if (!markerEditor) return
    const outside = (event: globalThis.PointerEvent) => {
      if (markerEditorRef.current && !markerEditorRef.current.contains(event.target as Node))
        setMarkerEditor(null)
    }
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setMarkerEditor(null)
    }
    document.addEventListener('pointerdown', outside)
    window.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('pointerdown', outside)
      window.removeEventListener('keydown', escape, true)
    }
  }, [markerEditor])
  useEffect(() => {
    if (markerEditor && !map.nodes[markerEditor.nodeId]) setMarkerEditor(null)
  }, [map, markerEditor])
  const finishing = useRef(false),
    selectTextOnEdit = useRef(true)
  const [editSize, setEditSize] = useState<{ id: string; text: string; height: number } | null>(
    null,
  )
  const measureText = useMemo<TextMeasure | undefined>(() => {
    const context = document.createElement('canvas').getContext('2d')
    if (!context) return
    const widths = new Map<string, number>()
    return (text, node) => {
      const weight = node.summaryOf ? 400 : node.parentId === null ? 600 : 400,
        { family, size: fontSize } = nodeFont(node, canvasStyle),
        key = `${family}:${weight}:${fontSize}:${text}`
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
  const summaryLayouts = useMemo(() => {
    const summaries = map.summaries ?? []
    return summaries.flatMap((summary) => {
      const anchors = summary.nodeIds.map((id) => layout.byId.get(id))
      if (anchors.some((anchor) => !anchor)) return []
      const anchorLayouts = anchors as LayoutNode[],
        summarySide =
          anchorLayouts.filter((anchor) => anchor.side === -1).length > anchorLayouts.length / 2
            ? -1
            : 1
      const summaryNode: MindNode = {
        id: summary.id,
        parentId: map.rootId,
        order: 0,
        text: summary.text,
        collapsed: false,
        markers: {},
        position: null,
        side: 0,
      }
      const metric = measureNode(summaryNode, measureText, canvasStyle)
      return [
        {
          summary,
          ...summaryGeometry(anchorLayouts, metric.width, metric.height, summarySide),
          lines: metric.lines,
          lineHeight: metric.lineHeight,
        },
      ]
    })
  }, [map.summaries, map.rootId, layout, measureText, canvasStyle])
  const summaryNodeBrackets = useMemo(() => {
    return layout.nodes.flatMap((item) => {
      const summaryOf = item.node.summaryOf
      if (!summaryOf) return []
      const anchors = summaryOf.map((id) => layout.byId.get(id))
      if (anchors.some((anchor) => !anchor)) return []
      const side = item.node.side === -1 ? -1 : 1
      const extent = summaryRangeIds(map, summaryOf)
        .map((id) => layout.byId.get(id))
        .filter(Boolean) as LayoutNode[]
      return [
        {
          node: item.node,
          ...summaryGeometry(anchors as LayoutNode[], item.width, item.height, side, extent),
        },
      ]
    })
  }, [layout, map])
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
    const boxes = [
        ...layout.nodes,
        ...summaryLayouts,
        ...summaryNodeBrackets.map((bracket) => ({
          x: bracket.x,
          y: (bracket.top + bracket.bottom) / 2,
          width: bracket.width,
          height: bracket.bottom - bracket.top,
        })),
      ],
      minX = Math.min(...boxes.map((n) => n.x - n.width / 2)),
      maxX = Math.max(...boxes.map((n) => n.x + n.width / 2)),
      minY = Math.min(...boxes.map((n) => n.y - n.height / 2)),
      maxY = Math.max(...boxes.map((n) => n.y + n.height / 2))
    setView({ x: (-(minX + maxX) / 2) * zoom, y: (-(minY + maxY) / 2) * zoom, zoom })
  }, [size, layout, summaryLayouts, summaryNodeBrackets])
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
  const openMarkerEditor = (
    element: SVGGraphicsElement,
    nodeId: string,
    category: MarkerCategory,
  ) => {
    const host = container.current?.getBoundingClientRect()
    if (!host) return
    const rect = element.getBoundingClientRect()
    select(nodeId)
    setMarkerEditor({
      nodeId,
      category,
      x: Math.max(8, Math.min(rect.left - host.left, Math.max(8, host.width - 252))),
      y: Math.max(8, Math.min(rect.bottom - host.top + 4, Math.max(8, host.height - 220))),
    })
  }
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
  const openLinkEditor = useCallback(
    (id: string) => {
      const link = (map.links ?? []).find((item) => item.id === id)
      if (!link) return
      cancelAnnotation.current = false
      setSelectedLinkId(id)
      setSelectedSummaryId(null)
      setAnnotationEditor({ kind: 'link', id, text: link.text, original: link.text })
      select(null)
    },
    [map, select],
  )
  const openSummaryEditor = useCallback(
    (id: string) => {
      const summary = (map.summaries ?? []).find((item) => item.id === id)
      if (!summary) return
      cancelAnnotation.current = false
      setSelectedSummaryId(id)
      setSelectedLinkId(null)
      setAnnotationEditor({ kind: 'summary', id, text: summary.text, original: summary.text })
      select(null)
    },
    [map, select],
  )
  const chooseLink = useCallback(
    (id: string) => {
      select(null)
      setSelectedSummaryId(null)
      setSelectedLinkId(id)
      container.current?.focus({ preventScroll: true })
    },
    [select],
  )
  const finishAnnotationEdit = useCallback(
    (cancel = false) => {
      const editor = annotationEditor
      if (!editor) return
      if (cancel) cancelAnnotation.current = true
      setAnnotationEditor(null)
      if (cancelAnnotation.current || editor.text === editor.original) return
      const action: Command =
        editor.kind === 'link'
          ? { type: 'link-text', linkId: editor.id, text: editor.text }
          : { type: 'summary-text', summaryId: editor.id, text: editor.text }
      void command(action).catch(() => undefined)
    },
    [annotationEditor, command],
  )
  useEffect(() => {
    if (selectedLinkId && !(map.links ?? []).some((link) => link.id === selectedLinkId))
      setSelectedLinkId(null)
    if (selectedSummaryId && !(map.summaries ?? []).some((item) => item.id === selectedSummaryId))
      setSelectedSummaryId(null)
    if (annotationEditor) {
      const exists =
        annotationEditor.kind === 'link'
          ? (map.links ?? []).some((link) => link.id === annotationEditor.id)
          : (map.summaries ?? []).some((item) => item.id === annotationEditor.id)
      if (!exists) setAnnotationEditor(null)
    }
  }, [map, selectedLinkId, selectedSummaryId, annotationEditor])
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
  useLayoutEffect(() => {
    if (edit) {
      input.current?.focus({ preventScroll: true })
      if (selectTextOnEdit.current && !composing.current) input.current?.select()
    } else if (selectedId && container.current?.contains(document.activeElement)) {
      input.current?.focus({ preventScroll: true })
    }
  }, [edit?.id, selectedId])
  const finishEdit = useCallback(
    async (cancel = false, returnFocus = true) => {
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
      if (returnFocus) container.current?.focus()
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
    if (linkSource && key === 'escape') {
      event.preventDefault()
      onLinkCancel?.()
      return
    }
    if ((selectedLinkId || selectedSummaryId) && (key === 'backspace' || key === 'delete')) {
      const action: Command = selectedLinkId
        ? { type: 'link-delete', linkId: selectedLinkId }
        : { type: 'summary-delete', summaryId: selectedSummaryId! }
      event.preventDefault()
      setSelectedLinkId(null)
      setSelectedSummaryId(null)
      setAnnotationEditor(null)
      void command(action).catch(() => undefined)
      return
    }
    if (key === 'escape' && (selectedLinkId || selectedSummaryId)) {
      event.preventDefault()
      setSelectedLinkId(null)
      setSelectedSummaryId(null)
      setAnnotationEditor(null)
      return
    }
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
    // 焦点仍在画布容器时也能立即开始编辑，不依赖透明输入框的焦点时序。
    if (!mod && !event.altKey && key === ' ' && event.target === event.currentTarget) {
      event.preventDefault()
      startEdit(selectedId)
      return
    }
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
    if (key === 'escape') {
      if (exitFullscreen) {
        event.preventDefault()
        event.stopPropagation()
        exitFullscreen()
      } else select(null)
    }
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
    if (linkSource && id) {
      event.preventDefault()
      event.stopPropagation()
      select(id)
      if (id === linkSource) {
        notify('不能把节点连接到自身')
        return
      }
      onLinkTarget?.(id)
      container.current?.focus({ preventScroll: true })
      return
    }
    if (id) {
      setSelectedLinkId(null)
      setSelectedSummaryId(null)
    } else {
      setSelectedLinkId(null)
      setSelectedSummaryId(null)
    }
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
            Object.fromEntries(layout.nodes.map((item) => [item.node.id, item.node.parentId])),
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
  const displayLinks = (map.links ?? []).flatMap((link) => {
    const from = displayById.get(link.fromId),
      to = displayById.get(link.toId)
    if (!from || !to || !visibleIds.has(from.node.id) || !visibleIds.has(to.node.id)) return []
    const fromSide = from.side === 0 ? (to.x >= from.x ? 1 : -1) : from.side,
      toSide = to.side === 0 ? (from.x >= to.x ? 1 : -1) : to.side
    return [{ link, geometry: linkGeometry(from, to, fromSide, toSide) }]
  })
  const visibleSummaries = summaryLayouts.filter((item) =>
    item.summary.nodeIds.every((id) => visibleIds.has(id)),
  )
  const visibleSummaryNodeBrackets = summaryNodeBrackets.filter(
    ({ node }) => visibleIds.has(node.id) && node.summaryOf?.every((id) => visibleIds.has(id)),
  )
  const annotationPosition = annotationEditor
    ? annotationEditor.kind === 'link'
      ? (() => {
          const item = displayLinks.find(({ link }) => link.id === annotationEditor.id)
          return item
            ? {
                x: size.width / 2 + view.x + item.geometry.labelX * view.zoom,
                y: size.height / 2 + view.y + item.geometry.labelY * view.zoom,
              }
            : null
        })()
      : (() => {
          const item = summaryLayouts.find(({ summary }) => summary.id === annotationEditor.id)
          return item
            ? {
                x: size.width / 2 + view.x + item.x * view.zoom,
                y: size.height / 2 + view.y + item.y * view.zoom,
              }
            : null
        })()
    : null
  return (
    <div
      className={`canvas${panning ? ' panning' : ''}${linkSource ? ' linking' : ''}`}
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
          {visibleSummaries.map(({ summary, bracketPath, compactBracketPath }) => (
            <path
              key={`summary-bracket-${summary.id}`}
              className="summary-bracket"
              d={canvasStyle === 'compact' ? compactBracketPath : bracketPath}
            />
          ))}
          {visibleSummaryNodeBrackets.map(({ node, bracketPath, compactBracketPath }) => (
            <path
              key={`summary-node-bracket-${node.id}`}
              className="summary-bracket"
              d={canvasStyle === 'compact' ? compactBracketPath : bracketPath}
            />
          ))}
          {displayLinks.map(({ link, geometry }) => (
            <g key={`link-${link.id}`}>
              <path
                className="node-link-hit"
                data-link-id={link.id}
                d={geometry.d}
                vectorEffect="non-scaling-stroke"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation()
                  chooseLink(link.id)
                }}
              />
              <path
                className={`node-link ${selectedLinkId === link.id ? 'selected' : ''}`}
                data-from-side={geometry.fromSide}
                data-to-side={geometry.toSide}
                d={geometry.d}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation()
                  chooseLink(link.id)
                }}
              />
            </g>
          ))}
          {visible.map((item) => {
            const { node, width, height, lines, textLeft, textWidth, lineHeight } = item,
              root = node.parentId === null && !node.summaryOf,
              editing = edit?.id === node.id,
              markerCount = Object.keys(node.markers).length,
              compactInset = 7,
              markerStart = canvasStyle === 'compact' ? compactInset : 14,
              labelX = canvasStyle === 'compact' && !markerCount && root ? width / 2 : textLeft,
              editorX =
                canvasStyle === 'compact' && !markerCount && root
                  ? (width - textWidth) / 2
                  : textLeft
            const font = nodeFont(node, canvasStyle)
            return (
              <g
                key={node.id}
                className={`mind-node ${root ? 'root-node' : ''} ${selectedIds.has(node.id) ? 'selected' : ''} ${preview?.target === node.id ? 'drop-target' : ''} ${linkSource === node.id ? 'link-source' : ''}`}
                data-node-id={node.id}
                data-parent-id={node.parentId ?? ''}
                data-summary-id={node.summaryOf ? node.id : undefined}
                data-anchor-count={node.summaryOf?.length}
                data-summary-side={node.summaryOf ? node.side : undefined}
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
                  style={{
                    ...(node.backgroundColor ? { fill: node.backgroundColor } : {}),
                    ...(!root
                      ? { stroke: selectedIds.has(node.id) ? '#4b88b3' : `${item.color}99` }
                      : {}),
                  }}
                />
                {Object.entries(node.markers).map(([category, value], i) => {
                  const markerCategory = category as MarkerCategory,
                    markerValue = value!
                  return (
                    <MarkerIcon
                      key={category}
                      category={markerCategory}
                      value={markerValue}
                      x={markerStart + i * 22}
                      y={height / 2 - 9.5}
                      label={`编辑图标：${markerLabel(markerCategory, markerValue)}`}
                      onActivate={(element) => openMarkerEditor(element, node.id, markerCategory)}
                    />
                  )
                })}
                {!editing && (
                  <text
                    className="node-label"
                    style={{
                      fontFamily: font.family,
                      fontSize: font.size,
                      ...(node.backgroundColor
                        ? { fill: backgroundTextColor(node.backgroundColor) }
                        : {}),
                    }}
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
                      style={{
                        fontFamily: font.family,
                        fontSize: font.size,
                        lineHeight: `${lineHeight}px`,
                      }}
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
                      onBlur={() => void finishEdit(false, false)}
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
          {displayLinks.map(({ link, geometry }) => {
            const width = Math.max(48, link.text.length * 13 + 20)
            return (
              <g
                key={`link-label-${link.id}`}
                className={`node-link-label ${selectedLinkId === link.id ? 'selected' : ''}`}
                data-link-id={link.id}
                role="button"
                aria-label={`编辑连线：${link.text}`}
                transform={`translate(${geometry.labelX} ${geometry.labelY})`}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation()
                  openLinkEditor(link.id)
                }}
              >
                <rect x={-width / 2} y={-12} width={width} height={24} rx={7} />
                <text textAnchor="middle" dominantBaseline="central">
                  {link.text}
                </text>
              </g>
            )
          })}
          {visibleSummaries.map(({ summary, side, x, y, width, height, lines, lineHeight }) => (
            <g
              key={`summary-${summary.id}`}
              className={`summary-annotation ${selectedSummaryId === summary.id ? 'selected' : ''}`}
              data-summary-id={summary.id}
              data-anchor-count={summary.nodeIds.length}
              data-summary-side={side}
              role="button"
              aria-label={`编辑概括：${summary.text}`}
              transform={`translate(${x - width / 2} ${y - height / 2})`}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation()
                openSummaryEditor(summary.id)
              }}
            >
              <rect width={width} height={height} rx={8} />
              <text textAnchor="middle" dominantBaseline="central">
                {lines.map((line, index) => (
                  <tspan
                    key={index}
                    x={width / 2}
                    y={height / 2 + (index - (lines.length - 1) / 2) * lineHeight}
                  >
                    {line || '\u200b'}
                  </tspan>
                ))}
              </text>
            </g>
          ))}
        </g>
      </svg>
      {annotationEditor && annotationPosition && (
        <div
          className="annotation-editor"
          style={{
            left: Math.max(80, Math.min(Math.max(80, size.width - 80), annotationPosition.x)),
            top: Math.max(32, Math.min(Math.max(32, size.height - 32), annotationPosition.y)),
          }}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <input
            autoFocus
            aria-label={annotationEditor.kind === 'link' ? '编辑连线文字' : '编辑概括文字'}
            value={annotationEditor.text}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => {
              const text = event.target.value
              setAnnotationEditor((current) => (current ? { ...current, text } : current))
            }}
            onBlur={() => finishAnnotationEdit(false)}
            onKeyDown={(event) => {
              event.stopPropagation()
              if (event.key === 'Escape') {
                event.preventDefault()
                cancelAnnotation.current = true
                event.currentTarget.blur()
              } else if (event.key === 'Enter') {
                event.preventDefault()
                event.currentTarget.blur()
              }
            }}
          />
        </div>
      )}
      {markerEditor &&
        (() => {
          const editor = markerEditor,
            editorNode = map.nodes[editor.nodeId],
            currentValue = editorNode?.markers[editor.category]
          if (!editorNode || !currentValue) return null
          return (
            <div
              className="node-marker-editor"
              role="dialog"
              aria-label="编辑节点图标"
              ref={markerEditorRef}
              style={{ left: editor.x, top: editor.y }}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
            >
              <div className="node-marker-editor-head">
                <span>{markerCategoryLabel(editor.category)}</span>
                <button aria-label="关闭图标编辑" onClick={() => setMarkerEditor(null)}>
                  ×
                </button>
              </div>
              <div className="node-marker-editor-grid">
                {visibleMarkerValues(editor.category).map((value) => (
                  <button
                    key={value}
                    aria-label={markerLabel(editor.category, value)}
                    aria-pressed={value === currentValue}
                    onClick={() => {
                      setMarkerEditor(null)
                      void command({
                        type: 'marker',
                        nodeId: editorNode.id,
                        category: editor.category,
                        value,
                      }).catch(() => undefined)
                    }}
                  >
                    <svg width="20" height="20">
                      <MarkerIcon category={editor.category} value={value} />
                    </svg>
                  </button>
                ))}
              </div>
              <button
                className="node-marker-delete"
                onClick={() => {
                  setMarkerEditor(null)
                  void command({
                    type: 'marker',
                    nodeId: editorNode.id,
                    category: editor.category,
                    value: currentValue,
                  }).catch(() => undefined)
                }}
              >
                删除图标
              </button>
            </div>
          )
        })()}
      {linkSource && <div className="attach-hint">连线中：点击目标节点完成连线；按 Esc 取消</div>}
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
    </div>
  )
}
