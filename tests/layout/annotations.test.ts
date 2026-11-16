import { describe, expect, it } from 'vitest'
import { linkGeometry, summaryGeometry } from '../../src/editor/annotation-layout'

describe('连线与概括几何', () => {
  it('连线端点落在节点外侧边缘，标签位于曲线中点', () => {
    const geometry = linkGeometry(
      { x: 0, y: 0, width: 100, height: 40 },
      { x: 300, y: 80, width: 120, height: 40 },
    )
    expect(geometry.d).toContain('C')
    expect(geometry.fromSide).toBe(1)
    expect(geometry.toSide).toBe(-1)
    expect(geometry.start.x).toBeCloseTo(54)
    expect(geometry.start.y).toBeCloseTo(0)
    expect(geometry.end.x).toBeCloseTo(236)
    expect(geometry.end.y).toBeCloseTo(80)
    expect(geometry.labelX).toBeGreaterThan(54)
    expect(geometry.labelX).toBeLessThan(236)
    expect(geometry.labelY).toBeGreaterThan(0)
    expect(geometry.labelY).toBeLessThan(80)
  })

  it('连线使用更宽的外侧控制点和舒展弧度', () => {
    const geometry = linkGeometry(
      { x: 0, y: 0, width: 100, height: 40 },
      { x: 300, y: 80, width: 120, height: 40 },
    )
    expect(Math.abs(geometry.control1.x - geometry.start.x)).toBeGreaterThan(90)
    expect(Math.abs(geometry.control2.x - geometry.end.x)).toBeGreaterThan(90)
    expect(geometry.control1.y).toBeLessThan(geometry.start.y)
    expect(geometry.control2.y).toBeGreaterThan(geometry.end.y)
  })

  it('同一侧节点都从各自外侧边缘连线', () => {
    const from = { x: 0, y: 0, width: 100, height: 40 },
      to = { x: 300, y: 80, width: 120, height: 40 }
    const right = linkGeometry(from, to, 1, 1)
    expect(right.start.x).toBeCloseTo(54)
    expect(right.end.x).toBeCloseTo(364)
    const left = linkGeometry(from, to, -1, -1)
    expect(left.start.x).toBeCloseTo(-54)
    expect(left.end.x).toBeCloseTo(236)
  })

  it('概括节点放在右侧，括号上下超出锚点包围盒', () => {
    const geometry = summaryGeometry(
      [
        { x: 100, y: -60, width: 100, height: 40 },
        { x: 100, y: 60, width: 100, height: 40 },
      ],
      80,
      30,
    )
    expect(geometry.side).toBe(1)
    expect(geometry.x).toBeGreaterThan(150)
    expect(geometry.bracketX).toBeGreaterThan(150)
    expect(geometry.summaryLeft).toBeGreaterThan(geometry.bracketX)
    expect(geometry.top).toBe(-92)
    expect(geometry.bottom).toBe(92)
    expect(geometry.anchorYs).toEqual([-60, 60])
    expect(geometry.bracketPath).toContain('V')
    expect(geometry.bracketPath.split('M').length - 1).toBe(2)
    expect(geometry.bracketPath.split('H').length - 1).toBe(1)
    expect(geometry.bracketPath.split('C').length - 1).toBe(4)
    expect(geometry.y).toBe(0)
  })

  it('概括节点放在左侧，括号和连接线朝左', () => {
    const geometry = summaryGeometry(
      [
        { x: 100, y: -60, width: 100, height: 40 },
        { x: 100, y: 60, width: 100, height: 40 },
      ],
      80,
      30,
      -1,
    )
    expect(geometry.side).toBe(-1)
    expect(geometry.bracketX).toBeLessThan(50)
    expect(geometry.summaryLeft).toBeLessThan(geometry.bracketX)
    expect(geometry.x).toBeLessThan(geometry.summaryLeft)
    expect(geometry.top).toBe(-92)
    expect(geometry.bottom).toBe(92)
    expect(geometry.bracketPath).toContain('V')
    expect(geometry.bracketPath.split('M').length - 1).toBe(2)
    expect(geometry.bracketPath.split('H').length - 1).toBe(1)
  })

  it('括号上下边缘超过单个锚点的高度，避免与节点重叠', () => {
    const geometry = summaryGeometry([{ x: 0, y: 20, width: 90, height: 36 }], 70, 30)
    expect(geometry.y).toBe(20)
    expect(geometry.top).toBe(-10)
    expect(geometry.bottom).toBe(50)
    expect(geometry.bottom - geometry.top).toBeGreaterThan(36)
    expect(geometry.anchorYs).toEqual([20])
    expect(geometry.bracketPath).toContain('H')
    expect(geometry.bracketPath.split('M').length - 1).toBe(2)
    expect(geometry.bracketPath.split('H').length - 1).toBe(1)
  })

  it('括号使用展开后代范围，而不是只看锚点', () => {
    const anchors = [
        { x: 100, y: -40, width: 100, height: 40 },
        { x: 100, y: 40, width: 100, height: 40 },
      ],
      extent = [
        ...anchors,
        { x: 260, y: -120, width: 120, height: 40 },
        { x: 260, y: 120, width: 80, height: 36 },
      ],
      geometry = summaryGeometry(anchors, 80, 30, 1, extent)
    expect(geometry.top).toBeLessThan(-140)
    expect(geometry.bottom).toBeGreaterThan(138)
    expect(geometry.bracketX).toBeGreaterThan(320)
    expect(geometry.summaryLeft).toBeGreaterThan(geometry.bracketX)
  })
})
