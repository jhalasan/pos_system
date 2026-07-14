import { useNavigate } from 'react-router-dom'
import { IconShield, IconCart } from '../components/Icons'
import { useAppDialog } from '../../components/AppDialogProvider'

export default function RoleSelect() {
  const dialog = useAppDialog()
  const nav = useNavigate()

  return (
    <div className="auth-wrap">
      <div className="role-screen">
        <div className="brand-mark">N</div>
        <h1>NEXA POS System</h1>
        <p className="tag">Select your role to continue</p>

        <div className="role-grid">
          <div className="role-card">
            <div className="role-icon admin"><IconShield size={28} /></div>
            <h2>Admin</h2>
            <p>Access dashboard, manage inventory, view analytics, and configure system settings.</p>
            <button className="btn btn-primary btn-block" onClick={() => nav('/login')}>
              Login as Admin
            </button>
          </div>

          <div className="role-card">
            <div className="role-icon cashier"><IconCart size={28} /></div>
            <h2>Cashier</h2>
            <p>Process sales, manage transactions, and handle customer payments.</p>
            <button
              className="btn btn-outline btn-block"
              onClick={() => dialog.alert('Use the NEXA POS Cashier application to process sales and payments.', { title: 'Open the cashier app' })}
            >
              Login as Cashier
            </button>
          </div>
        </div>

        <p className="role-foot">Need help? Contact your system administrator.</p>
      </div>
    </div>
  )
}
