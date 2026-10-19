import { describe, expect, it } from 'vitest'
import {
  defaultWorkspace,
  normalizeWorkspace,
  type WorkspaceState,
} from '../../src/persistence/workspace-state'

describe('分区工作区状态', () => {
  it('默认创建一个绑定当前脑图的叶子分区', () => {
    const state = defaultWorkspace('map-a')
    expect(state.root).toEqual({ type: 'pane', paneId: state.activePaneId })
    expect(state.panes[state.activePaneId].mapId).toBe('map-a')
  })
  it('清理不存在的脑图和孤立分区，保留递归布局与活动分区', () => {
    const state = defaultWorkspace('map-a'),
      second = 'pane-b'
    const value: WorkspaceState = {
      ...state,
      activePaneId: second,
      panes: {
        ...state.panes,
        [second]: {
          id: second,
          mapId: 'map-b',
          scopeNodeId: 'node-b',
          selection: { ids: [], activeId: null, anchorId: null },
        },
        orphan: {
          id: 'orphan',
          mapId: 'missing',
          scopeNodeId: null,
          selection: { ids: [], activeId: null, anchorId: null },
        },
      },
      root: {
        type: 'split',
        id: 'split-a',
        direction: 'row',
        ratio: 0.5,
        first: state.root,
        second: { type: 'pane', paneId: second },
      },
    }
    const normalized = normalizeWorkspace(value, new Set(['map-a']), 'map-a')
    expect(normalized.activePaneId).toBe(state.activePaneId)
    expect(Object.keys(normalized.panes)).toEqual([state.activePaneId])
    expect(normalized.root).toEqual(state.root)
  })
  it('无有效分区时回退到指定脑图', () => {
    const state = defaultWorkspace('missing'),
      normalized = normalizeWorkspace(state, new Set(['map-a']), 'map-a')
    expect(normalized.panes[normalized.activePaneId].mapId).toBe('map-a')
  })
})
