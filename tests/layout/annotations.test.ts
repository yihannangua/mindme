import { describe, expect, it } from 'vitest'
import { linkGeometry, summaryGeometry } from '../../src/editor/annotation-layout'

describe('连线与概括几何', () => {
  it('从节点边界起止并生成带中点的三次曲线', () => {
    const geometry = linkGeometry(
      { x: 0, y: 0, width: 100, height: 40 },
      { x: 300, y: 80, width: 120, height: 40 },
    )
    expect(geometry.d).toContain('C')
    expect(geometry.start.x).toBeCloseTo(54)
    expect(geometry.start.y).toBeCloseTo(14.4)
    expect(geometry.end.x).toBeLessThan(240)
    expect(geometry.labelX).toBeGreaterThan(54)
    expect(geometry.labelX).toBeLessThan(240)
    expect(geometry.labelY).toBeGreaterThan(14.4)
    expect(geometry.labelY).toBeLessThan(65.6)
  })

  it('把概括节点放在锚点最右侧并生成括号与每行连接线', () => {
    const geometry = summaryGeometry(
      [
        { x: 100, y: -60, width: 100, height: 40 },
        { x: 100, y: 60, width: 100, height: 40 },
      ],
      80,
      30,
    )
    expect(geometry.x).toBeGreaterThan(150)
    expect(geometry.bracketX).toBeGreaterThan(150)
    expect(geometry.summaryLeft).toBeGreaterThan(geometry.bracketX)
    expect(geometry.anchorYs).toEqual([-60, 60])
    expect(geometry.bracketPath).toContain('V')
    expect(geometry.bracketPath.split('M').length - 1).toBe(4)
    expect(geometry.y).toBe(0)
  })

  it('单个锚点也生成可读的括号与连接线', () => {
    const geometry = summaryGeometry([{ x: 0, y: 20, width: 90, height: 36 }], 70, 30)
    expect(geometry.y).toBe(20)
    expect(geometry.anchorYs).toEqual([20])
    expect(geometry.bracketPath).toContain('H')
  })
})
