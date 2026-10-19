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
  // 只在顺序中选择一个左右分界，避免贪心分配造成两侧交错并改变顺时针顺序。
  const total = branches.reduce((sum, branch) => sum + branch.height, 0)
  let right = 0,
    split = 0,
    difference = total
  for (let index = 0; index <= branches.length; index++) {
    const nextDifference = Math.abs(total - right * 2)
    if (nextDifference <= difference) {
      difference = nextDifference
      split = index
    }
    if (index < branches.length) right += branches[index].height
  }
  for (const [branchIndex, branch] of branches.entries()) {
    const side = branchIndex < split ? 1 : -1
    const stack = [branch.node]
    while (stack.length) {
      const node = stack.pop()!
      setSide(node, side)
      stack.push(...(index.get(node.id) ?? []))
    }
  }
  return changed
}
