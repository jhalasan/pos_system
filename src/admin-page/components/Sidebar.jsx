import { useNavigate, useLocation } from 'react-router-dom'
import { logout } from '../auth'
import {
  IconDashboard, IconBox, IconTag, IconUsers, IconChart, IconList,
  IconCloud, IconUserPlus, IconLogout, IconSettings,
} from './Icons'

const navItems = [
  { to: '/admin/dashboard', label: 'Dashboard', icon: IconDashboard },
  { to: '/admin/inventory', label: 'Inventory', icon: IconBox },
  { to: '/admin/products', label: 'Product Management', icon: IconTag },
  { to: '/admin/cashiers', label: 'Cashier Management', icon: IconUsers },
  { to: '/admin/analytics', label: 'Analytics', icon: IconChart },
  { to: '/admin/logs', label: 'Activity Logs', icon: IconList },
  { to: '/admin/settings', label: 'Settings', icon: IconSettings },
]

export default function Sidebar({ isOpen = false, onNavigate = () => {} }) {
  const nav = useNavigate()
  const location = useLocation()

  function handleLogout() {
    logout()
    nav('/', { replace: true })
  }

  const handleNavClick = (to) => {
    nav(to)
    onNavigate()
  }

  const isActive = (to) => location.pathname === to

  return (
    <aside className={`sidebar ${isOpen ? 'active' : ''}`}>
      <div className="sidebar-brand">
        <div className="mk">N</div>
        <div>
          <div className="nm">NEXA POS</div>
          <div className="sb">Admin Control Panel</div>
        </div>
      </div>

      <nav className="nav-section">
        <div className="nav-label">Main Menu</div>
        {navItems.map(({ to, label, icon: Icon }) => (
          <button
            key={to}
            className={`nav-item ${isActive(to) ? 'active' : ''}`}
            onClick={() => handleNavClick(to)}
          >
            <Icon size={18} />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      <div className="sidebar-foot">
        <button
          className="nav-item"
          onClick={() => alert('Syncing local data to the cloud…')}
        >
          <IconCloud size={18} />
          <span>Sync to Cloud</span>
        </button>
        <button 
          className="nav-item"
          onClick={() => handleNavClick('/admin/cashiers')}
        >
          <IconUserPlus size={18} />
          <span>Add Cashier</span>
        </button>
        <button className="nav-item danger" onClick={handleLogout}>
          <IconLogout size={18} />
          <span>Logout</span>
        </button>
      </div>
    </aside>
  )
}
