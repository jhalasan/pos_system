export default function StatCard({ label, value, icon: Icon, tone = 'indigo', foot, trend }) {
  return (
    <div className="stat-card">
      <div className="stat-top">
        <span className="stat-label">{label}</span>
        <span className={`stat-icon ic-${tone}`}>
          {Icon && <Icon size={19} />}
        </span>
      </div>
      <div className="stat-value">{value}</div>
      {(foot || trend != null) && (
        <div className="stat-foot">
          {trend != null && (
            <span className={trend >= 0 ? 'trend-up' : 'trend-down'}>
              {trend >= 0 ? '▲' : '▼'} {Math.abs(trend)}%
            </span>
          )}
          {foot && <span>{foot}</span>}
        </div>
      )}
    </div>
  )
}
