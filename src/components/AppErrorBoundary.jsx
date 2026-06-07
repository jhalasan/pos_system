import { Component } from 'react'

export default class AppErrorBoundary extends Component {
  state = { error: null }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('App render failed:', error, info)
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          padding: 24,
          background: '#f6f7fb',
          color: '#111827',
        }}>
          <div style={{
            maxWidth: 520,
            padding: 24,
            borderRadius: 16,
            background: '#fff',
            boxShadow: '0 18px 45px rgba(15,23,42,.12)',
          }}>
            <h2 style={{ marginTop: 0 }}>Something broke on this page</h2>
            <p style={{ color: '#4b5563' }}>
              {this.state.error?.message || 'The app hit an unexpected display error.'}
            </p>
            <button
              className="btn btn-primary"
              onClick={() => {
                sessionStorage.removeItem('nexa_admin_auth')
                sessionStorage.removeItem('nexa_admin_user')
                window.location.hash = '/'
                window.location.reload()
              }}
            >
              Back to Role Selection
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
