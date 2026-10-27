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
  parents: Record<string, string | null>,
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
  const anchor = current.anchorId ?? current.activeId
  if (
    !anchor ||
    !Object.hasOwn(parents, anchor) ||
    !Object.hasOwn(parents, target) ||
    parents[anchor] !== parents[target]
  )
    return singleSelection(target)
  const siblings = visibleOrder.filter((id) => parents[id] === parents[target]),
    start = anchor ? siblings.indexOf(anchor) : -1,
    end = siblings.indexOf(target)
  if (start < 0 || end < 0) return singleSelection(target)
  // 只在同一父节点的可见子节点中取闭区间，连续选择保留起点。
  return {
    ids: siblings.slice(Math.min(start, end), Math.max(start, end) + 1),
    activeId: target,
    anchorId: anchor,
  }
}
