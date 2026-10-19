import type { MapContent, MindNode } from '../domain/types'
import { measureNode } from './tree'

// 在领域命令的副本上整理整图；原始层级、主题顺序和折叠状态保持不变。
export function balanceMap(map: MapContent): boolean {
  const index = new Map<string, MindNode[]>()
  let changed = false
  for (const node of Object.values(map.nodes)) {
    if (node.position !== null) {
      node.position = null
      changed = true
    }
    if (node.parentId) {
      if (!index.has(node.parentId)) index.set(node.parentId, [])
      index.get(node.parentId)!.push(node)
    }
  }
  const setSide = (node: MindNode, side: -1 | 0 | 1) => {
    if (node.side !== side) {
      node.side = side
      changed = true
    }
  }
  setSide(map.nodes[map.rootId], 0)
  const height = (node: MindNode): number =>
    Math.max(
      measureNode(node).height + 24,
      node.collapsed
        ? 0
        : (index.get(node.id) ?? []).reduce((sum, child) => sum + height(child), 0),
    )
  const branches = (index.get(map.rootId) ?? [])
    .map((node) => ({ node, height: height(node) }))
    .sort((a, b) => a.node.order - b.node.order || a.node.id.localeCompare(b.node.id))
  // 按原有主题顺序遍历，只把每个分支放到当前较轻的一侧，避免布局改变节点顺序。
  let right = 0,
    left = 0
  for (const branch of branches) {
    const side = right <= left ? 1 : -1
    if (side === 1) right += branch.height
    else left += branch.height
    const stack = [branch.node]
    while (stack.length) {
      const node = stack.pop()!
      setSide(node, side)
      stack.push(...(index.get(node.id) ?? []))
    }
  }
  return changed
}
