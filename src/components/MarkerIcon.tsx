import type { MarkerCategory } from '../domain/types'
export const flagColors: Record<string, string> = {
  red: '#dc665b',
  orange: '#d9a043',
  blue: '#5897c7',
  green: '#5a9a78',
  purple: '#9c7eb5',
  teal: '#59a5a3',
  gray: '#99a4ab',
}
export function MarkerIcon({
  category,
  value,
  x = 0,
  y = 0,
}: {
  category: MarkerCategory
  value: string
  x?: number
  y?: number
}) {
  if (category === 'flag')
    return (
      <svg x={x} y={y} width="19" height="19" viewBox="0 0 20 20" aria-hidden="true">
        <path d="M5 3V18" stroke={flagColors[value]} strokeWidth="1.7" />
        <path d="M6 3L18 7.5L6 12Z" fill={flagColors[value]} />
      </svg>
    )
  if (category === 'priority')
    return (
      <svg x={x} y={y} width="19" height="19" viewBox="0 0 20 20" aria-hidden="true">
        <text x="10" y="15.5" textAnchor="middle" fill="#c9814d" fontSize="19">
          {value}
        </text>
      </svg>
    )
  const fraction = value === 'done' ? 1 : value === 'start' ? 0 : Number(value.split('/')[0]) / 8
  return (
    <svg x={x} y={y} width="19" height="19" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="7.5" fill="white" stroke="#5c9f76" strokeWidth="1.5" />
      {fraction > 0 && fraction < 1 && (
        <path
          d={`M10 10 L10 2.5 A7.5 7.5 0 ${fraction > 0.5 ? 1 : 0} 1 ${10 + 7.5 * Math.sin(fraction * Math.PI * 2)} ${10 - 7.5 * Math.cos(fraction * Math.PI * 2)} Z`}
          fill="#6cac83"
        />
      )}
      {fraction === 1 && (
        <>
          <circle cx="10" cy="10" r="7.5" fill="#5c9f76" />
          <path d="M6 10l2.5 2.5L14 7" fill="none" stroke="white" strokeWidth="1.7" />
        </>
      )}
    </svg>
  )
}
