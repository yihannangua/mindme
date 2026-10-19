export interface NodeSelection {
  ids: string[]
  activeId: string | null
  anchorId: string | null
}

export function singleSelection(id: string | null): NodeSelection {
  return { ids: id ? [id] : [], activeId: id, anchorId: id }
}

export function restoreSelection(saved: {
  selectedId?: string | null
  selectedIds?: string[]
  anchorId?: string | null
}): NodeSelection {
  const ids = [...new Set(saved.selectedIds ?? (saved.selectedId ? [saved.selectedId] : []))],
    activeId =
      saved.selectedId && ids.includes(saved.selectedId) ? saved.selectedId : (ids.at(-1) ?? null),
    anchorId = saved.anchorId && ids.includes(saved.anchorId) ? saved.anchorId : activeId
  return { ids, activeId, anchorId }
}

export function retainSelection(selection: NodeSelection, available: Set<string>): NodeSelection {
  const ids = selection.ids.filter((id) => available.has(id))
  if (ids.length === selection.ids.length) return selection
  return restoreSelection({
    selectedIds: ids,
    selectedId: selection.activeId,
    anchorId: selection.anchorId,
  })
}

export function pointerSelection(
  current: NodeSelection,
  target: string,
  mode: 'single' | 'range' | 'toggle',
  visibleOrder: string[],
): NodeSelection {
  if (mode === 'single') return singleSelection(target)
  if (mode === 'toggle') {
    if (!current.ids.includes(target))
      return { ids: [...current.ids, target], activeId: target, anchorId: target }
    return restoreSelection({
      selectedIds: current.ids.filter((id) => id !== target),
      selectedId: current.activeId === target ? null : current.activeId,
      anchorId: current.anchorId === target ? null : current.anchorId,
    })
  }
  const anchor = current.anchorId ?? current.activeId,
    start = anchor ? visibleOrder.indexOf(anchor) : -1,
    end = visibleOrder.indexOf(target)
  if (start < 0 || end < 0) return singleSelection(target)
  // 按可见布局的层级顺序取闭区间；连续 Shift 选择始终保留最初起点。
  return {
    ids: visibleOrder.slice(Math.min(start, end), Math.max(start, end) + 1),
    activeId: target,
    anchorId: anchor,
  }
}
