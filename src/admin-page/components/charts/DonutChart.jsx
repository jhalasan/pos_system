/* Pure-SVG donut chart — no charting library needed. */
export default function DonutChart({ data, centerLabel = 'Total Units', size = 168 }) {
  const total = data.reduce((s, d) => s + d.value, 0)
  const r = 58
  const cx = 70
  const cy = 70
  const circ = 2 * Math.PI * r

  let offset = 0
  const segments = data.map((d) => {
    const frac = total ? d.value / total : 0
    const seg = {
      color: d.color,
      dash: frac * circ,
      gap: circ - frac * circ,
      rotation: (offset / circ) * 360,
    }
    offset += frac * circ
    return seg
  })

  return (
    <div className="donut-wrap">
      <svg width={size} height={size} viewBox="0 0 140 140">
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="#eef0f3" strokeWidth="18" />
        {segments.map((s, i) => (
          <circle
            key={i}
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke={s.color}
            strokeWidth="18"
            strokeDasharray={`${s.dash} ${s.gap}`}
            strokeLinecap="butt"
            transform={`rotate(${s.rotation - 90} ${cx} ${cy})`}
          />
        ))}
        <text x={cx} y={cy - 2} textAnchor="middle" className="donut-center-val">
          {total.toLocaleString()}
        </text>
        <text x={cx} y={cy + 14} textAnchor="middle" className="donut-center-lbl">
          {centerLabel.toUpperCase()}
        </text>
      </svg>

      <div className="chart-legend">
        {data.map((d) => (
          <div className="legend-row" key={d.label}>
            <span className="legend-dot" style={{ background: d.color }} />
            <span>{d.label}</span>
            <span className="lv">{d.value.toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
