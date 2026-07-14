import { useEffect, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import Sidebar from './Sidebar'
import { IconBell, IconMenu } from './Icons'
import SyncStatusIndicator from '../../components/SyncStatusIndicator'
import { api } from '../services/api'
import SupportContactModal from '../../components/SupportContactModal'
import ConnectionStatusBar from '../../components/ConnectionStatusBar'

const titles = {
  dashboard: 'Dashboard',
  inventory: 'Inventory',
  products: 'Product Management',
  barcodes: 'Barcode Tools',
  cashiers: 'Staff Management',
  analytics: 'Analytics',
  'transaction-logs': 'Transaction Logs',
  receipts: 'Transaction Logs',
  audit: 'Audit',
  logs: 'Activity Logs',
  settings: 'Settings',
}
const isAdminWeb = import.meta.env.VITE_APP_TARGET === 'admin-web'
const dismissedNotificationsKey = 'nexa-admin-dismissed-notifications'

function notificationId(item) {
  return [item.tone, item.title, item.detail].join('|')
}

function readDismissedNotifications() {
  try {
    const value = JSON.parse(localStorage.getItem(dismissedNotificationsKey) || '[]')
    return new Set(Array.isArray(value) ? value : [])
  } catch {
    return new Set()
  }
}

export default function AdminLayout() {
  const { pathname } = useLocation()
  const section = pathname.split('/')[2] || 'dashboard'
  const [now, setNow] = useState(new Date())
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [notifications, setNotifications] = useState([])
  const [supportOpen, setSupportOpen] = useState(false)
  const [showBackToTop, setShowBackToTop] = useState(false)

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    document.body.classList.toggle('admin-menu-open', sidebarOpen)
    return () => document.body.classList.remove('admin-menu-open')
  }, [sidebarOpen])

  useEffect(() => {
    const updateBackToTop = () => setShowBackToTop(window.scrollY > 420)
    updateBackToTop()
    window.addEventListener('scroll', updateBackToTop, { passive: true })
    return () => window.removeEventListener('scroll', updateBackToTop)
  }, [])

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
      const visibleAlerts = alerts.filter((item) => !readDismissedNotifications().has(notificationId(item)))
      setNotifications(visibleAlerts.length ? visibleAlerts.slice(0, 5) : alerts.length ? [] : [{
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

  function clearNotifications() {
    const dismissed = readDismissedNotifications()
    notifications.forEach((item) => dismissed.add(notificationId(item)))
    localStorage.setItem(dismissedNotificationsKey, JSON.stringify([...dismissed].slice(-250)))
    setNotifications([])
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
            <button type="button" className="btn btn-outline btn-sm topbar-support" onClick={() => setSupportOpen(true)}>
              Need help? Contact us
            </button>
            <span className="clock">
              {now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
              {' - '}
              {now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
            </span>
            <ConnectionStatusBar scope="admin" cloudOnly={isAdminWeb} placement="header" />
            <div className="notification-wrap">
              <button className="icon-btn" title="Notifications" onClick={toggleNotifications}>
                <IconBell size={17} />
              </button>
              {notificationsOpen && (
                <div className="notification-panel">
                  <div className="notification-head">
                    <span>Notifications</span>
                    <button type="button" onClick={clearNotifications} disabled={notifications.length === 0}>Clear History</button>
                  </div>
                  {notifications.map((item, index) => (
                    <div className={`notification-item ${item.tone}`} key={`${item.title}-${index}`}>
                      <strong>{item.title}</strong>
                      <span>{item.detail}</span>
                    </div>
                  ))}
                  {notifications.length === 0 && (
                    <div className="notification-item info">
                      <strong>No notifications</strong>
                      <span>History cleared for this session.</span>
                    </div>
                  )}
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
        <ConnectionStatusBar scope="admin" cloudOnly={isAdminWeb} placement="banner" />

        <main className="content">
          <Outlet />
        </main>
      </div>
      {showBackToTop && (
        <button
          type="button"
          className="back-to-top"
          onClick={() => window.scrollTo({
            top: 0,
            behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
          })}
          aria-label="Back to top"
          title="Back to top"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 15 6-6 6 6" /></svg>
          <span>Top</span>
        </button>
      )}
      {!isAdminWeb && <SyncStatusIndicator scope="admin" />}
      <SupportContactModal open={supportOpen} onClose={() => setSupportOpen(false)} source="Admin Control Panel" />
    </div>
  )
}
