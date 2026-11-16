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
}

export interface SummaryGeometry {
  x: number
  y: number
  width: number
  height: number
  bracketPath: string
  bracketX: number
  summaryLeft: number
  anchorYs: number[]
}

const borderPoint = (box: AnnotationBox, toward: AnnotationBox) => {
  const dx = toward.x - box.x,
    dy = toward.y - box.y
  if (!dx && !dy) return { x: box.x, y: box.y }
  const halfWidth = box.width / 2 + 4,
    halfHeight = box.height / 2 + 4,
    tx = dx === 0 ? Infinity : halfWidth / Math.abs(dx),
    ty = dy === 0 ? Infinity : halfHeight / Math.abs(dy),
    t = Math.min(tx, ty)
  return { x: box.x + dx * t, y: box.y + dy * t }
}

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

/** 任意两个节点的曲线在节点边界处起止，标签落在曲线中点。 */
export function linkGeometry(from: AnnotationBox, to: AnnotationBox): LinkGeometry {
  const start = borderPoint(from, to),
    end = borderPoint(to, from),
    dx = end.x - start.x,
    dy = end.y - start.y,
    length = Math.hypot(dx, dy),
    nx = length ? -dy / length : 0,
    ny = length ? dx / length : 0,
    bend = Math.min(120, Math.max(30, length * 0.18)),
    c1 = { x: start.x + dx * 0.35 + nx * bend, y: start.y + dy * 0.35 + ny * bend },
    c2 = { x: end.x - dx * 0.35 + nx * bend, y: end.y - dy * 0.35 + ny * bend },
    label = cubicPoint(start, c1, c2, end, 0.5)
  return {
    d: `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`,
    labelX: label.x,
    labelY: label.y,
    start,
    end,
  }
}

/**
 * 概括节点固定放在锚点最右侧，括号在锚点右缘之外，
 * 每个锚点有一小段横线，中心横线连到概括节点。
 */
export function summaryGeometry(
  anchors: AnnotationBox[],
  width: number,
  height: number,
): SummaryGeometry {
  const right = Math.max(...anchors.map((anchor) => anchor.x + anchor.width / 2)),
    top = Math.min(...anchors.map((anchor) => anchor.y)),
    bottom = Math.max(...anchors.map((anchor) => anchor.y)),
    centerY = (top + bottom) / 2,
    bracketX = right + 34,
    summaryLeft = bracketX + 42,
    x = summaryLeft + width / 2
  const stubs = anchors.map(
    (anchor) => `M ${anchor.x + anchor.width / 2} ${anchor.y} H ${bracketX}`,
  )
  return {
    x,
    y: centerY,
    width,
    height,
    bracketPath: [
      ...stubs,
      `M ${bracketX} ${top} V ${bottom}`,
      `M ${bracketX} ${centerY} H ${summaryLeft}`,
    ].join(' '),
    bracketX,
    summaryLeft,
    anchorYs: anchors.map((anchor) => anchor.y),
  }
}
