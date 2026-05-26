import { NavLink, useNavigate } from 'react-router-dom'
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

export default function Sidebar({ open = false, onNavigate = () => {} }) {
  const nav = useNavigate()

  function handleLogout() {
    logout()
    nav('/', { replace: true })
  }

  return (
    <aside className={'sidebar' + (open ? ' active' : '')}>
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
          <NavLink
            key={to}
            to={to}
            onClick={onNavigate}
            className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}
          >
            <Icon size={18} />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="sidebar-foot">
        <button
          className="nav-item"
          style={{ width: '100%' }}
          onClick={() => alert('Syncing local data to the cloud...')}
        >
          <IconCloud size={18} />
          <span>Sync to Cloud</span>
        </button>
        <NavLink to="/admin/cashiers" className="nav-item" onClick={onNavigate}>
          <IconUserPlus size={18} />
          <span>Add Cashier</span>
        </NavLink>
        <button className="nav-item danger" style={{ width: '100%' }} onClick={handleLogout}>
          <IconLogout size={18} />
          <span>Logout</span>
        </button>
      </div>
    </aside>
  )
}
