import { describe, expect, it } from 'vitest'
import { saveVersion } from '../../src/domain/commands'
import { migrateLegacySummaries } from '../../src/domain/annotations'
import { children } from '../../src/domain/model'
import { applyChanges, diffSpace } from '../../src/domain/operations'
import { clone } from '../../src/domain/types'
import { edit, first, seed } from '../helpers'

function withChildren(texts = ['甲', '乙', '丙', '丁']) {
  let space = seed()
  const rootId = first(space).rootId
  for (const text of texts)
    space = edit(space, { type: 'add', nodeId: rootId, kind: 'child', text })
  return { space, rootId, ids: children(first(space), rootId).map((node) => node.id) }
}

describe('连线与概括领域命令', () => {
  it('创建曲线连线、修改标签并作为字段差异同步', () => {
    let { space, rootId, ids } = withChildren()
    space = edit(space, { type: 'link-add', fromId: rootId, toId: ids[0], text: '依赖' })
    const link = first(space).links![0]
    expect(link).toMatchObject({ fromId: rootId, toId: ids[0], text: '依赖' })

    const before = clone(space)
    space = edit(space, {
      type: 'link-text',
      linkId: link.id,
      text: '新的关系',
    })
    expect(first(space).links![0].text).toBe('新的关系')
    const changes = diffSpace(before, space)
    expect(changes.some((change) => change.field === 'links')).toBe(true)
    expect(applyChanges(before, changes, 3000).maps[first(space).id].links).toEqual(
      first(space).links,
    )

    space = edit(space, { type: 'link-delete', linkId: link.id })
    expect(first(space).links).toEqual([])
  })

  it('拒绝自连、重复连线和未知节点', () => {
    let { space, rootId, ids } = withChildren()
    expect(() => edit(space, { type: 'link-add', fromId: rootId, toId: rootId })).toThrow('不同')
    expect(() => edit(space, { type: 'link-add', fromId: rootId, toId: 'missing-node' })).toThrow(
      '不同',
    )
    space = edit(space, { type: 'link-add', fromId: rootId, toId: ids[0] })
    expect(() => edit(space, { type: 'link-add', fromId: ids[0], toId: rootId })).toThrow(
      '已有连线',
    )
  })

  it('为连续子节点创建概括节点、修改文字并删除', () => {
    let { space, ids } = withChildren()
    space = edit(space, { type: 'summary-add', nodeIds: [ids[1], ids[0]] })
    const summary = Object.values(first(space).nodes).find((node) => node.summaryOf)!
    expect(summary.summaryOf).toEqual([ids[0], ids[1]])
    expect(summary.parentId).toBeNull()
    expect(summary.text).toBe('概要')

    space = edit(space, {
      type: 'summary-text',
      summaryId: summary.id,
      text: '这两项',
    })
    expect(first(space).nodes[summary.id].text).toBe('这两项')
    space = edit(space, { type: 'add', nodeId: summary.id, kind: 'child', text: '概括子节点' })
    expect(children(first(space), summary.id).map((node) => node.text)).toEqual(['概括子节点'])
    space = edit(space, { type: 'summary-delete', summaryId: summary.id })
    expect(first(space).nodes[summary.id]).toBeUndefined()
  })

  it('拒绝跨父节点、非连续和重复的概括', () => {
    let { space, rootId, ids } = withChildren()
    expect(() => edit(space, { type: 'summary-add', nodeIds: [ids[0], ids[2]] })).toThrow('连续')
    space = edit(space, { type: 'add', nodeId: ids[0], kind: 'child', text: '后代' })
    const descendant = children(first(space), ids[0])[0].id
    expect(() => edit(space, { type: 'summary-add', nodeIds: [ids[0], descendant] })).toThrow(
      '连续',
    )
    space = edit(space, { type: 'summary-add', nodeIds: [ids[0], ids[1]] })
    expect(() => edit(space, { type: 'summary-add', nodeIds: [ids[0], ids[1]] })).toThrow(
      '已有概括',
    )
    expect(() => edit(space, { type: 'summary-add', nodeIds: [rootId, ids[0]] })).toThrow()
  })

  it('删除节点后清理失效的概括节点和其子分支', () => {
    let { space, rootId, ids } = withChildren()
    space = edit(space, { type: 'link-add', fromId: rootId, toId: ids[0] })
    space = edit(space, { type: 'summary-add', nodeIds: [ids[0], ids[1]] })
    const summary = Object.values(first(space).nodes).find((node) => node.summaryOf)!
    space = edit(space, { type: 'add', nodeId: summary.id, kind: 'child', text: '概括子节点' })
    space = edit(space, { type: 'delete', nodeId: ids[0] })
    expect(first(space).links).toEqual([])
    expect(first(space).nodes[summary.id]).toBeUndefined()
    expect(Object.values(first(space).nodes).some((node) => node.text === '概括子节点')).toBe(false)
  })

  it('将旧版概括标注迁移为可继续建子节点的普通节点', () => {
    let { space, ids } = withChildren()
    space = edit(space, { type: 'summary-add', nodeIds: [ids[0], ids[1]] })
    const summary = Object.values(first(space).nodes).find((node) => node.summaryOf)!
    const map = first(space)
    delete map.nodes[summary.id]
    map.summaries = [{ id: summary.id, nodeIds: summary.summaryOf!, text: summary.text }]

    const migrated = migrateLegacySummaries(space)
    expect(migrated.changed).toBe(true)
    const next = first(migrated.space)
    expect(next.summaries).toBeUndefined()
    expect(next.nodes[summary.id].summaryOf).toEqual(summary.summaryOf)
    const withChild = edit(migrated.space, {
      type: 'add',
      nodeId: summary.id,
      kind: 'child',
      text: '迁移后子节点',
    })
    expect(children(first(withChild), summary.id)).toHaveLength(1)
  })

  it('历史快照包含连线和概括，恢复后仍可读取', () => {
    let { space, rootId, ids } = withChildren()
    space = edit(space, { type: 'link-add', fromId: rootId, toId: ids[0] })
    space = edit(space, { type: 'summary-add', nodeIds: [ids[0], ids[1]] })
    const map = first(space)
    saveVersion(map, { now: 4000, id: () => 'version-links' }, 'window', true)
    const version = map.history.at(-1)!
    expect(version.content.links).toEqual(map.links)
    const summary = Object.values(map.nodes).find((node) => node.summaryOf)!
    expect(version.content.nodes[summary.id].summaryOf).toEqual(summary.summaryOf)
    const restored = edit(space, { type: 'restore', versionId: version.id })
    expect(first(restored).links).toEqual(map.links)
    expect(Object.values(first(restored).nodes).find((node) => node.summaryOf)?.summaryOf).toEqual(
      summary.summaryOf,
    )
  })
})
