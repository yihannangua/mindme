export const SCHEMA_VERSION = 1 as const
export const LIMITS = {
  nodes: 5000,
  depth: 128,
  text: 20000,
  maps: 200,
  fileBytes: 20 * 1024 * 1024,
} as const
export const MARKERS = {
  priority: ['①', '②', '③', '④'],
  progress: ['start', '1/8', '2/8', '3/8', '4/8', '5/8', '6/8', '7/8', 'done'],
  flag: ['red', 'orange', 'blue', 'green', 'purple', 'teal', 'gray'],
} as const
export type MarkerCategory = keyof typeof MARKERS
export type Markers = Partial<Record<MarkerCategory, string>>
export const NODE_FONTS = ['sans', 'serif', 'mono'] as const
export type NodeFont = (typeof NODE_FONTS)[number]
export interface MindNode {
  id: string
  parentId: string | null
  order: number
  text: string
  collapsed: boolean
  markers: Markers
  position: { x: number; y: number } | null
  side: -1 | 0 | 1
  fontFamily?: NodeFont | null
  fontSize?: number | null
  backgroundColor?: string | null
}
export interface MapContent {
  id: string
  title: string
  rootId: string
  nodes: Record<string, MindNode>
  deletedAt: number | null
}
export interface HistorySnapshot {
  schemaVersion: 1
  id: string
  at: number
  reason: 'window' | 'leave' | 'restore'
  content: MapContent
}
export interface MindMap extends MapContent {
  schemaVersion: 1
  updatedAt: number
  revision: number
  history: HistorySnapshot[]
  historyDirtySince: number | null
}
export interface TabState {
  mapId: string
  order: number
  pinned: boolean
  open: boolean
}
export interface Space {
  schemaVersion: 1
  maps: Record<string, MindMap>
  tabs: Record<string, TabState>
}
export interface Stamp {
  deviceId: string
  deviceSeq: number
  at: number
  uncertainty: number
}
export interface Change {
  mapId: string
  nodeId?: string
  field: string
  before: unknown
  after: unknown
}
export interface HistoryChange {
  mapId: string
  field: 'history-add'
  before: null
  after: HistorySnapshot
}
export interface Operation {
  schemaVersion: 1
  opId: string
  stamp: Stamp
  baseRevision: number
  intent?: 'edit' | 'undo' | 'bootstrap' | 'restore'
  changes: Change[]
  state: 'pending' | 'sending' | 'confirmed' | 'retry' | 'attention' | 'discarded'
  attempts: number
}
export interface ConflictDraft {
  id: string
  opId: string
  at: number
  reason: string
  text: string
}
export interface LocalSnapshot {
  schemaVersion: 1
  space: Space
  outbox: Operation[]
  drafts: ConflictDraft[]
  deviceId: string
  deviceSeq: number
  serverSeq: number
  ownerSub: string | null
  serverSpace?: Space
  localTabs?: Record<string, boolean>
  editorDraft?: { mapId: string; nodeId: string; text: string; original: string; at: number }
}
export interface Context {
  now: number
  id: () => string
}
export const emptySpace = (): Space => ({ schemaVersion: 1, maps: {}, tabs: {} })
export const clone = <T>(value: T): T => structuredClone(value)
export const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
export class DomainError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DomainError'
  }
}
export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new DomainError(message)
}
export const own = (value: object, key: string) => Object.hasOwn(value, key)
export const safeId = (id: unknown): id is string =>
  typeof id === 'string' &&
  /^[a-zA-Z0-9_-]{1,100}$/.test(id) &&
  !['__proto__', 'prototype', 'constructor'].includes(id) &&
  !Object.hasOwn(Object.prototype, id)
