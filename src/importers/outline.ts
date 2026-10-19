import { assert, LIMITS, type Markers } from '../domain/types'
export interface DraftNode {
  id: string
  parentId: string | null
  text: string
  markers: Markers
  collapsed?: boolean
}
export interface ImportDraft {
  title: string
  nodes: DraftNode[]
}
export interface ImportResult {
  drafts: ImportDraft[]
  warnings: string[]
}
export function parseOutline(text: string): ImportResult {
  assert(typeof text === 'string' && text.length <= 16 * 1024 * 1024, '大纲过大，请拆分后导入')
  const nodes: DraftNode[] = [],
    stack: { id: string; depth: number }[] = [],
    warnings = new Set<string>()
  if (/```|\[[^\]]*\]\(|^\s*[-*+]\s+\[[ xX]\]/m.test(text))
    warnings.add('链接、代码块和任务属性按纯文字保留，不转换为扩展属性')
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    const heading = line.match(/^(#{1,6})\s+(.*)$/),
      list = line.match(/^(\s*)[-*+]\s+(.*)$/)
    const indent = (line.match(/^\s*/)?.[0] ?? '').replace(/\t/g, '  ').length
    const depth = heading
      ? heading[1].length - 1
      : list
        ? 1 + Math.floor(list[1].replace(/\t/g, '  ').length / 2)
        : Math.floor(indent / 2)
    const label = (heading ? heading[2] : list ? list[2] : line.trim()).trim()
    if (!label) continue
    assert(
      depth <= LIMITS.depth && nodes.length < LIMITS.nodes,
      '导入最多支持 5000 个节点和 128 层',
    )
    while (stack.length && stack.at(-1)!.depth >= depth) stack.pop()
    const node = {
      id: `outline-${nodes.length}`,
      parentId: stack.at(-1)?.id ?? null,
      text: label,
      markers: {},
    }
    nodes.push(node)
    stack.push({ id: node.id, depth })
  }
  if (!nodes.length) return { drafts: [], warnings: ['内容为空，没有新建脑图'] }
  const roots = nodes.filter((node) => node.parentId === null)
  if (roots.length > 1) {
    nodes.unshift({ id: 'outline-root', parentId: null, text: '导入的脑图', markers: {} })
    roots.forEach((node) => {
      node.parentId = 'outline-root'
    })
  }
  return { drafts: [{ title: nodes[0].text, nodes }], warnings: [...warnings] }
}
