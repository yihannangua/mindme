import {
  assert,
  clone,
  emptySpace,
  LIMITS,
  MARKERS,
  NODE_FONTS,
  own,
  safeId,
  type Context,
  type MapContent,
  type MindMap,
  type MindNode,
  type Space,
} from './types'

export const nameKey = (name: string) => name.trim().normalize('NFC')
export function assertName(space: Space, name: string, except?: string) {
  assert(
    typeof name === 'string' && nameKey(name).length > 0 && name.length <= LIMITS.text,
    '脑图名称不能为空或过长',
  )
  assert(
    !Object.values(space.maps).some(
      (map) => map.id !== except && nameKey(map.title) === nameKey(name),
    ),
    '名称已被使用（包含回收站）',
  )
}
export function uniqueName(space: Space, requested: string) {
  const base = requested.trim() || '未命名脑图'
  const names = new Set(Object.values(space.maps).map((map) => nameKey(map.title)))
  let name = base,
    index = 2
  while (names.has(nameKey(name))) name = `${base} (${index++})`
  return name
}
export function children(map: MapContent, id: string) {
  return Object.values(map.nodes)
    .filter((node) => node.parentId === id)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
}
export function subtree(map: MapContent, id: string): string[] {
  assert(own(map.nodes, id), '节点不存在')
  const index = new Map<string, string[]>()
  for (const node of Object.values(map.nodes))
    if (node.parentId) index.set(node.parentId, [...(index.get(node.parentId) ?? []), node.id])
  const result: string[] = [],
    stack = [id],
    seen = new Set<string>()
  while (stack.length) {
    const next = stack.pop()!
    assert(!seen.has(next), '脑图存在循环引用')
    seen.add(next)
    result.push(next)
    stack.push(...(index.get(next) ?? []))
  }
  return result
}
export function validateMap(map: MapContent) {
  assert(map && safeId(map.id) && safeId(map.rootId), '脑图标识不合法')
  assert(
    typeof map.title === 'string' && nameKey(map.title) && map.title.length <= LIMITS.text,
    '脑图名称不合法',
  )
  assert(map.nodes && typeof map.nodes === 'object' && !Array.isArray(map.nodes), '节点数据不合法')
  const nodes = Object.values(map.nodes)
  assert(nodes.length > 0 && nodes.length <= LIMITS.nodes, '每张脑图须包含 1–5000 个节点')
  assert(own(map.nodes, map.rootId) && map.nodes[map.rootId].parentId === null, '缺少唯一中心节点')
  assert(map.nodes[map.rootId].text === map.title, '中心主题与脑图名称必须一致')
  assert(
    map.deletedAt === null || (Number.isFinite(map.deletedAt) && map.deletedAt >= 0),
    '删除时间不合法',
  )
  const index = new Map<string, string[]>()
  for (const [id, node] of Object.entries(map.nodes)) {
    assert(node && safeId(id) && id === node.id, '节点标识不合法或不一致')
    assert(
      typeof node.text === 'string' && node.text.length <= LIMITS.text,
      '节点文字过长或格式错误',
    )
    assert(
      typeof node.collapsed === 'boolean' &&
        [-1, 0, 1].includes(node.side) &&
        Number.isFinite(node.order),
      '节点属性不合法',
    )
    assert(node.fontFamily == null || NODE_FONTS.includes(node.fontFamily), '节点字体不合法')
    assert(
      node.fontSize == null ||
        (Number.isInteger(node.fontSize) && node.fontSize >= 10 && node.fontSize <= 48),
      '节点字号须为 10 至 48',
    )
    assert(
      node.backgroundColor == null || /^#[0-9a-fA-F]{6}$/.test(node.backgroundColor),
      '节点背景色不合法',
    )
    assert(
      node.position === null ||
        (typeof node.position === 'object' &&
          Number.isFinite(node.position.x) &&
          Number.isFinite(node.position.y) &&
          Math.abs(node.position.x) <= 100000 &&
          Math.abs(node.position.y) <= 100000),
      '节点位置不合法',
    )
    assert(
      node.markers && typeof node.markers === 'object' && !Array.isArray(node.markers),
      '标记格式不合法',
    )
    for (const [category, value] of Object.entries(node.markers))
      assert(
        own(MARKERS, category) &&
          (MARKERS[category as keyof typeof MARKERS] as readonly unknown[]).includes(value),
        '标记不合法',
      )
    if (id !== map.rootId) {
      assert(
        typeof node.parentId === 'string' && own(map.nodes, node.parentId) && node.parentId !== id,
        '父节点不存在或非法自引用',
      )
      index.set(node.parentId, [...(index.get(node.parentId) ?? []), id])
    }
  }
  const stack: [string, number][] = [[map.rootId, 0]],
    seen = new Set<string>()
  while (stack.length) {
    const [id, depth] = stack.pop()!
    assert(!seen.has(id) && depth <= LIMITS.depth, '存在循环引用或超过 128 层')
    seen.add(id)
    for (const child of index.get(id) ?? []) stack.push([child, depth + 1])
  }
  assert(seen.size === nodes.length, '存在孤立节点或循环引用')
}
export function validateSpace(space: Space) {
  assert(
    space &&
      space.schemaVersion === 1 &&
      space.maps &&
      space.tabs &&
      typeof space.maps === 'object' &&
      typeof space.tabs === 'object' &&
      !Array.isArray(space.maps) &&
      !Array.isArray(space.tabs),
    '空间格式或版本不支持',
  )
  assert(Object.keys(space.maps).length <= LIMITS.maps, '空间最多支持 200 张脑图')
  const names = new Set<string>()
  for (const [id, map] of Object.entries(space.maps)) {
    assert(
      id === map.id &&
        map.schemaVersion === 1 &&
        Number.isFinite(map.updatedAt) &&
        Number.isFinite(map.revision) &&
        map.revision >= 0,
      '脑图元数据不合法',
    )
    validateMap(map)
    assert(Array.isArray(map.history) && map.history.length <= 10, '历史版本格式不合法')
    for (const version of map.history) {
      assert(
        version &&
          version.schemaVersion === 1 &&
          safeId(version.id) &&
          Number.isFinite(version.at) &&
          version.content?.id === id &&
          ['window', 'leave', 'restore'].includes(version.reason),
        '历史版本数据不合法',
      )
      validateMap(version.content)
    }
    assert(
      map.historyDirtySince === null || Number.isFinite(map.historyDirtySince),
      '版本窗口不合法',
    )
    assert(!names.has(nameKey(map.title)), '脑图名称重复（包含回收站）')
    names.add(nameKey(map.title))
  }
  for (const [id, tab] of Object.entries(space.tabs))
    assert(
      own(space.maps, id) &&
        tab.mapId === id &&
        typeof tab.open === 'boolean' &&
        typeof tab.pinned === 'boolean' &&
        Number.isFinite(tab.order),
      '标签数据不合法',
    )
}
export function makeNode(id: string, parentId: string | null, text: string, order = 0): MindNode {
  return {
    id,
    parentId,
    text,
    order,
    collapsed: false,
    markers: {},
    position: null,
    side: parentId ? 1 : 0,
  }
}
export function createMap(space: Space, title: string, ctx: Context): Space {
  assertName(space, title)
  const next = clone(space),
    id = ctx.id(),
    rootId = ctx.id()
  const map: MindMap = {
    schemaVersion: 1,
    id,
    title: title.trim(),
    rootId,
    nodes: { [rootId]: makeNode(rootId, null, title.trim()) },
    deletedAt: null,
    updatedAt: ctx.now,
    revision: 0,
    history: [],
    historyDirtySince: ctx.now,
  }
  next.maps[id] = map
  next.tabs[id] = { mapId: id, order: Object.keys(next.tabs).length, pinned: false, open: true }
  validateSpace(next)
  return next
}
export function initialSpace(ctx: Context) {
  let space = createMap(emptySpace(), '我的第一个脑图', ctx)
  const map = Object.values(space.maps)[0]
  for (const [i, text] of ['想要探索的事', '下一步行动', '灵感与收集', '值得记住的事'].entries()) {
    const id = ctx.id()
    map.nodes[id] = { ...makeNode(id, map.rootId, text, i), side: i < 2 ? 1 : -1 }
  }
  space = clone(space)
  return space
}
