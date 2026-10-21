import { describe, expect, it } from 'vitest'
import { execute, maintenance, saveVersion } from '../../src/domain/commands'
import {
  children,
  createMap,
  nameKey,
  subtree,
  uniqueName,
  validateMap,
} from '../../src/domain/model'
import { applyChanges, diffSpace, guardedChanges, undoEntry } from '../../src/domain/operations'
import { clone, MARKERS } from '../../src/domain/types'
import { ctx, edit, first, seed } from '../helpers'

describe('领域命令与不变量', () => {
  it('新增子主题、同级和父主题只改变目标树，失败不污染原对象', () => {
    const source = seed(),
      root = first(source).rootId
    let space = edit(source, { type: 'add', nodeId: root, kind: 'child', text: '甲' })
    const a = children(first(space), root)[0]
    space = edit(space, { type: 'add', nodeId: a.id, kind: 'sibling', text: '乙' })
    space = edit(space, { type: 'add', nodeId: a.id, kind: 'parent', text: '包裹' })
    const map = first(space),
      parent = Object.values(map.nodes).find((n) => n.text === '包裹')!
    expect(map.nodes[a.id].parentId).toBe(parent.id)
    expect(children(map, root).map((n) => n.text)).toEqual(['包裹', '乙'])
    expect(Object.keys(first(source).nodes)).toHaveLength(1)
    expect(() => edit(source, { type: 'add', nodeId: root, kind: 'parent' })).toThrow('中心主题')
  })
  it('删除完整子树并保护中心主题', () => {
    let space = seed(),
      root = first(space).rootId
    space = edit(space, { type: 'add', nodeId: root, kind: 'child' })
    const branch = children(first(space), root)[0].id
    space = edit(space, { type: 'add', nodeId: branch, kind: 'child' })
    expect(subtree(first(space), branch)).toHaveLength(2)
    expect(Object.keys(first(edit(space, { type: 'delete', nodeId: branch })).nodes)).toHaveLength(
      1,
    )
    expect(() => edit(space, { type: 'delete', nodeId: root })).toThrow('中心主题')
  })
  it('拒绝自身、后代、孤儿、循环和跨图引用', () => {
    let space = seed(),
      root = first(space).rootId
    space = edit(space, { type: 'add', nodeId: root, kind: 'child' })
    const a = children(first(space), root)[0].id
    space = edit(space, { type: 'add', nodeId: a, kind: 'child' })
    const b = children(first(space), a)[0].id
    expect(() => edit(space, { type: 'reparent', nodeId: a, parentId: b })).toThrow('后代')
    expect(() => edit(space, { type: 'reparent', nodeId: a, parentId: a })).toThrow('自身')
    expect(() =>
      edit(space, { type: 'reparent', nodeId: a, parentId: 'another-map-node' }),
    ).toThrow()
    const invalid = clone(first(space))
    invalid.nodes[a].parentId = b
    expect(() => validateMap(invalid)).toThrow('循环')
  })
  it('名称包含回收站占用，根文字双向联动并规范化 NFC', () => {
    const source = seed(),
      map = first(source)
    const renamed = edit(source, { type: 'text', nodeId: map.rootId, text: '新名称' })
    expect(first(renamed).title).toBe('新名称')
    const trash = edit(source, { type: 'trash' })
    expect(uniqueName(trash, map.title)).toBe('测试脑图 (2)')
    expect(() => createMap(trash, map.title, ctx())).toThrow('名称已')
    expect(nameKey(' e\u0301 ')).toBe(nameKey('é'))
    expect(() => edit(source, { type: 'text', nodeId: map.rootId, text: '   ' })).toThrow(
      '不能为空',
    )
  })
  it('标记同类替换、异类并存、再次移除', () => {
    let space = seed(),
      nodeId = first(space).rootId
    space = edit(space, { type: 'marker', nodeId, category: 'priority', value: '①' })
    space = edit(space, { type: 'marker', nodeId, category: 'priority', value: '②' })
    space = edit(space, { type: 'marker', nodeId, category: 'flag', value: 'blue' })
    expect(first(space).nodes[nodeId].markers).toEqual({ priority: '②', flag: 'blue' })
    space = edit(space, { type: 'marker', nodeId, category: 'flag', value: 'blue' })
    expect(first(space).nodes[nodeId].markers).toEqual({ priority: '②' })
    for (const value of MARKERS.progress)
      expect(() =>
        edit(space, { type: 'marker', nodeId, category: 'progress', value }),
      ).not.toThrow()
  })
  it('批量标记混合状态统一设置、同类替换、异类保留且仅修改所选节点', () => {
    let space = seed()
    const root = first(space).rootId
    space = edit(space, { type: 'add', nodeId: root, kind: 'child', text: '子节点' })
    const child = children(first(space), root)[0].id
    space = edit(space, { type: 'add', nodeId: child, kind: 'child', text: '未选后代' })
    const descendant = children(first(space), child)[0].id
    for (const category of ['priority', 'progress', 'flag'] as const) {
      const [value, other] = MARKERS[category]
      space = edit(space, { type: 'marker', nodeId: root, category, value })
      space = edit(space, { type: 'marker', nodeId: child, category, value: other })
      const before = clone(space)
      space = edit(space, { type: 'marker-many', nodeIds: [root, child, root], category, value })
      expect(first(space).nodes[root].markers[category]).toBe(value)
      expect(first(space).nodes[child].markers[category]).toBe(value)
      expect(first(space).nodes[descendant]).toEqual(first(before).nodes[descendant])
      expect(first(before).nodes[child].markers[category]).toBe(other)
      const undo = guardedChanges(space, undoEntry(diffSpace(before, space)).inverse)
      expect(first(applyChanges(space, undo, 3000)).nodes).toEqual(first(before).nodes)
    }
    expect(first(space).nodes[root].markers).toEqual({
      priority: '①',
      progress: 'start',
      flag: 'red',
    })
    space = edit(space, {
      type: 'marker-many',
      nodeIds: [root, child],
      category: 'flag',
      value: 'red',
    })
    expect(first(space).nodes[root].markers).toEqual({ priority: '①', progress: 'start' })
    expect(first(space).nodes[child].markers).toEqual({ priority: '①', progress: 'start' })
  })
  it('批量标记拒绝空选择、失效节点和非法标记，失败不污染原对象', () => {
    const space = seed(),
      root = first(space).rootId,
      before = clone(space)
    for (const nodeIds of [[], [root, 'missing']])
      expect(() =>
        edit(space, { type: 'marker-many', nodeIds, category: 'flag', value: 'blue' }),
      ).toThrow()
    expect(() =>
      edit(space, { type: 'marker-many', nodeIds: [root], category: 'flag', value: 'invalid' }),
    ).toThrow('标记不合法')
    expect(space).toEqual(before)
  })
  it('同级排序跨侧交换而不改变父子关系，边界不循环', () => {
    let space = seed(),
      root = first(space).rootId
    for (const text of ['a', 'b', 'c', 'd'])
      space = edit(space, { type: 'add', nodeId: root, kind: 'child', text })
    const a = children(first(space), root)[1],
      b = children(first(space), root)[2]
    const next = first(edit(space, { type: 'sort', nodeId: a.id, delta: 1 }))
    expect(children(next, root).map((n) => n.text)).toEqual(['a', 'c', 'b', 'd'])
    expect(next.nodes[a.id].parentId).toBe(root)
    expect(next.nodes[a.id].side).toBe(b.side)
    const top = children(next, root)[0]
    expect(
      children(
        first(
          edit(
            { ...space, maps: { [next.id]: next } },
            { type: 'sort', nodeId: top.id, delta: -1 },
          ),
        ),
        root,
      )[0].id,
    ).toBe(top.id)
  })
  it('逐级展开保留后代折叠状态，递归混合状态先全部展开', () => {
    let space = seed(),
      root = first(space).rootId
    space = edit(space, { type: 'add', nodeId: root, kind: 'child' })
    const a = children(first(space), root)[0].id
    space = edit(space, { type: 'add', nodeId: a, kind: 'child' })
    space = edit(space, { type: 'fold', nodeId: root, recursive: true })
    expect(first(space).nodes[a].collapsed).toBe(true)
    space = edit(space, { type: 'fold', nodeId: root })
    expect(first(space).nodes[a].collapsed).toBe(true)
    space = edit(space, { type: 'fold', nodeId: root, recursive: true })
    expect(first(space).nodes[a].collapsed).toBe(false)
  })
  it('撤销只回退本机字段，保留远端标记和位置', () => {
    let source = seed(),
      root = first(source).rootId
    source = edit(source, { type: 'add', nodeId: root, kind: 'child' })
    const nodeId = children(first(source), root)[0].id
    const local = edit(source, { type: 'text', nodeId, text: '本机文字' }),
      entry = undoEntry(diffSpace(source, local))
    const remote = edit(local, { type: 'marker', nodeId, category: 'flag', value: 'red' })
    const undone = applyChanges(remote, guardedChanges(remote, entry.inverse), 3000)
    expect(first(undone).nodes[nodeId].text).toBe('新主题')
    expect(first(undone).nodes[nodeId].markers.flag).toBe('red')
    const changed = edit(remote, { type: 'text', nodeId, text: '远端文字' })
    expect(guardedChanges(changed, entry.inverse).some((c) => c.field === 'text')).toBe(false)
  })
})

describe('历史和回收站', () => {
  it('五分钟窗口与短会话补存，最多十个版本', () => {
    let space = seed()
    expect(first(maintenance(space, ctx(300999))).history).toHaveLength(0)
    space = maintenance(space, ctx(301000))
    expect(first(space).history).toHaveLength(1)
    space = edit(space, { type: 'text', nodeId: first(space).rootId, text: '修改' }, 302000)
    space = maintenance(space, ctx(302001), true)
    expect(first(space).history).toHaveLength(2)
    for (let i = 0; i < 15; i++) saveVersion(first(space), ctx(400000 + i), 'window', true)
    expect(first(space).history).toHaveLength(10)
  })
  it('版本满额时恢复先锁定目标，再存当前内容', () => {
    let space = seed()
    const map = first(space)
    saveVersion(map, ctx(1000), 'window', true)
    const target = map.history[0].id
    for (let i = 0; i < 9; i++) saveVersion(map, ctx(2000 + i), 'window', true)
    space = edit(space, { type: 'text', nodeId: map.rootId, text: '恢复前内容' })
    space = execute(space, map.id, { type: 'restore', versionId: target }, ctx(9000)).space
    expect(first(space).title).toBe('测试脑图')
    expect(first(space).history.at(-1)?.content.title).toBe('恢复前内容')
    expect(first(space).history).toHaveLength(10)
  })
  it('回收站保留三十天，提前恢复、到期清理和名称释放', () => {
    let space = edit(seed(), { type: 'trash' }, 2000),
      id = first(space).id
    expect(first(maintenance(space, ctx(2000 + 30 * 86400000 - 1))).deletedAt).toBe(2000)
    expect(execute(space, id, { type: 'untrash' }, ctx(3000)).space.maps[id].deletedAt).toBeNull()
    space = maintenance(space, ctx(2000 + 30 * 86400000))
    expect(space.maps[id]).toBeUndefined()
    expect(space.tabs[id]).toBeUndefined()
    expect(() => createMap(space, '测试脑图', ctx())).not.toThrow()
  })
})
