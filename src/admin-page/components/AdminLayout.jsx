import { useEffect, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import Sidebar from './Sidebar'
import { IconBell } from './Icons'

const titles = {
  dashboard: 'Dashboard',
  inventory: 'Inventory',
  products: 'Product Management',
  cashiers: 'Cashier Management',
  analytics: 'Analytics',
  logs: 'Activity Logs',
  settings: 'Settings',
}

export default function AdminLayout() {
  const { pathname } = useLocation()
  const section = pathname.split('/')[2] || 'dashboard'
  const [now, setNow] = useState(new Date())
  const [sidebarOpen, setSidebarOpen] = useState(false)

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  // Close sidebar when route changes
  useEffect(() => {
    setSidebarOpen(false)
  }, [pathname])

  // Close sidebar when clicking on overlay
  const handleOverlayClick = () => {
    setSidebarOpen(false)
  }

  return (
    <div className="admin-shell">
      <Sidebar isOpen={sidebarOpen} onNavigate={() => setSidebarOpen(false)} />
      <div className={`sidebar-overlay ${sidebarOpen ? 'active' : ''}`} onClick={handleOverlayClick} />
      <div className="main">
        <div className="phone-status-bar"></div>
        <header className="topbar">
          <button
            className="mobile-menu-btn"
            onClick={() => setSidebarOpen(!sidebarOpen)}
            title="Toggle menu"
            aria-label="Toggle navigation menu"
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          <div className="crumb">
            Admin <span>/</span> <b>{titles[section] || 'Dashboard'}</b>
          </div>
          <div className="topbar-right">
            <span className="clock">
              {now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
              {' · '}
              {now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
            </span>
            <button className="icon-btn" title="Notifications"><IconBell size={17} /></button>
            <div className="user-chip">
              <div className="av">AD</div>
              <div>
                <div className="un">Administrator</div>
                <div className="ur">System Admin</div>
              </div>
            </div>
          </div>
        </header>

        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
