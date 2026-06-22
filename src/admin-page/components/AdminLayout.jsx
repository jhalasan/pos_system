import { useEffect, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import Sidebar from './Sidebar'
import { IconBell, IconMenu } from './Icons'
import SyncStatusIndicator from '../../components/SyncStatusIndicator'
import { api } from '../services/api'

const titles = {
  dashboard: 'Dashboard',
  inventory: 'Inventory',
  products: 'Product Management',
  barcodes: 'Barcode Tools',
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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [notifications, setNotifications] = useState([])

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    document.body.classList.toggle('admin-menu-open', sidebarOpen)
    return () => document.body.classList.remove('admin-menu-open')
  }, [sidebarOpen])

  async function toggleNotifications() {
    const nextOpen = !notificationsOpen
    setNotificationsOpen(nextOpen)
    if (!nextOpen) return

    try {
      const [dashboard, activityLogs] = await Promise.all([
        api.dashboard(),
        api.activityLogs(),
      ])
      const eventMeta = {
        Discount: { tone: 'warning', title: 'Discount applied' },
        'Transaction Void': { tone: 'danger', title: 'Voided transaction' },
        'Transaction Refund': { tone: 'warning', title: 'Refund recorded' },
        'Transaction Exchange': { tone: 'warning', title: 'Exchange recorded' },
        Refund: { tone: 'warning', title: 'Refund recorded' },
        Exchange: { tone: 'warning', title: 'Exchange recorded' },
        'Receipt Reprint': { tone: 'info', title: 'Receipt reprinted' },
        'Receipt Lookup': { tone: 'info', title: 'Receipt checked' },
      }
      const recentEvents = activityLogs
        .filter((log) => eventMeta[log.action])
        .slice(0, 5)
      const alerts = [
        ...(dashboard.criticalAlerts || []).map((item) => ({
          tone: 'danger',
          title: item.name,
          detail: `${item.left} item(s) left`,
        })),
        ...((dashboard.topProducts || []).slice(0, 3).map((item) => ({
          tone: 'info',
          title: item.name,
          detail: `${item.units} unit(s) sold`,
        }))),
        ...recentEvents.map((log) => ({
          tone: eventMeta[log.action]?.tone || 'info',
          title: eventMeta[log.action]?.title || log.action,
          detail: `${log.user || 'System'} - ${log.detail || new Date(log.time).toLocaleString()}`,
        })),
      ]
      setNotifications(alerts.length ? alerts : [{
        tone: 'success',
        title: 'All clear',
        detail: 'No critical stock, discount, void, refund, exchange, receipt, or sales alerts right now.',
      }])
    } catch (error) {
      setNotifications([{
        tone: 'danger',
        title: 'Unable to load notifications',
        detail: error.message || 'Please try again.',
      }])
    }
  }

  return (
    <div className={'admin-shell' + (sidebarCollapsed ? ' sidebar-collapsed' : '') + (sidebarOpen ? ' menu-open' : '')}>
      <div
        className={'sidebar-overlay' + (sidebarOpen ? ' active' : '')}
        onClick={() => setSidebarOpen(false)}
      />
      <Sidebar
        open={sidebarOpen}
        collapsed={sidebarCollapsed}
        onNavigate={() => setSidebarOpen(false)}
      />
      <div className="main">
        <header className="topbar">
          <button
            type="button"
            className="desktop-sidebar-btn"
            aria-label={sidebarCollapsed ? 'Expand menu' : 'Collapse menu'}
            title={sidebarCollapsed ? 'Expand menu' : 'Collapse menu'}
            onClick={() => setSidebarCollapsed((value) => !value)}
          >
            <IconMenu size={20} />
          </button>
          <button
            type="button"
            className="mobile-menu-btn"
            aria-label="Open menu"
            onClick={() => setSidebarOpen(true)}
          >
            <IconMenu size={22} />
          </button>
          <div className="crumb">
            Admin <span>/</span> <b>{titles[section] || 'Dashboard'}</b>
          </div>
          <div className="topbar-right">
            <span className="clock">
              {now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
              {' - '}
              {now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
            </span>
            <div className="notification-wrap">
              <button className="icon-btn" title="Notifications" onClick={toggleNotifications}>
                <IconBell size={17} />
              </button>
              {notificationsOpen && (
                <div className="notification-panel">
                  <div className="notification-head">Notifications</div>
                  {notifications.map((item, index) => (
                    <div className={`notification-item ${item.tone}`} key={`${item.title}-${index}`}>
                      <strong>{item.title}</strong>
                      <span>{item.detail}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
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
      <SyncStatusIndicator scope="admin" />
    </div>
  )
}
