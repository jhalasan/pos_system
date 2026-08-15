// Mirrors server/formatters.js's cashierPatchPayload (S5): an update must
// never default an omitted field. The desktop admin app writes staff edits
// straight to PocketBase (src/admin-page/services/desktopApi.js -- it never
// goes through the Express API), so it needs its own payload builder,
// separate from the create-time one used for POST. Reusing the create
// builder for updates too (which defaults status to 'active', hard-codes
// role, and defaults permissions to [], which the rules script treats as
// full legacy access) would mean a name-only edit here silently reactivates
// a terminated account or wipes permissions -- the exact vulnerability
// closed server-side for the web admin's PATCH /api/cashiers/:id (S5). That
// fix only covered the Express code path; this covers the desktop path.
export function cashierUpdatePayload(data = {}) {
  const payload = {}

  if (data.name !== undefined) payload.name = String(data.name || '').trim()
  if (data.email !== undefined) payload.email = String(data.email || '').trim()
  if (data.shift !== undefined) payload.shift = data.shift || 'Morning'
  if (data.status !== undefined) payload.status = data.status
  if (data.permissions !== undefined) payload.permissions = Array.isArray(data.permissions) ? data.permissions : []

  if (data.cashierBarcode !== undefined || data.void_barcode !== undefined) {
    const requestedRole = String(data.role || '').trim() === 'manager' ? 'manager' : 'cashier'
    const barcode = String(data.cashierBarcode || data.void_barcode || '').trim()
    payload.void_barcode = requestedRole === 'manager' && barcode && !barcode.startsWith('92')
      ? `92${barcode}`
      : barcode
  }

  if (String(data.password || '').trim()) {
    payload.password = data.password
    payload.passwordConfirm = data.passwordConfirm || data.password
    if (String(data.oldPassword || '').trim()) payload.oldPassword = data.oldPassword
  }

  // role is intentionally never touched here -- this app models a "manager"
  // as role="cashier" with a 92-prefixed void_barcode, not a distinct role
  // value, so there is no legitimate reason for an update to change it.

  return payload
}
