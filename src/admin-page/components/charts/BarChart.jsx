/* Pure-SVG vertical bar chart. */
export default function BarChart({ data, height = 220, color = '#4f46e5', unit = '' }) {
  const W = 720
  const H = height
  const padX = 16
  const padTop = 16
  const padBottom = 30
  const max = Math.max(...data.map((d) => d.value), 1)
  const plotH = H - padTop - padBottom
  const slot = (W - padX * 2) / data.length
  const barW = Math.min(slot * 0.58, 46)

  const gridLines = 4

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Bar chart">
      {Array.from({ length: gridLines + 1 }).map((_, i) => {
        const y = padTop + (plotH / gridLines) * i
        const val = Math.round((max / gridLines) * (gridLines - i))
        return (
          <g key={i}>
            <line x1={padX} y1={y} x2={W - padX} y2={y} stroke="#eef0f3" strokeWidth="1" />
            <text x={padX} y={y - 4} fontSize="9" fill="#9ca3af">{val.toLocaleString()}</text>
          </g>
        )
      })}
      {data.map((d, i) => {
        const h = (d.value / max) * plotH
        const x = padX + slot * i + (slot - barW) / 2
        const y = padTop + plotH - h
        return (
          <g key={d.label}>
            <rect x={x} y={y} width={barW} height={h} rx="4" fill={color}>
              <title>{d.label}: {d.value.toLocaleString()}{unit}</title>
            </rect>
            <text x={x + barW / 2} y={H - padBottom + 15} fontSize="9.5" fill="#6b7280" textAnchor="middle">
              {d.label}
            </text>
          </g>
        )
      })}
    </svg>
  )
}
