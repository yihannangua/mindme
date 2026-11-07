import { useState } from 'react'
import { ChevronRight, FileText, Pencil } from 'lucide-react'
import type { DragEvent } from 'react'
import type { MindMap } from '../domain/types'
import type { MapGroupState } from '../persistence/map-groups'
import { PANE_MAP_DRAG_TYPE } from './drag-types'

interface Props {
  maps: MindMap[]
  activeId: string
  filter: string
  groups: MapGroupState
  onOpenMap: (id: string) => void
  onToggleGroup: (id: string) => void
  onRenameGroup: (id: string) => void
  onAssignMap: (mapId: string, groupId: string | null) => void
}

export function MapGroupList({
  maps,
  activeId,
  filter,
  groups,
  onOpenMap,
  onToggleGroup,
  onRenameGroup,
  onAssignMap,
}: Props) {
  const [dragGroupId, setDragGroupId] = useState<string | null | undefined>(undefined)
  const filtered = maps
      .filter((map) => map.title.includes(filter))
      .sort((a, b) => b.updatedAt - a.updatedAt),
    ordered = [...groups.groups].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)),
    ungrouped = filtered.filter(
      (map) => !ordered.some((group) => group.id === groups.assignments[map.id]),
    ),
    sections = ordered.map((group) => ({
      group,
      items: filtered.filter((map) => groups.assignments[map.id] === group.id),
    })),
    visibleSections = filter ? sections.filter((section) => section.items.length > 0) : sections,
    showUngrouped = !filter || ungrouped.length > 0

  const dropProps = (groupId: string | null) => ({
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (!event.dataTransfer.types.includes(PANE_MAP_DRAG_TYPE)) return
      event.preventDefault()
      event.stopPropagation()
      event.dataTransfer.dropEffect = 'move'
      setDragGroupId(groupId)
    },
    onDragLeave: (event: DragEvent<HTMLElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null))
        setDragGroupId(undefined)
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      if (!event.dataTransfer.types.includes(PANE_MAP_DRAG_TYPE)) return
      event.preventDefault()
      event.stopPropagation()
      const mapId = event.dataTransfer.getData(PANE_MAP_DRAG_TYPE)
      setDragGroupId(undefined)
      if (mapId) onAssignMap(mapId, groupId)
    },
  })

  const mapButton = (map: MindMap) => (
    <button
      key={map.id}
      title={map.title}
      draggable
      className={`file ${map.id === activeId ? 'active' : ''}`}
      onDragStart={(event) => {
        event.dataTransfer.setData(PANE_MAP_DRAG_TYPE, map.id)
        event.dataTransfer.effectAllowed = 'copyMove'
      }}
      onDragEnd={() => setDragGroupId(undefined)}
      onClick={() => onOpenMap(map.id)}
    >
      <FileText size={15} />
      <span>{map.title}</span>
    </button>
  )

  if (!filtered.length)
    return (
      <nav className="files">
        <p className="muted">{maps.length ? '没有匹配的脑图。' : '新建一张，开始整理想法。'}</p>
      </nav>
    )

  return (
    <nav className="files map-groups">
      {showUngrouped && (
        <section
          className={`map-group ${dragGroupId === null ? 'drop-group' : ''}`}
          aria-label="未分组"
          role="group"
          {...dropProps(null)}
        >
          <div className="map-group-title ungrouped">
            <span>未分组</span>
            <span className="map-group-count">{ungrouped.length}</span>
          </div>
          <div className="map-group-items">{ungrouped.map(mapButton)}</div>
        </section>
      )}
      {visibleSections.map(({ group, items }) => (
        <section
          className={`map-group ${dragGroupId === group.id ? 'drop-group' : ''}`}
          key={group.id}
          aria-label={`分组 ${group.name}`}
          role="group"
          {...dropProps(group.id)}
        >
          <div className="map-group-title">
            <button
              type="button"
              className="map-group-toggle"
              aria-expanded={!group.collapsed}
              aria-label={`${group.collapsed ? '展开' : '折叠'}分组 ${group.name}`}
              onClick={() => onToggleGroup(group.id)}
            >
              <ChevronRight className={group.collapsed ? '' : 'open'} size={13} />
              <span>{group.name}</span>
              <span className="map-group-count">{items.length}</span>
            </button>
            <button
              type="button"
              className="map-group-rename"
              aria-label={`重命名分组 ${group.name}`}
              title="重命名分组"
              onClick={() => onRenameGroup(group.id)}
            >
              <Pencil size={12} />
            </button>
          </div>
          {!group.collapsed && (
            <div className="map-group-items">
              {items.map(mapButton)}
              {!items.length && <p className="muted small">暂无脑图</p>}
            </div>
          )}
        </section>
      ))}
    </nav>
  )
}
