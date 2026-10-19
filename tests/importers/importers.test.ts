import { describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { parseOutline } from '../../src/importers/outline'
import { extractContent, parseXmindContent } from '../../src/importers/xmind'
import {
  copyBranches,
  exportBackup,
  importBackup,
  importDrafts,
  parseBackup,
} from '../../src/importers/backup'
import { children, makeNode } from '../../src/domain/model'
import { clone } from '../../src/domain/types'
import { ctx, first, seed } from '../helpers'
const xml = `<xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0"><sheet><topic id="a"><title>第一张</title><children><topics type="attached"><topic id="b"><title>子主题</title><markers><marker-ref marker-id="task-half"/><marker-ref marker-id="flag-blue"/><marker-ref marker-id="unknown"/></markers></topic></topics></children></topic></sheet><sheet><topic id="c"><title>第二张</title></topic></sheet></xmap-content>`
describe('导入与备份原子边界', () => {
  it('Markdown 跳级、混合列表和多个顶层有稳定层级', () => {
    const result = parseOutline('# 计划\n### 跳级\n- 行动\n  - 子行动\n# 另一个主题')
    expect(result.drafts).toHaveLength(1)
    expect(result.drafts[0].nodes[0].text).toBe('导入的脑图')
    const nodes = result.drafts[0].nodes,
      child = nodes.find((n) => n.text === '子行动')!,
      parent = nodes.find((n) => n.text === '行动')!
    expect(child.parentId).toBe(parent.id)
  })
  it('空大纲不建图，超限和过深失败，无副作用', () => {
    const source = seed(),
      before = clone(source)
    expect(importDrafts(source, parseOutline(' \n\t'), ctx())).toEqual(before)
    expect(() => parseOutline(Array(5002).fill('- 节点').join('\n'))).toThrow('5000')
    expect(() => parseOutline(' '.repeat(260) + '- 深层')).toThrow('128')
    expect(source).toEqual(before)
  })
  it('XMind 多图、CRC、标记与未知项提示', () => {
    const bytes = zipSync({ 'content.xml': strToU8(xml), 'attachments/unused': new Uint8Array(50) })
    const result = parseXmindContent(extractContent(bytes))
    expect(result.drafts).toHaveLength(2)
    expect(result.drafts[0].nodes[1].markers).toEqual({ progress: '4/8', flag: 'blue' })
    expect(result.warnings.join()).toContain('unknown')
    const imported = importDrafts(seed(), result, ctx())
    expect(Object.keys(imported.maps)).toHaveLength(3)
    expect(Object.values(imported.tabs).filter((t) => t.open)).toHaveLength(3)
  })
  it.each([true, false])('插入多个分支保留目标折叠状态 %s、既有子树和源分支折叠', (collapsed) => {
    const source = seed(),
      map = first(source)
    map.nodes.a = {
      ...makeNode('a', map.rootId, '分支甲', 0),
      collapsed: true,
      markers: { flag: 'blue' },
    }
    map.nodes.child = makeNode('child', 'a', '子主题')
    map.nodes.b = makeNode('b', map.rootId, '分支乙', 1)
    map.nodes.target = { ...makeNode('target', map.rootId, '目标', 2), collapsed }
    map.nodes.existing = makeNode('existing', 'target', '原有子主题')
    const before = clone(source),
      result = { drafts: copyBranches(map, ['a', 'b']), warnings: [] },
      next = importDrafts(source, result, ctx(), { mapId: map.id, nodeId: 'target' }),
      targetMap = first(next)
    expect(targetMap.nodes.target).toEqual(before.maps[map.id].nodes.target)
    expect(children(targetMap, 'target').map((node) => node.text)).toEqual([
      '原有子主题',
      '分支甲',
      '分支乙',
    ])
    const pasted = children(targetMap, 'target')[1]
    expect(pasted.collapsed).toBe(true)
    expect(pasted.markers).toEqual({ flag: 'blue' })
    expect(children(targetMap, pasted.id).map((node) => node.text)).toEqual(['子主题'])
    expect(source).toEqual(before)
  })
  it('拒绝损坏 ZIP、CRC、重复内容、新版格式与 XML 实体', () => {
    expect(() => extractContent(new Uint8Array(50))).toThrow('损坏')
    const bytes = zipSync({ 'content.xml': strToU8(xml) }, { level: 0 })
    bytes[50] ^= 1
    expect(() => extractContent(bytes)).toThrow()
    expect(() => extractContent(zipSync({ 'content.json': strToU8('{}') }))).toThrow('新版')
    expect(() => parseXmindContent('<!DOCTYPE a [<!ENTITY x "hello">]>' + xml)).toThrow('实体')
    expect(() => parseXmindContent('<xmap-content><sheet><topic></sheet>')).toThrow('损坏')
    expect(() => parseXmindContent(xml.replace('id="b"', 'id="a"'))).toThrow('重复')
  })
  it('选中节点插入保留内容，损坏的第二张让整次失败', () => {
    const source = seed(),
      before = clone(source),
      map = first(source)
    const result = parseOutline('# 新分支\n- 新叶子')
    const next = importDrafts(source, result, ctx(), { mapId: map.id, nodeId: map.rootId })
    expect(Object.keys(next.maps)).toHaveLength(1)
    expect(Object.keys(first(next).nodes)).toHaveLength(3)
    expect(first(next).title).toBe(map.title)
    const drafts = parseXmindContent(xml)
    drafts.drafts[1].nodes[0].parentId = 'missing'
    expect(() => importDrafts(source, drafts, ctx())).toThrow()
    expect(source).toEqual(before)
  })
  it('备份往返只建新副本，保留标签相对顺序与固定状态，排除历史和回收站', () => {
    let source = seed(),
      map = first(source)
    source.tabs[map.id].pinned = true
    source = importDrafts(source, parseOutline('# 第二张\n- 内容'), ctx())
    const backup = parseBackup(JSON.stringify(exportBackup(source, 9000)))
    expect(backup.maps[0]).not.toHaveProperty('history')
    const restored = importBackup(source, backup, ctx())
    expect(Object.keys(restored.maps)).toHaveLength(4)
    expect(Object.values(restored.maps).map((m) => m.title)).toContain('测试脑图 (2)')
    const tabs = Object.values(restored.tabs).sort((a, b) => a.order - b.order)
    expect(tabs[2].pinned).toBe(true)
    expect(restored.maps[tabs[2].mapId].nodes[restored.maps[tabs[2].mapId].rootId].text).toBe(
      '测试脑图 (2)',
    )
    expect(new Set(Object.values(restored.maps).flatMap((m) => Object.keys(m.nodes))).size).toBe(6)
  })
  it('恶意 JSON、未知版本和悬空标签均拒绝', () => {
    expect(() => parseBackup('{')).toThrow('损坏')
    expect(() => parseBackup('{"format":"mindme","schemaVersion":999}')).toThrow('不支持')
    const backup = exportBackup(seed(), 1000)
    backup.tabs[0].mapId = 'missing'
    expect(() => parseBackup(JSON.stringify(backup))).toThrow('标签')
    const bad = exportBackup(seed(), 1000)
    Object.values(bad.maps[0].nodes)[0].markers.flag = 'invalid'
    expect(() => parseBackup(JSON.stringify(bad))).toThrow('标记')
  })
})
