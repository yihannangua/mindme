import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from 'react'
import type { MarkerCategory } from '../domain/types'

export const flagColors: Record<string, string> = {
  red: '#e94b4b',
  orange: '#f0b429',
  blue: '#4a90e2',
  green: '#4caf50',
  purple: '#9b59b6',
  teal: '#3aa8a0',
  gray: '#6b7c8a',
}
const priorityColors = [
  '#e94b4b',
  '#f0b429',
  '#4a90e2',
  '#4caf50',
  '#7fb3ad',
  '#8fb8b2',
  '#9fc2bc',
  '#afcbc6',
  '#bfd5d0',
]
const legacyPriority: Record<string, string> = { '①': '1', '②': '2', '③': '3', '④': '4' }
const expressionGlyphs: Record<string, string> = {
  smile: '😊',
  grin: '😁',
  angry: '😡',
  cry: '😭',
  surprised: '😱',
  sleepy: '😴',
  neutral: '😑',
}
const arrowAngles: Record<string, number> = {
  up: 0,
  'up-right': 45,
  right: 90,
  'down-right': 135,
  down: 180,
  'down-left': 225,
  left: 270,
  'up-left': 315,
}
const symbolStyles: Record<string, { color: string; glyph: string }> = {
  plus: { color: '#45b97c', glyph: '+' },
  minus: { color: '#4a90e2', glyph: '−' },
  question: { color: '#4a90e2', glyph: '?' },
  info: { color: '#4a90e2', glyph: 'i' },
  exclamation: { color: '#f0a23a', glyph: '!' },
  cross: { color: '#e94b4b', glyph: '×' },
  check: { color: '#45b97c', glyph: '✓' },
  pause: { color: '#e94b4b', glyph: 'Ⅱ' },
  chart: { color: '#7f8c8d', glyph: '▥' },
  people: { color: '#4a90e2', glyph: '👥' },
  'thumb-down': { color: '#f0a23a', glyph: '👎' },
  quote: { color: '#45b97c', glyph: '❝' },
  tools: { color: '#45b97c', glyph: '🛠' },
  plane: { color: '#4a90e2', glyph: '✈' },
  heart: { color: '#e94b4b', glyph: '♥' },
  'thumb-up': { color: '#f0a23a', glyph: '👍' },
  'trend-up': { color: '#7f8c8d', glyph: '↗' },
  key: { color: '#f0c419', glyph: '🔑' },
  dollar: { color: '#f0c419', glyph: '$' },
  music: { color: '#e94b4b', glyph: '♪' },
  pencil: { color: '#45b97c', glyph: '✎' },
  pie: { color: '#7f8c8d', glyph: '◔' },
  cart: { color: '#f0a23a', glyph: '🛒' },
  phone: { color: '#4a90e2', glyph: '☎' },
  thermometer: { color: '#e94b4b', glyph: '🌡' },
  trophy: { color: '#f0c419', glyph: '🏆' },
}
const monthColors = [
  '#4a90e2',
  '#4a90e2',
  '#4caf50',
  '#4caf50',
  '#4caf50',
  '#f0b429',
  '#f0b429',
  '#f0b429',
  '#e94b4b',
  '#e94b4b',
  '#e94b4b',
  '#4a90e2',
]
const starPoints =
  '10,2.2 12.35,7.2 17.8,7.9 13.8,11.7 14.8,17.1 10,14.5 5.2,17.1 6.2,11.7 2.2,7.9 7.65,7.2'
const emojiFont = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif'

export function MarkerIcon({
  category,
  value,
  x = 0,
  y = 0,
  label,
  onActivate,
}: {
  category: MarkerCategory
  value: string
  x?: number
  y?: number
  label?: string
  onActivate?: (element: SVGSVGElement) => void
}) {
  const interactive = !!onActivate
  const activate = (event: ReactMouseEvent<SVGSVGElement> | ReactKeyboardEvent<SVGSVGElement>) => {
    event.preventDefault()
    event.stopPropagation()
    onActivate?.(event.currentTarget)
  }
  const frame = (children: ReactNode) => (
    <svg
      x={x}
      y={y}
      width="19"
      height="19"
      viewBox="0 0 20 20"
      className={interactive ? 'node-marker' : undefined}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={interactive ? label : undefined}
      aria-hidden={interactive ? undefined : true}
      onPointerDown={
        interactive
          ? (event: ReactPointerEvent<SVGSVGElement>) => event.stopPropagation()
          : undefined
      }
      onDoubleClick={
        interactive ? (event: ReactMouseEvent<SVGSVGElement>) => event.stopPropagation() : undefined
      }
      onClick={interactive ? activate : undefined}
      onKeyDown={
        interactive
          ? (event: ReactKeyboardEvent<SVGSVGElement>) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              activate(event)
            }
          : undefined
      }
    >
      {children}
    </svg>
  )

  if (category === 'priority') {
    const number = Math.min(9, Math.max(1, Number(legacyPriority[value] ?? value) || 1))
    return frame(
      <>
        <rect x="1.5" y="1.5" width="17" height="17" rx="3.6" fill={priorityColors[number - 1]} />
        <text x="10" y="14.6" textAnchor="middle" fill="#fff" fontSize="12" fontWeight="700">
          {number}
        </text>
      </>,
    )
  }
  if (category === 'expression') {
    return frame(
      <text x="10" y="15" textAnchor="middle" fontSize="15" fontFamily={emojiFont}>
        {expressionGlyphs[value] ?? expressionGlyphs.smile}
      </text>,
    )
  }
  if (category === 'flag') {
    const color = flagColors[value] ?? flagColors.gray
    return frame(
      <>
        <path d="M5 3V18" stroke={color} strokeWidth="1.7" />
        <path d="M6 3L18 7.5L6 12Z" fill={color} />
      </>,
    )
  }
  if (category === 'star')
    return frame(<polygon points={starPoints} fill={flagColors[value] ?? flagColors.gray} />)
  if (category === 'person') {
    const color = flagColors[value] ?? flagColors.gray
    return frame(
      <>
        <circle cx="10" cy="6.4" r="3.1" fill={color} />
        <path d="M4 17c0-3.4 2.7-5.6 6-5.6s6 2.2 6 5.6" fill={color} />
      </>,
    )
  }
  if (category === 'arrow') {
    if (value === 'rotate')
      return frame(
        <>
          <path
            d="M15.5 9A6 6 0 1 0 16 12"
            fill="none"
            stroke="#4a90e2"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <path
            d="M16 4.5V9.5H11"
            fill="none"
            stroke="#4a90e2"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>,
      )
    return frame(
      <g transform={`rotate(${arrowAngles[value] ?? 0} 10 10)`}>
        <path d="M10 2.5L15 9H11.5V17H8.5V9H5Z" fill="#4a90e2" />
      </g>,
    )
  }
  if (category === 'symbol') {
    const style = symbolStyles[value] ?? { color: '#6f8fa6', glyph: '?' }
    return frame(
      <>
        <rect x="1.5" y="1.5" width="17" height="17" rx="3.6" fill={style.color} />
        <text
          x="10"
          y="14.2"
          textAnchor="middle"
          fill="#fff"
          fontSize="11"
          fontWeight="700"
          fontFamily={emojiFont}
        >
          {style.glyph}
        </text>
      </>,
    )
  }
  if (category === 'month') {
    const index = Number(value) - 1
    const color = monthColors[index] ?? monthColors[0]
    return frame(
      <>
        <rect x="2" y="4" width="16" height="14" rx="2" fill="#fff" stroke="#d5dde3" />
        <path d="M4 4h12a2 2 0 0 1 2 2v2H2V6a2 2 0 0 1 2-2Z" fill={color} />
        <text
          x="10"
          y="15.2"
          textAnchor="middle"
          fontSize={value.length > 1 ? 8 : 10}
          fill="#4a5a64"
        >
          {value}
        </text>
      </>,
    )
  }

  const fraction = value === 'done' ? 1 : value === 'start' ? 0 : Number(value.split('/')[0]) / 8
  return frame(
    <>
      <circle cx="10" cy="10" r="7.5" fill="white" stroke="#4caf50" strokeWidth="1.5" />
      {value === 'start' && <path d="M8 6.6L13 10L8 13.4Z" fill="#4caf50" />}
      {fraction > 0 && fraction < 1 && (
        <path
          d={`M10 10 L10 2.5 A7.5 7.5 0 ${fraction > 0.5 ? 1 : 0} 1 ${10 + 7.5 * Math.sin(fraction * Math.PI * 2)} ${10 - 7.5 * Math.cos(fraction * Math.PI * 2)} Z`}
          fill="#6cac83"
        />
      )}
      {fraction === 1 && (
        <>
          <circle cx="10" cy="10" r="7.5" fill="#4caf50" />
          <path d="M6 10l2.5 2.5L14 7" fill="none" stroke="white" strokeWidth="1.7" />
        </>
      )}
    </>,
  )
}
