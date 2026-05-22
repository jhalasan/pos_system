/* Pure-SVG line/area chart with smooth curve. */
export default function LineChart({ data, height = 220, color = '#4f46e5' }) {
  const W = 720
  const H = height
  const padX = 34
  const padTop = 16
  const padBottom = 28
  const max = Math.max(...data.map((d) => d.value), 1)
  const min = Math.min(...data.map((d) => d.value), 0)
  const span = max - min || 1
  const plotH = H - padTop - padBottom
  const plotW = W - padX * 2
  const step = plotW / (data.length - 1 || 1)

  const pts = data.map((d, i) => ({
    x: padX + step * i,
    y: padTop + plotH - ((d.value - min) / span) * plotH,
  }))

  const linePath = pts
    .map((p, i) => {
      if (i === 0) return `M ${p.x} ${p.y}`
      const prev = pts[i - 1]
      const cx = (prev.x + p.x) / 2
      return `C ${cx} ${prev.y}, ${cx} ${p.y}, ${p.x} ${p.y}`
    })
    .join(' ')

  const areaPath = `${linePath} L ${pts[pts.length - 1].x} ${padTop + plotH} L ${pts[0].x} ${padTop + plotH} Z`

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Line chart">
      <defs>
        <linearGradient id="lc-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0, 1, 2, 3].map((i) => {
        const y = padTop + (plotH / 3) * i
        return <line key={i} x1={padX} y1={y} x2={W - padX} y2={y} stroke="#eef0f3" strokeWidth="1" />
      })}
      <path d={areaPath} fill="url(#lc-fill)" />
      <path d={linePath} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" />
      {pts.map((p, i) => (
        <g key={i}>
          <circle cx={p.x} cy={p.y} r="3.5" fill="#fff" stroke={color} strokeWidth="2">
            <title>{data[i].label}: {data[i].value.toLocaleString()}</title>
          </circle>
          <text x={p.x} y={H - 9} fontSize="9.5" fill="#6b7280" textAnchor="middle">
            {data[i].label}
          </text>
        </g>
      ))}
    </svg>
  )
}
