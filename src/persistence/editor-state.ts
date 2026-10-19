export interface CanvasView {
  x: number
  y: number
  zoom: number
}
interface MapEditorState {
  selectedId?: string | null
  selectedIds?: string[]
  anchorId?: string | null
  view?: CanvasView
  style?: CanvasStyle
}
type StorageAccess = () => Pick<Storage, 'getItem' | 'setItem'>
const prefix = 'mindme.editor.v1'

// 浏览器本机的编辑位置独立保存，不写入脑图、outbox 或云端协议。
export class EditorStateStorage {
  constructor(private storage: StorageAccess = () => window.localStorage) {}
  activeMap(): string {
    try {
      return this.storage().getItem(`${prefix}.activeMap`) ?? ''
    } catch {
      return ''
    }
  }
  saveActiveMap(id: string) {
    try {
      this.storage().setItem(`${prefix}.activeMap`, id)
    } catch {
      // 本机偏好存储不可用时，继续使用当前页面的编辑状态。
    }
  }
  map(id: string): MapEditorState {
    try {
      const value = JSON.parse(this.storage().getItem(`${prefix}.map:${id}`) ?? 'null')
      if (!value || value.version !== 1) return {}
      const result: MapEditorState = {}
      if (value.selectedId === null || typeof value.selectedId === 'string')
        result.selectedId = value.selectedId
      if (
        Array.isArray(value.selectedIds) &&
        value.selectedIds.length <= 5000 &&
        value.selectedIds.every((id: unknown) => typeof id === 'string')
      )
        result.selectedIds = [...new Set<string>(value.selectedIds)]
      if (value.anchorId === null || typeof value.anchorId === 'string')
        result.anchorId = value.anchorId
      const view = value.view
      if (
        view &&
        typeof view.x === 'number' &&
        Number.isFinite(view.x) &&
        typeof view.y === 'number' &&
        Number.isFinite(view.y) &&
        typeof view.zoom === 'number' &&
        Number.isFinite(view.zoom) &&
        view.zoom >= 0.15 &&
        view.zoom <= 2.5
      )
        result.view = { x: view.x, y: view.y, zoom: view.zoom }
      if (value.style === 'classic' || value.style === 'compact') result.style = value.style
      return result
    } catch {
      return {}
    }
  }
  updateMap(id: string, patch: MapEditorState) {
    try {
      this.storage().setItem(
        `${prefix}.map:${id}`,
        JSON.stringify({ version: 1, ...this.map(id), ...patch }),
      )
    } catch {
      // 不让偏好存储异常阻断节点编辑或本地内容保存。
    }
  }
  pane(id: string, mapId: string): MapEditorState {
    return this.map(`pane:${id}:${mapId}`)
  }
  updatePane(id: string, mapId: string, patch: MapEditorState) {
    this.updateMap(`pane:${id}:${mapId}`, patch)
  }
}
export const editorState = new EditorStateStorage()
import type { CanvasStyle } from '../editor/style'
