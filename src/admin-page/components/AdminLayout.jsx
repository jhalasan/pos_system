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

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  return (
    <div className="admin-shell">
      <Sidebar />
      <div className="main">
        <header className="topbar">
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
