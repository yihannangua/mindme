import { describe, expect, it } from 'vitest'
import { execute } from '../../src/domain/commands'
import { children, makeNode, validateMap } from '../../src/domain/model'
import { applyChanges, diffSpace, guardedChanges, undoEntry } from '../../src/domain/operations'
import { clone } from '../../src/domain/types'
import {
  copyBranches,
  exportBackup,
  importBackup,
  importDrafts,
  parseBackup,
} from '../../src/importers/backup'
import { mergeOperation, newServerState } from '../../src/sync/protocol'
import { ctx, first, operation, seed } from '../helpers'

describe('节点样式', () => {
  it('批量样式参与同步、撤销和 JSON/分支复制，旧数据无需迁移', () => {
    const before = seed(),
      map = first(before)
    map.nodes.a = makeNode('a', map.rootId, '甲', 0)
    map.nodes.b = makeNode('b', map.rootId, '乙', 1)
    const next = execute(
      before,
      map.id,
      {
        type: 'style-many',
        nodeIds: ['a', 'b'],
        style: { fontFamily: 'serif', fontSize: 26, backgroundColor: '#273b48' },
      },
      ctx(),
    ).space
    expect(next.maps[map.id].nodes.a).toMatchObject({
      fontFamily: 'serif',
      fontSize: 26,
      backgroundColor: '#273b48',
    })
    expect(next.maps[map.id].nodes.b).toMatchObject({
      fontFamily: 'serif',
      fontSize: 26,
      backgroundColor: '#273b48',
    })
    const changes = diffSpace(before, next)
    expect(changes.filter((c) => c.field === 'fontSize')).toHaveLength(2)
    const undone = applyChanges(next, guardedChanges(next, undoEntry(changes).inverse), 3000)
    expect(undone.maps[map.id].nodes.a.fontSize).toBeNull()
    const server = newServerState()
    server.space = clone(before)
    const merged = mergeOperation(server, operation(before, next, 'a', 1000), 1000)
    expect(merged.result.status).toBe('accepted')
    expect(merged.state.space.maps[map.id].nodes.a.fontSize).toBe(26)
    const backup = parseBackup(JSON.stringify(exportBackup(next, 4000)))
    const imported = importBackup(seed(), backup, ctx())
    expect(
      Object.values(imported.maps)
        .flatMap((m) => Object.values(m.nodes))
        .some((n) => n.fontSize === 26 && n.backgroundColor === '#273b48'),
    ).toBe(true)
    const copied = importDrafts(
      before,
      { drafts: copyBranches(next.maps[map.id], ['a']), warnings: [] },
      ctx(),
      { mapId: map.id, nodeId: map.rootId },
    )
    expect(
      children(first(copied), map.rootId).some(
        (n) => n.fontSize === 26 && n.fontFamily === 'serif',
      ),
    ).toBe(true)
    validateMap(map)
  })

  it('拒绝非法字体、字号和颜色，保留原数据', () => {
    const space = seed(),
      map = first(space)
    expect(() =>
      execute(
        space,
        map.id,
        { type: 'style-many', nodeIds: [map.rootId], style: { fontSize: 49 } },
        ctx(),
      ),
    ).toThrow('字号')
    expect(() =>
      execute(
        space,
        map.id,
        { type: 'style-many', nodeIds: [map.rootId], style: { backgroundColor: 'url(test)' } },
        ctx(),
      ),
    ).toThrow('背景色')
    expect(map.nodes[map.rootId].fontSize).toBeUndefined()
  })
})
