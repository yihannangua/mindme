import type { LayoutNode, TreeLayout } from '../layout/tree'

export type Direction = 'up' | 'down' | 'left' | 'right'

function closestVertical(
  nodes: LayoutNode[],
  current: LayoutNode,
  sign?: number,
): LayoutNode | undefined {
  const candidates = sign
    ? nodes.filter((candidate) => (candidate.y - current.y) * sign > 1)
    : nodes
  return candidates
    .map((node, index) => ({ node, index }))
    .sort(
      (a, b) =>
        Math.abs(a.node.y - current.y) - Math.abs(b.node.y - current.y) || a.index - b.index,
    )[0]?.node
}

export function nextDirectionalNode(
  layout: TreeLayout,
  selectedId: string,
  direction: Direction,
): LayoutNode | undefined {
  const current = layout.byId.get(selectedId)
  if (!current) return
  const sign = direction === 'left' || direction === 'up' ? -1 : 1

  if (direction === 'left' || direction === 'right') {
    if (current.node.parentId === null) {
      return closestVertical(
        layout.nodes.filter(
          (candidate) => candidate.node.parentId === current.node.id && candidate.side === sign,
        ),
        current,
      )
    }
    if (sign !== current.side) return layout.byId.get(current.node.parentId)
    return closestVertical(
      layout.nodes.filter(
        (candidate) =>
          candidate.node.parentId === current.node.id && candidate.side === current.side,
      ),
      current,
    )
  }

  if (current.node.parentId !== null) {
    const siblings = layout.nodes.filter(
      (candidate) =>
        candidate.node.id !== selectedId &&
        candidate.node.parentId === current.node.parentId &&
        candidate.side === current.side,
    )
    const sibling = closestVertical(siblings, current, sign)
    if (sibling) return sibling

    const parent = layout.byId.get(current.node.parentId)
    if (!parent?.node.parentId) return
    const siblingParents = layout.nodes.filter(
      (candidate) =>
        candidate.node.id !== parent.node.id &&
        candidate.node.parentId === parent.node.parentId &&
        candidate.side === current.side &&
        (candidate.y - parent.y) * sign > 1,
    )
    const orderedParents = siblingParents
      .map((node, index) => ({ node, index }))
      .sort(
        (a, b) =>
          Math.abs(a.node.y - parent.y) - Math.abs(b.node.y - parent.y) || a.index - b.index,
      )
    for (const siblingParent of orderedParents) {
      const child = closestVertical(
        layout.nodes.filter(
          (candidate) =>
            candidate.node.parentId === siblingParent.node.node.id &&
            candidate.side === current.side,
        ),
        current,
      )
      if (child) return child
    }
    return
  }

  return undefined
}
