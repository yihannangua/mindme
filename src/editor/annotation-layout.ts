export interface AnnotationBox {
  x: number
  y: number
  width: number
  height: number
}

export interface LinkGeometry {
  d: string
  labelX: number
  labelY: number
  start: { x: number; y: number }
  end: { x: number; y: number }
  control1: { x: number; y: number }
  control2: { x: number; y: number }
  fromSide: AnnotationSide
  toSide: AnnotationSide
}

export interface SummaryGeometry {
  x: number
  y: number
  width: number
  height: number
  side: -1 | 1
  top: number
  bottom: number
  bracketPath: string
  compactBracketPath: string
  bracketX: number
  summaryLeft: number
  anchorYs: number[]
}

export type AnnotationSide = -1 | 1

const outsideSide = (box: AnnotationBox, toward: AnnotationBox): AnnotationSide =>
  toward.x >= box.x ? 1 : -1

const horizontalEndpoint = (box: AnnotationBox, side: AnnotationSide) => ({
  x: box.x + side * (box.width / 2 + 4),
  y: box.y,
})

const cubicPoint = (
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  p3: { x: number; y: number },
  t: number,
) => {
  const mt = 1 - t
  return {
    x: mt ** 3 * p0.x + 3 * mt ** 2 * t * p1.x + 3 * mt * t ** 2 * p2.x + t ** 3 * p3.x,
    y: mt ** 3 * p0.y + 3 * mt ** 2 * t * p1.y + 3 * mt * t ** 2 * p2.y + t ** 3 * p3.y,
  }
}

/** 任意两个节点的曲线都从左/右侧外缘起止，标签落在曲线中点。 */
export function linkGeometry(
  from: AnnotationBox,
  to: AnnotationBox,
  fromSide: AnnotationSide = outsideSide(from, to),
  toSide: AnnotationSide = outsideSide(to, from),
): LinkGeometry {
  const start = horizontalEndpoint(from, fromSide),
    end = horizontalEndpoint(to, toSide),
    dx = end.x - start.x,
    dy = end.y - start.y,
    length = Math.hypot(dx, dy),
    bend = Math.min(300, Math.max(110, length * 0.5)),
    bow = Math.min(60, Math.max(20, bend * 0.22)),
    c1 = {
      x: start.x + fromSide * bend,
      y: start.y + dy * 0.15 - bow,
    },
    c2 = {
      x: end.x + toSide * bend,
      y: end.y - dy * 0.15 + bow,
    },
    label = cubicPoint(start, c1, c2, end, 0.5)
  return {
    d: `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`,
    labelX: label.x,
    labelY: label.y,
    start,
    end,
    control1: c1,
    control2: c2,
    fromSide,
    toSide,
  }
}

/**
 * 概括节点放在锚点外侧（左侧锚点向左，右侧锚点向右），
 * 括号上下边缘越过所有锚点的包围盒，避免与节点重叠。
 */
export function summaryGeometry(
  anchors: AnnotationBox[],
  width: number,
  height: number,
  side: AnnotationSide = 1,
  extent: AnnotationBox[] = anchors,
): SummaryGeometry {
  const padding = 12,
    left = Math.min(...extent.map((anchor) => anchor.x - anchor.width / 2)),
    right = Math.max(...extent.map((anchor) => anchor.x + anchor.width / 2)),
    top = Math.min(...extent.map((anchor) => anchor.y - anchor.height / 2)) - padding,
    bottom = Math.max(...extent.map((anchor) => anchor.y + anchor.height / 2)) + padding,
    centerY = (top + bottom) / 2,
    cap = Math.min(16, Math.max(8, (bottom - top) / 6)),
    bracketX = side === 1 ? right + 34 : left - 34,
    summaryEdge = side === 1 ? bracketX + 42 : bracketX - 42,
    x = side === 1 ? summaryEdge + width / 2 : summaryEdge - width / 2,
    capStartX = bracketX - side * cap,
    capEndX = bracketX + side * cap
  return {
    x,
    y: centerY,
    width,
    height,
    side,
    top,
    bottom,
    bracketPath: [
      `M ${capStartX} ${top}`,
      `C ${bracketX - side * cap * 0.45} ${top}, ${bracketX} ${top + cap * 0.35}, ${bracketX} ${top + cap}`,
      `V ${centerY - cap}`,
      `C ${bracketX} ${centerY - cap * 0.55}, ${capEndX} ${centerY - cap * 0.35}, ${capEndX} ${centerY}`,
      `C ${capEndX} ${centerY + cap * 0.35}, ${bracketX} ${centerY + cap * 0.55}, ${bracketX} ${centerY + cap}`,
      `V ${bottom - cap}`,
      `C ${bracketX} ${bottom - cap * 0.35}, ${bracketX - side * cap * 0.45} ${bottom}, ${capStartX} ${bottom}`,
      `M ${capEndX} ${centerY} H ${summaryEdge}`,
    ].join(' '),
    compactBracketPath: [
      `M ${capStartX} ${top}`,
      `H ${bracketX}`,
      `V ${bottom}`,
      `H ${capStartX}`,
      `M ${bracketX} ${centerY} H ${summaryEdge}`,
    ].join(' '),
    bracketX,
    summaryLeft: summaryEdge,
    anchorYs: anchors.map((anchor) => anchor.y),
  }
}
