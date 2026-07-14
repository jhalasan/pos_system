export default function BrandedLoader({ message = 'Loading NEXA POS…' }) {
  return (
    <div className="app-loading" role="status" aria-live="polite">
      <div className="nexa-loader">
        <div className="nexa-loader-ring">
          <img src="/branding/nexa-systems-mark.jpg" alt="" aria-hidden="true" />
        </div>
        <strong>{message}</strong>
        <span>Please wait a moment</span>
      </div>
    </div>
  )
}
